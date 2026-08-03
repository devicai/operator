import { Inject, Injectable, Logger } from '@nestjs/common';
import * as net from 'net';
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
/** Budget for the "is anything listening yet?" probe. Runs on every poll. */
const PROBE_TIMEOUT_MS = 1000;
/**
 * How long a wake-up waits for a save into the snapshot to finish. Generous on
 * purpose: a full capture of a multi-gigabyte snapshot runs for minutes, and
 * giving up means telling a visitor the site is broken when it is merely busy.
 */
const SAVE_WAIT_BUDGET_MS = 10 * 60 * 1000;
const SAVE_POLL_INTERVAL_MS = 3000;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether a restore was refused because a save into the snapshot is running.
 * Nest wraps the thrown payload, so the code can sit at either level.
 */
function isSaveInProgress(err: unknown): boolean {
  const res = (err as { response?: unknown; code?: unknown })?.response;
  const code =
    (res as { code?: unknown })?.code ?? (err as { code?: unknown })?.code;
  return code === 'SNAPSHOT_SAVE_IN_PROGRESS';
}

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
  /**
   * Whether a sandbox is published on this subdomain. It is the difference
   * between "running but nothing listening" and "never came up", which are
   * different problems with different fixes — and the page can only tell them
   * apart if it is told.
   */
  routed?: boolean;
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
    const startedAt = new Date(started).toISOString();

    for (;;) {
      try {
        const { sandboxId } = await this.restorer!(
          snapshot.snapshotId,
          this.ttlSeconds,
        );
        this.logger.log(
          `Woke ${subdomain} → sandbox ${sandboxId} from snapshot ` +
            `${snapshot.snapshotId} (${Math.round((Date.now() - started) / 1000)}s)`,
        );
        // The restore published the sandbox, so the registry now answers for
        // this subdomain and the claim has done its job. Dropping it lets a
        // later stop be followed by a fresh wake-up.
        await this.registry.clearWakeup(subdomain).catch(() => undefined);
        return;
      } catch (err) {
        const message = (err as Error).message ?? 'restore failed';
        const waited = Date.now() - started;

        // A save in progress is the normal aftermath of the previous session
        // expiring: it is writing back exactly the state this visitor is about
        // to ask for. Restoring with force would serve the version before it
        // and then overwrite the save with that older filesystem — losing the
        // very writes the save exists to keep. So wait for it.
        if (isSaveInProgress(err) && waited < SAVE_WAIT_BUDGET_MS) {
          await this.registry
            .noteWakeupWaiting(
              subdomain,
              snapshot.snapshotId,
              startedAt,
              'Saving the previous session before it can be restored.',
              this.claimSeconds,
            )
            .catch(() => undefined);
          this.logger.debug?.(
            `Waking ${subdomain}: waiting for the save into ` +
              `${snapshot.snapshotId} to finish (${Math.round(waited / 1000)}s)`,
          );
          await delay(SAVE_POLL_INTERVAL_MS);
          continue;
        }

        this.logger.warn(`Waking ${subdomain} failed: ${message}`);
        await this.registry
          .failWakeup(subdomain, snapshot.snapshotId, message, ERROR_TTL_SECONDS)
          .catch(() => undefined);
        return;
      }
    }
  }

  /**
   * What the waiting page should do next.
   *
   * `ready` means a TCP connection to the upstream succeeds — NOT merely that a
   * route exists. The route is written the moment the sandbox is published,
   * which happens well before anything inside it listens; reporting ready then
   * makes the page reload straight into a 502. Since a snapshot restores files
   * and not processes, that gap is the normal case rather than a race.
   */
  async status(subdomain: string): Promise<WakeStatus> {
    const entry = await this.registry.lookup(subdomain).catch(() => null);
    if (entry) {
      const answering = await this.isAnswering(
        entry.upstreamHost,
        entry.upstreamPort,
      );
      if (answering) return { state: 'ready' };
      // Routed but silent: keep waiting. Someone may still start the service,
      // and the page reloads as soon as they do.
    }

    const routed = Boolean(entry);
    const wakeup = await this.registry.getWakeup(subdomain).catch(() => null);
    if (!wakeup) {
      // No route answering and no wake-up recorded. When a sandbox IS routed
      // the visitor is simply waiting on a service that has not come up, which
      // reads as 'starting' — the page's own timeout ends the wait.
      return entry ? { state: 'starting', routed } : { state: 'idle', routed };
    }
    if (wakeup.state === 'error') {
      return { state: 'error', message: wakeup.message, routed };
    }
    return {
      state: 'starting',
      // Set while waiting on something specific, e.g. a save that has to finish
      // first. A wait with a reason reads as progress; a bare spinner past the
      // usual couple of seconds reads as broken.
      message: wakeup.message,
      routed,
      elapsedSeconds: Math.max(
        0,
        Math.round((Date.now() - new Date(wakeup.startedAt).getTime()) / 1000),
      ),
    };
  }

  /** Whether anything accepts a TCP connection on the sandbox's HTTP port. */
  private isAnswering(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect({ host, port });
      const done = (result: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(PROBE_TIMEOUT_MS);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
  }
}
