import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG } from '../config/config.loader';
import { ModuleConfig } from '../config/config.types';
import { SnapshotRepository } from '../repositories/snapshot.repository';
import { SnapshotDocument, SnapshotStatus } from '../schemas/snapshot.schema';
import { IngressRegistry } from './ingress-registry';

const DEFAULT_TTL_SECONDS = 1800;
const DEFAULT_CLAIM_SECONDS = 300;
const DEFAULT_TIMEOUT_SECONDS = 120;
/** How long an error is shown to visitors before a retry may claim again. */
const ERROR_TTL_SECONDS = 30;

/**
 * Restores a snapshot when someone visits its public URL and nothing is
 * serving it.
 *
 * Why a restore and not a container restart: `stop` leaves the container
 * `Exited`, but `sweepOrphanedContainers` removes it within minutes, and TTL
 * expiry removes it outright. There is no state to resume by the time most
 * visits arrive, so the only reliable path is the one that already exists —
 * restore the snapshot into a fresh sandbox. With the image cache that costs
 * about two seconds.
 *
 * `SnapshotsService` supplies the actual restore through `registerRestorer` at
 * module init rather than being injected, because it already depends on
 * `IngressService` and injecting it back would close a cycle. Same trick as
 * `SnapshotImageService.registerTarballApplier`.
 */
export type SnapshotRestorer = (
  snapshotId: string,
  ttlSeconds: number,
) => Promise<{ sandboxId: string }>;

export type WakeOutcome =
  | { kind: 'waking'; snapshot: SnapshotDocument }
  | { kind: 'already-waking'; snapshot: SnapshotDocument }
  | { kind: 'disabled'; snapshot: SnapshotDocument }
  | { kind: 'unknown' };

export interface WakeStatus {
  state: 'ready' | 'starting' | 'error' | 'idle';
  message?: string;
  /** Seconds since the wake-up began, when one is in flight. */
  elapsedSeconds?: number;
}

@Injectable()
export class SandboxWakeupService {
  private readonly logger = new Logger(SandboxWakeupService.name);
  private restorer: SnapshotRestorer | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: ModuleConfig,
    private readonly registry: IngressRegistry,
    private readonly snapshotRepo: SnapshotRepository,
  ) {}

  registerRestorer(fn: SnapshotRestorer): void {
    this.restorer = fn;
  }

  isEnabled(): boolean {
    return this.config.ingress?.autoRestart !== false;
  }

  get timeoutSeconds(): number {
    return (
      this.config.ingress?.autoRestartTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
    );
  }

  private get ttlSeconds(): number {
    return this.config.ingress?.autoRestartTtlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  private get claimSeconds(): number {
    return this.config.ingress?.autoRestartClaimSeconds ?? DEFAULT_CLAIM_SECONDS;
  }

  /**
   * Begin waking whatever snapshot answers to `subdomain`, if anything does.
   *
   * Returns without restoring when the subdomain belongs to nothing, when the
   * snapshot opted out, or when another visitor already claimed the wake-up —
   * all three are normal and the caller renders a page accordingly.
   */
  async wake(subdomain: string): Promise<WakeOutcome> {
    if (!this.isEnabled()) return { kind: 'unknown' };

    const snapshot = await this.snapshotRepo
      .findBySubdomain(subdomain)
      .catch((err) => {
        this.logger.warn(
          `Snapshot lookup failed for ${subdomain}: ${(err as Error).message}`,
        );
        return null;
      });
    if (!snapshot) return { kind: 'unknown' };

    if (snapshot.autoRestart === false) return { kind: 'disabled', snapshot };

    // A snapshot mid-creation has no complete artifact yet; a failed one has
    // nothing worth restoring. Both read as "no such site" to a visitor.
    if (snapshot.status !== SnapshotStatus.READY) return { kind: 'unknown' };

    if (!this.restorer) {
      this.logger.warn('No restorer registered; cannot wake sandboxes');
      return { kind: 'unknown' };
    }

    const won = await this.registry.claimWakeup(
      subdomain,
      snapshot.snapshotId,
      this.claimSeconds,
    );
    if (!won) return { kind: 'already-waking', snapshot };

    // Fire and forget: the visitor is already being served a waiting page, and
    // holding the request open would hit the edge proxy's own timeout.
    void this.runRestore(subdomain, snapshot);
    return { kind: 'waking', snapshot };
  }

  private async runRestore(
    subdomain: string,
    snapshot: SnapshotDocument,
  ): Promise<void> {
    const started = Date.now();
    try {
      const { sandboxId } = await this.restorer!(
        snapshot.snapshotId,
        this.ttlSeconds,
      );
      this.logger.log(
        `Woke ${subdomain} → sandbox ${sandboxId} from snapshot ` +
          `${snapshot.snapshotId} (${Math.round((Date.now() - started) / 1000)}s)`,
      );
      // The restore published the sandbox, so the registry now answers for this
      // subdomain and the claim has done its job. Dropping it lets a later stop
      // be followed by a fresh wake-up.
      await this.registry.clearWakeup(subdomain).catch(() => undefined);
    } catch (err) {
      const message = (err as Error).message ?? 'restore failed';
      this.logger.warn(`Waking ${subdomain} failed: ${message}`);
      await this.registry
        .failWakeup(subdomain, snapshot.snapshotId, message, ERROR_TTL_SECONDS)
        .catch(() => undefined);
    }
  }

  /**
   * What the waiting page should do next. `ready` is decided by the routing
   * registry rather than by our own bookkeeping: the sandbox is reachable
   * exactly when the proxy can route to it.
   */
  async status(subdomain: string): Promise<WakeStatus> {
    const entry = await this.registry.lookup(subdomain).catch(() => null);
    if (entry) return { state: 'ready' };

    const wakeup = await this.registry.getWakeup(subdomain).catch(() => null);
    if (!wakeup) return { state: 'idle' };
    if (wakeup.state === 'error') {
      return { state: 'error', message: wakeup.message };
    }
    return {
      state: 'starting',
      elapsedSeconds: Math.max(
        0,
        Math.round((Date.now() - new Date(wakeup.startedAt).getTime()) / 1000),
      ),
    };
  }
}
