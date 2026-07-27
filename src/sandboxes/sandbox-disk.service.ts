import { Inject, Injectable, Logger, forwardRef, OnModuleInit } from '@nestjs/common';
import { SandboxRepository } from '../repositories/sandbox.repository';
import { SandboxesService } from './sandboxes.service';
import { ModuleConfig } from '../config/config.types';
import { CONFIG } from '../config/config.loader';
import {
  RUNTIME_PROVIDER,
  RuntimeProvider,
} from '../runtime/runtime-provider.interface';

// Fallbacks for `maintenance.*` when the deployment does not set them.
const DEFAULT_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_MIN_INTERVAL_MS = 5_000;

/**
 * Watches how much disk each sandbox writes and stops the ones that run away.
 *
 * Nothing else measures this: `resourceLimits.maxTotalDiskBytes` only covers
 * stored snapshots, so the container's writable layer — where a `pip install`
 * or a model download actually lands — grew unobserved and unbounded. A single
 * sandbox could fill the host and take every other service on it down.
 *
 * The cap is reactive by necessity. A kernel-enforced quota needs
 * `--storage-opt size=`, which Docker only honors on overlay2 over XFS mounted
 * with `pquota`; on ext4 the daemon refuses it. So usage is sampled on an
 * interval and a sandbox can overshoot between two samples — the point is to
 * bound the damage, not to make overshoot impossible.
 */
@Injectable()
export class SandboxDiskService implements OnModuleInit {
  private readonly logger = new Logger(SandboxDiskService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly sandboxRepo: SandboxRepository,
    @Inject(CONFIG) private readonly config: ModuleConfig,
    @Inject(RUNTIME_PROVIDER) private readonly runtime: RuntimeProvider,
    @Inject(forwardRef(() => SandboxesService))
    private readonly sandboxesService: SandboxesService,
  ) {}

  onModuleInit(): void {
    if (!this.isEnabled()) {
      this.logger.log(
        'Per-sandbox disk accounting is off (no warn/limit configured)',
      );
      return;
    }
    // Floored so a zero or a typo in config cannot turn the sampler into a
    // busy loop against the Docker daemon.
    const interval = Math.max(
      this.config.maintenance?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
      this.config.maintenance?.sandboxDiskCheckIntervalMs ??
        DEFAULT_CHECK_INTERVAL_MS,
    );
    this.timer = setInterval(() => {
      void this.checkDiskUsage();
    }, interval);
    this.logger.log(
      `Per-sandbox disk accounting every ${interval}ms ` +
        `(warn=${this.warnBytes ?? '-'}, limit=${this.limitBytes ?? '-'})`,
    );
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private get warnBytes(): number | undefined {
    const v = this.config.resourceLimits?.warnSandboxDiskBytes;
    return v && v > 0 ? v : undefined;
  }

  private get limitBytes(): number | undefined {
    const v = this.config.resourceLimits?.maxSandboxDiskBytes;
    return v && v > 0 ? v : undefined;
  }

  private isEnabled(): boolean {
    return (
      !!this.runtime.listManaged && (!!this.warnBytes || !!this.limitBytes)
    );
  }

  /**
   * Sample every sandbox, record what it is using, and stop the ones over the
   * cap. Public so it can be driven from a test or an operator endpoint.
   */
  async checkDiskUsage(): Promise<void> {
    if (!this.isEnabled()) return;
    if (this.running) return;
    this.running = true;

    try {
      const managed = await this.runtime.listManaged!({ withSize: true });
      if (managed.length === 0) return;

      const byName = new Map(
        managed
          .filter((c) => typeof c.sizeRwBytes === 'number')
          .map((c) => [c.name, c.sizeRwBytes as number]),
      );
      if (byName.size === 0) return;

      const live = await this.sandboxRepo.findRunning();
      const limit = this.limitBytes;
      const warn = this.warnBytes;

      for (const doc of live) {
        const bytes = byName.get(doc.name);
        if (bytes === undefined) continue;

        await this.sandboxRepo
          .updateById(
            (doc as any)._id.toString(),
            { $set: { diskBytes: bytes, diskCheckedAt: new Date() } },
            {},
          )
          .catch(() => undefined);

        if (limit && bytes >= limit) {
          await this.stopOverLimit(doc.sandboxId, bytes, limit);
          continue;
        }
        if (warn && bytes >= warn) {
          this.logger.warn(
            `Sandbox ${doc.sandboxId} has written ${fmt(bytes)} ` +
              `(warning threshold ${fmt(warn)})`,
          );
        }
      }
    } catch (err) {
      this.logger.error(`Disk check failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async stopOverLimit(
    sandboxId: string,
    bytes: number,
    limit: number,
  ): Promise<void> {
    this.logger.warn(
      `Stopping sandbox ${sandboxId}: wrote ${fmt(bytes)}, over the ` +
        `${fmt(limit)} per-sandbox cap`,
    );
    try {
      // Goes through the regular stop so the sandbox is persisted to its
      // snapshot, unpublished from ingress and left in a coherent state —
      // the owner gets a stopped sandbox with a reason, not a vanished one.
      await this.sandboxesService.stop(sandboxId, {}, 'disk-limit');
    } catch (err) {
      this.logger.error(
        `Could not stop over-limit sandbox ${sandboxId}: ${(err as Error).message}`,
      );
    }
  }

  /** Total bytes written across sandboxes that are still running. */
  async getTotalSandboxDiskBytes(): Promise<number> {
    const live = await this.sandboxRepo.findRunning();
    return live.reduce((sum, d) => sum + (d.diskBytes ?? 0), 0);
  }
}

function fmt(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(0)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}
