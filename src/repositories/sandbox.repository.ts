import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BaseRepository } from './base.repository';
import { ExtensionProperty } from '../config/config.types';
import { EXTENSIONS_TOKEN } from '../providers/extensions.provider';
import { Sandbox, SandboxDocument, SandboxStatus } from '../schemas/sandbox.schema';
import { ExtensionScope } from '../interfaces';

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
    const expiresAt = new Date(Date.now() + cappedTtl * 1000);
    const set: Record<string, any> = {
      hotReserved: false,
      ttlSeconds: cappedTtl,
      expiresAt,
      'metadata.hotClaimedAt': new Date().toISOString(),
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
