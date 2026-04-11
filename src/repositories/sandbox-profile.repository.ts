import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BaseRepository } from './base.repository';
import { ExtensionProperty } from '../config/config.types';
import { EXTENSIONS_TOKEN } from '../providers/extensions.provider';
import { SandboxProfile, SandboxProfileDocument } from '../schemas/sandbox-profile.schema';

@Injectable()
export class SandboxProfileRepository extends BaseRepository<SandboxProfileDocument> {
  constructor(
    @InjectModel(SandboxProfile.name)
    private readonly profileModel: Model<SandboxProfileDocument>,
    @Inject(EXTENSIONS_TOKEN) extensions: ExtensionProperty[],
  ) {
    super(profileModel, 'SandboxProfile', extensions);
  }
}
