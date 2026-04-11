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
      })
      .exec();
    return results as SandboxDocument[];
  }

  async atomicExpire(id: string): Promise<SandboxDocument | null> {
    return this.model
      .findOneAndUpdate(
        { _id: id, status: SandboxStatus.RUNNING },
        { $set: { status: SandboxStatus.EXPIRED } },
        { new: true },
      )
      .exec() as Promise<SandboxDocument | null>;
  }
}
