import { Injectable, Inject, Logger, forwardRef } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { SandboxRepository } from '../repositories/sandbox.repository';
import { SandboxRegistry } from './sandbox-registry';
import { SnapshotsService } from '../snapshots/snapshots.service';
import { ModuleConfig } from '../config/config.types';
import { CONFIG } from '../config/config.loader';
import {
  RUNTIME_PROVIDER,
  RuntimeProvider,
} from '../runtime/runtime-provider.interface';

/** How often the runtime is reconciled against the database. */
const CONTAINER_SWEEP_INTERVAL_MS = 300_000;

/**
 * A container younger than this is never swept, so an in-flight create is
 * safe even if its document has not been written yet.
 */
const CONTAINER_SWEEP_GRACE_MS = 600_000;

@Injectable()
export class SandboxTtlService {
  private readonly logger = new Logger(SandboxTtlService.name);
  private running = false;
  private sweeping = false;

  constructor(
    private readonly sandboxRepo: SandboxRepository,
    private readonly registry: SandboxRegistry,
    @Inject(CONFIG) private readonly config: ModuleConfig,
    @Inject(forwardRef(() => SnapshotsService))
    private readonly snapshotsService: SnapshotsService,
    @Inject(RUNTIME_PROVIDER) private readonly runtime: RuntimeProvider,
  ) {}

  @Interval(30000)
  async checkExpiredSandboxes(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const expired = await this.sandboxRepo.findExpired();
      if (expired.length === 0) return;

      this.logger.log(`Found ${expired.length} expired sandbox(es)`);

      for (const doc of expired) {
        const claimed = await this.sandboxRepo.atomicExpire(
          (doc as any)._id.toString(),
        );
        if (!claimed) continue;

        if (doc.snapshotId) {
          await this.snapshotsService.persistToSnapshot(doc);
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
  @Interval(CONTAINER_SWEEP_INTERVAL_MS)
  async sweepOrphanedContainers(): Promise<void> {
    if (!this.runtime.listManaged) return;
    if (this.sweeping) return;
    this.sweeping = true;

    try {
      const managed = await this.runtime.listManaged();
      if (managed.length === 0) return;

      const liveNames = await this.sandboxRepo.findLiveContainerNames();
      const live = new Set(liveNames);
      const cutoff = Date.now() - CONTAINER_SWEEP_GRACE_MS;

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
