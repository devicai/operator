import {
  Injectable,
  Inject,
  Logger,
  Optional,
  forwardRef,
  OnModuleInit,
  OnApplicationShutdown,
} from '@nestjs/common';
import { SandboxRepository } from '../repositories/sandbox.repository';
import { SandboxRegistry } from './sandbox-registry';
import { IngressService } from '../ingress/ingress.service';
import { SnapshotsService } from '../snapshots/snapshots.service';
import { ModuleConfig } from '../config/config.types';
import { CONFIG } from '../config/config.loader';
import {
  RUNTIME_PROVIDER,
  RuntimeProvider,
} from '../runtime/runtime-provider.interface';

// Fallbacks for `maintenance.*` (and `defaults.ttlCheckIntervalMs`) when the
// deployment does not set them. Every one is overridable from config.yml.
const DEFAULT_TTL_CHECK_INTERVAL_MS = 30_000;
const DEFAULT_CONTAINER_SWEEP_INTERVAL_MS = 300_000;
const DEFAULT_CONTAINER_SWEEP_GRACE_MS = 600_000;
const DEFAULT_MIN_INTERVAL_MS = 5_000;

@Injectable()
export class SandboxTtlService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(SandboxTtlService.name);
  private running = false;
  private sweeping = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly sandboxRepo: SandboxRepository,
    private readonly registry: SandboxRegistry,
    @Inject(CONFIG) private readonly config: ModuleConfig,
    @Inject(forwardRef(() => SnapshotsService))
    private readonly snapshotsService: SnapshotsService,
    @Inject(RUNTIME_PROVIDER) private readonly runtime: RuntimeProvider,
    @Optional() private readonly ingressService?: IngressService,
  ) {}

  onModuleInit(): void {
    // Scheduled here rather than with @Interval so the cadence comes from
    // config: a decorator argument is fixed at class-definition time, which is
    // how `defaults.ttlCheckIntervalMs` ended up documented but ignored.
    const ttlInterval = this.intervalMs(
      this.config.defaults?.ttlCheckIntervalMs,
      DEFAULT_TTL_CHECK_INTERVAL_MS,
    );
    const sweepInterval = this.intervalMs(
      this.config.maintenance?.containerSweepIntervalMs,
      DEFAULT_CONTAINER_SWEEP_INTERVAL_MS,
    );

    this.timers.push(
      setInterval(() => void this.checkExpiredSandboxes(), ttlInterval),
      setInterval(() => void this.sweepOrphanedContainers(), sweepInterval),
    );

    this.logger.log(
      `TTL reap every ${ttlInterval}ms, container sweep every ` +
        `${sweepInterval}ms (grace ${this.sweepGraceMs}ms)`,
    );
  }

  onApplicationShutdown(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  /** Config value, floored so a zero or a typo cannot become a busy loop. */
  private intervalMs(configured: number | undefined, fallback: number): number {
    const floor =
      this.config.maintenance?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    return Math.max(floor, configured ?? fallback);
  }

  private get sweepGraceMs(): number {
    return (
      this.config.maintenance?.containerSweepGraceMs ??
      DEFAULT_CONTAINER_SWEEP_GRACE_MS
    );
  }

  async checkExpiredSandboxes(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const expired = await this.sandboxRepo.findExpired();
      if (expired.length === 0) return;

      this.logger.log(`Found ${expired.length} expired sandbox(es)`);

      for (const doc of expired) {
        // Something is already capturing this filesystem (an async stop, a
        // create). Leave it alone: expiring it here would remove the container
        // out from under the tar. It reappears next tick, once the flag clears.
        if (doc.savingSnapshotId) {
          this.logger.log(
            `Sandbox ${doc.sandboxId} expired but a snapshot save is in ` +
              `flight; deferring reap`,
          );
          continue;
        }

        const claimed = await this.sandboxRepo.atomicExpire(
          (doc as any)._id.toString(),
        );
        if (!claimed) continue;

        if (doc.snapshotId) {
          // Expiry saves too: a session that runs out of time keeps whatever
          // it did, same as one closed on purpose.
          const outcome = await this.snapshotsService.persistToSnapshot(doc);
          if (outcome !== 'saved') {
            this.logger.warn(
              `Expiry save for ${doc.sandboxId} into ${doc.snapshotId}: ${outcome}`,
            );
          }
        }

        try {
          // `doc.name` is the container name — the document is the source of
          // truth. The Redis registry is a cache whose key lives only
          // `ttl + 60s`, so a reap that arrives late (process restart, a big
          // batch) used to find nothing there and leave the container running
          // forever, while the document was already marked expired and never
          // revisited.
          //
          // Remove rather than stop: an expired sandbox cannot be resumed —
          // there is no start/resume endpoint — so a stopped container is dead
          // weight that keeps holding its writable layer.
          await this.runtime.remove(doc.name);
        } catch (err) {
          this.logger.warn(
            `Error removing expired sandbox ${doc.sandboxId}: ${(err as Error).message}`,
          );
        }

        await this.registry.remove(doc.sandboxId);

        // Drop the public route too. `stop` and `destroy` have always done
        // this; expiry never did, so the subdomain kept pointing at an address
        // nobody answers on until the Redis key aged out on its own — up to a
        // minute of 502s. With auto-restart that gap matters more than it used
        // to: the proxy can only offer to wake a sandbox when it finds NO
        // route, so a stale one means the visitor gets a gateway error instead
        // of the waiting page.
        if (this.ingressService?.isEnabled()) {
          await this.ingressService
            .unpublish(doc)
            .catch((err) =>
              this.logger.warn(
                `Could not unpublish expired sandbox ${doc.sandboxId}: ${(err as Error).message}`,
              ),
            );
        }

        this.logger.log(`Sandbox ${doc.sandboxId} expired and removed`);
      }

      // After reaping expired sandboxes, reclaim any per-sandbox networks that
      // were orphaned by sandboxes which no longer exist, so the daemon's
      // address pool does not exhaust and block new sandbox creation.
      await this.runtime.sweepOrphanedNetworks?.().catch((err) => {
        this.logger.warn(
          `Network sweep after TTL reap failed: ${(err as Error).message}`,
        );
      });
    } catch (err) {
      this.logger.error(`TTL check error: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Reconcile the runtime against the database: remove every managed container
   * whose sandbox is gone or in a terminal state.
   *
   * The reaper above handles the normal path, but containers still escape it —
   * a `remove` that failed, a teardown interrupted by a restart, a container
   * created out-of-band. Nothing revisits them: a document that is already
   * `expired`/`stopped`/`failed` never comes back through `findExpired()`, so
   * without this sweep the container holds its writable layer indefinitely.
   *
   * Runs on its own slower interval — it lists the whole daemon, which is not
   * something to do every 30 seconds.
   */
  async sweepOrphanedContainers(): Promise<void> {
    if (!this.runtime.listManaged) return;
    if (this.sweeping) return;
    this.sweeping = true;

    try {
      const managed = await this.runtime.listManaged();
      if (managed.length === 0) return;

      const liveNames = await this.sandboxRepo.findLiveContainerNames();
      const live = new Set(liveNames);
      const cutoff = Date.now() - this.sweepGraceMs;

      let removed = 0;
      for (const container of managed) {
        if (live.has(container.name)) continue;
        // Protect an in-flight create: the document exists before the
        // container does, but a container whose document has not landed yet
        // (or a `sandbox-*` created by hand seconds ago) deserves the benefit
        // of the doubt.
        if (container.createdAtMs && container.createdAtMs > cutoff) continue;

        try {
          await this.runtime.remove(container.name);
          removed++;
        } catch (err) {
          this.logger.warn(
            `Could not reclaim orphaned container ${container.name}: ${(err as Error).message}`,
          );
        }
      }

      if (removed > 0) {
        this.logger.log(
          `Reclaimed ${removed} orphaned sandbox container(s) of ${managed.length} managed`,
        );
      }
    } catch (err) {
      this.logger.error(`Container sweep error: ${(err as Error).message}`);
    } finally {
      this.sweeping = false;
    }
  }
}
