import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BaseRepository } from './base.repository';
import { ExtensionProperty } from '../config/config.types';
import { EXTENSIONS_TOKEN } from '../providers/extensions.provider';
import { Snapshot, SnapshotDocument } from '../schemas/snapshot.schema';
import { ExtensionScope } from '../interfaces';

@Injectable()
export class SnapshotRepository extends BaseRepository<SnapshotDocument> {
  constructor(
    @InjectModel(Snapshot.name)
    private readonly snapshotModel: Model<SnapshotDocument>,
    @Inject(EXTENSIONS_TOKEN) extensions: ExtensionProperty[],
  ) {
    super(snapshotModel, 'Snapshot', extensions);
  }

  async findBySandboxId(
    sandboxId: string,
    scope: ExtensionScope,
  ): Promise<SnapshotDocument[]> {
    const results = await this.model
      .find(this.applyScope({ sandboxId } as any, scope))
      .sort({ createdAt: -1 })
      .exec();
    return results as SnapshotDocument[];
  }
}
