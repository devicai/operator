import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BaseRepository } from './base.repository';
import { ExtensionProperty } from '../config/config.types';
import { EXTENSIONS_TOKEN } from '../providers/extensions.provider';
import { McpProfile, McpProfileDocument } from '../schemas/mcp-profile.schema';

@Injectable()
export class McpProfileRepository extends BaseRepository<McpProfileDocument> {
  constructor(
    @InjectModel(McpProfile.name)
    private readonly profileModel: Model<McpProfileDocument>,
    @Inject(EXTENSIONS_TOKEN) extensions: ExtensionProperty[],
  ) {
    super(profileModel, 'McpProfile', extensions);
  }

  async resolveProfile(id: string): Promise<McpProfileDocument | null> {
    return this.model.findById(id).exec() as Promise<McpProfileDocument | null>;
  }
}
