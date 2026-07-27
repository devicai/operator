import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { BaseRepository } from './base.repository';
import { ExtensionProperty } from '../config/config.types';
import { EXTENSIONS_TOKEN } from '../providers/extensions.provider';
import { Sandbox, SandboxDocument, SandboxStatus } from '../schemas/sandbox.schema';
import { ExtensionScope, PaginatedResponse } from '../interfaces';

@Injectable()
export class SandboxRepository extends BaseRepository<SandboxDocument> {
  constructor(
    @InjectModel(Sandbox.name)
    private readonly sandboxModel: Model<SandboxDocument>,
    @Inject(EXTENSIONS_TOKEN) extensions: ExtensionProperty[],
  ) {
    super(sandboxModel, 'Sandbox', extensions);
  }

  async findByBinding(bindingId: string, scope: ExtensionScope): Promise<SandboxDocument | null> {
    return this.findOne({ bindingId } as any, scope);
  }

  async findExpired(): Promise<SandboxDocument[]> {
    const now = new Date();
    const results = await this.model
      .find({
        status: SandboxStatus.RUNNING,
        expiresAt: { $lte: now },
        hotReserved: { $ne: true },
      })
      .exec();
    return results as SandboxDocument[];
  }

  async atomicExpire(id: string): Promise<SandboxDocument | null> {
    return this.model
      .findOneAndUpdate(
        { _id: id, status: SandboxStatus.RUNNING, hotReserved: { $ne: true } },
        { $set: { status: SandboxStatus.EXPIRED } },
        { new: true },
      )
      .exec() as Promise<SandboxDocument | null>;
  }

  /**
   * Atomically pluck the oldest available hot sandbox for the given snapshot.
   * Once claimed, the document is no longer "hotReserved" and `bindingId` /
   * `expiresAt` are updated to reflect the new owner — there is no two-phase
   * commit, so no two concurrent claims can win the same sandbox.
   */
  async atomicClaimHot(
    snapshotId: string,
    update: {
      bindingId?: string;
      ttlSeconds: number;
      maxTtlSeconds: number;
    },
  ): Promise<SandboxDocument | null> {
    const cappedTtl = Math.min(update.ttlSeconds, update.maxTtlSeconds);
    const claimedAt = new Date();
    const expiresAt = new Date(claimedAt.getTime() + cappedTtl * 1000);
    const set: Record<string, any> = {
      hotReserved: false,
      claimedFromHotPool: true,
      claimedAt,
      ttlSeconds: cappedTtl,
      expiresAt,
      // Kept for backwards compatibility with clients reading the metadata bag;
      // `claimedAt` is the queryable, indexed source of truth.
      'metadata.hotClaimedAt': claimedAt.toISOString(),
    };
    if (update.bindingId) {
      set.bindingId = update.bindingId;
    }

    return this.model
      .findOneAndUpdate(
        {
          hotReserved: true,
          status: SandboxStatus.RUNNING,
          'metadata.hotPoolSnapshotId': snapshotId,
        },
        { $set: set },
        { new: true, sort: { createdAt: 1 } },
      )
      .exec() as Promise<SandboxDocument | null>;
  }

  async findHotReserved(snapshotId?: string): Promise<SandboxDocument[]> {
    const filter: Record<string, any> = {
      hotReserved: true,
      status: SandboxStatus.RUNNING,
    };
    if (snapshotId) filter['metadata.hotPoolSnapshotId'] = snapshotId;
    return this.model.find(filter).sort({ createdAt: 1 }).exec() as Promise<
      SandboxDocument[]
    >;
  }

  async findFailedHotReserved(): Promise<SandboxDocument[]> {
    return this.model
      .find({ hotReserved: true, status: SandboxStatus.FAILED })
      .exec() as Promise<SandboxDocument[]>;
  }

  async countHotReserved(snapshotId?: string): Promise<number> {
    const filter: Record<string, any> = {
      hotReserved: true,
      status: SandboxStatus.RUNNING,
    };
    if (snapshotId) filter['metadata.hotPoolSnapshotId'] = snapshotId;
    return this.model.countDocuments(filter).exec();
  }

  /**
   * Matches sandboxes that were served by the hot pool. Documents claimed
   * before `claimedAt` existed only carry `metadata.hotClaimedAt`, so both
   * shapes are accepted.
   */
  static readonly CLAIMED_FROM_POOL_FILTER = {
    $or: [
      { claimedFromHotPool: true },
      { 'metadata.hotClaimedAt': { $exists: true } },
    ],
  };

  /**
   * Paginated listing ordered by *activity* rather than creation.
   *
   * A claimed hot sandbox keeps the `createdAt` of the moment its pod was
   * pre-warmed — often days earlier — so sorting by `createdAt` buries the
   * sandbox that just started serving a session under the idle pool pods. The
   * computed `activityAt` (claim time, falling back to creation time) puts
   * every row where an operator expects to find it.
   */
  async findByActivity(
    filter: FilterQuery<SandboxDocument>,
    scope: ExtensionScope,
    options?: { limit?: number; offset?: number },
  ): Promise<PaginatedResponse<SandboxDocument>> {
    const scopedFilter = this.applyScope(filter, scope);
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;

    const [data, total] = await Promise.all([
      this.model
        .aggregate([
          { $match: scopedFilter },
          {
            $addFields: {
              activityAt: {
                $ifNull: [
                  '$claimedAt',
                  { $toDate: '$metadata.hotClaimedAt' },
                  '$createdAt',
                ],
              },
            },
          },
          { $sort: { activityAt: -1, _id: -1 } },
          { $skip: offset },
          { $limit: limit },
        ])
        .exec(),
      this.model.countDocuments(scopedFilter).exec(),
    ]);

    return {
      data: data as SandboxDocument[],
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    };
  }

  /** Most recently claimed hot sandboxes, newest first. */
  async findRecentClaims(limit: number): Promise<SandboxDocument[]> {
    const rows = await this.model
      .aggregate([
        { $match: SandboxRepository.CLAIMED_FROM_POOL_FILTER },
        {
          $addFields: {
            activityAt: {
              $ifNull: ['$claimedAt', { $toDate: '$metadata.hotClaimedAt' }],
            },
          },
        },
        { $sort: { activityAt: -1 } },
        { $limit: limit },
      ])
      .exec();
    return rows as SandboxDocument[];
  }

  async aggregateHotMemoryMib(snapshotId?: string): Promise<number> {
    const match: Record<string, any> = {
      hotReserved: true,
      status: SandboxStatus.RUNNING,
    };
    if (snapshotId) match['metadata.hotPoolSnapshotId'] = snapshotId;
    const result = await this.model.aggregate<{ total: number }>([
      { $match: match },
      { $group: { _id: null, total: { $sum: '$memoryMib' } } },
    ]);
    return result[0]?.total ?? 0;
  }
}
