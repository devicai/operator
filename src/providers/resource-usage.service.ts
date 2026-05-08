import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { promises as fsp } from 'fs';
import { CONFIG } from '../config/config.loader';
import { ModuleConfig } from '../config/config.types';
import { Sandbox, SandboxDocument, SandboxStatus } from '../schemas/sandbox.schema';
import { Snapshot, SnapshotDocument, SnapshotStatus } from '../schemas/snapshot.schema';

/**
 * Hot pool memory accountant. The hot pool service registers itself here at
 * boot so the resource usage service can deduct unfilled hot slots from the
 * available capacity when checking new on-demand sandboxes — without dragging
 * the hot pool module into a circular import.
 */
export interface HotPoolMemoryAccountant {
  getReservedMemoryOverhead(): Promise<number>;
}

const ACTIVE_SANDBOX_STATUSES: SandboxStatus[] = [
  SandboxStatus.PENDING,
  SandboxStatus.CREATING,
  SandboxStatus.RUNNING,
  SandboxStatus.STOPPING,
];

@Injectable()
export class ResourceUsageService {
  private readonly logger = new Logger(ResourceUsageService.name);
  private hotAccountant: HotPoolMemoryAccountant | null = null;

  constructor(
    @InjectModel(Sandbox.name)
    private readonly sandboxModel: Model<SandboxDocument>,
    @InjectModel(Snapshot.name)
    private readonly snapshotModel: Model<SnapshotDocument>,
    @Inject(CONFIG) private readonly config: ModuleConfig,
  ) {}

  /** Wire the hot pool accountant after construction to avoid a cycle. */
  registerHotAccountant(accountant: HotPoolMemoryAccountant): void {
    this.hotAccountant = accountant;
  }

  async getTotalMemoryMib(): Promise<number> {
    const result = await this.sandboxModel.aggregate<{ total: number }>([
      { $match: { status: { $in: ACTIVE_SANDBOX_STATUSES } } },
      { $group: { _id: null, total: { $sum: '$memoryMib' } } },
    ]);
    return result[0]?.total ?? 0;
  }

  /**
   * Returns the *real* on-disk usage of all snapshot tarballs by stat'ing each
   * file referenced by a Snapshot document. The DB's `sizeBytes` is treated as
   * a stale cache (only updated on snapshot create/persist), so we don't trust
   * it for resource accounting.
   *
   * Snapshots whose file is missing on disk count as 0 — they're effectively
   * not occupying space, even if the document still says otherwise.
   */
  async getTotalSnapshotBytes(): Promise<number> {
    const snapshots = await this.snapshotModel
      .find(
        { status: SnapshotStatus.READY },
        { snapshotPath: 1, _id: 0 },
      )
      .lean()
      .exec();

    if (snapshots.length === 0) return 0;

    const sizes = await Promise.all(
      snapshots.map(async (s) => {
        try {
          const stat = await fsp.stat(s.snapshotPath);
          return stat.size;
        } catch {
          return 0;
        }
      }),
    );

    return sizes.reduce((acc, n) => acc + n, 0);
  }

  /**
   * Throws BadRequestException if allocating `additionalMemoryMib` would exceed the
   * configured maxTotalMemoryMib limit. No-op when the limit is not configured.
   *
   * Adds the hot pool's *unfilled* reservation to the in-use total so on-demand
   * sandboxes can't grow into capacity that has been reserved for pre-warmed
   * pods. Hot sandboxes that are already running are already part of `current`
   * (their `memoryMib` is summed by `getTotalMemoryMib`), so we only count the
   * gap (target − current) to avoid double-billing.
   */
  async assertMemoryAvailable(additionalMemoryMib: number): Promise<void> {
    const limit = this.config.resourceLimits?.maxTotalMemoryMib;
    if (!limit || limit <= 0) return;

    const current = await this.getTotalMemoryMib();
    const hotOverhead = this.hotAccountant
      ? await this.hotAccountant.getReservedMemoryOverhead()
      : 0;
    const projected = current + hotOverhead + additionalMemoryMib;
    if (projected > limit) {
      throw new BadRequestException(
        `RAM limit exceeded: requested ${additionalMemoryMib} MiB + in-use ${current} MiB ` +
          (hotOverhead > 0
            ? `+ hot-pool reserve ${hotOverhead} MiB `
            : '') +
          `would surpass the configured maximum of ${limit} MiB`,
      );
    }
  }

  /**
   * Throws BadRequestException if creating a new snapshot would push total snapshot disk
   * usage past the configured maxTotalDiskBytes limit. We can't know the snapshot size
   * in advance, so this is a soft pre-check: we reject when the configured limit has
   * already been reached.
   */
  async assertDiskAvailable(): Promise<void> {
    const limit = this.config.resourceLimits?.maxTotalDiskBytes;
    if (!limit || limit <= 0) return;

    const current = await this.getTotalSnapshotBytes();
    if (current >= limit) {
      throw new BadRequestException(
        `Disk limit exceeded: snapshots already use ${current} bytes, ` +
          `at or above the configured maximum of ${limit} bytes`,
      );
    }
  }

  async getUsageSummary() {
    const [memoryMib, diskBytes, hotOverhead] = await Promise.all([
      this.getTotalMemoryMib(),
      this.getTotalSnapshotBytes(),
      this.hotAccountant
        ? this.hotAccountant.getReservedMemoryOverhead()
        : Promise.resolve(0),
    ]);
    return {
      memory: {
        usedMib: memoryMib,
        limitMib: this.config.resourceLimits?.maxTotalMemoryMib ?? null,
        hotPoolReservedMib: hotOverhead,
      },
      disk: {
        usedBytes: diskBytes,
        limitBytes: this.config.resourceLimits?.maxTotalDiskBytes ?? null,
      },
    };
  }
}
