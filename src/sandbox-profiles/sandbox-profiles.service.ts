import { Injectable, NotFoundException } from '@nestjs/common';
import { SandboxProfileRepository } from '../repositories/sandbox-profile.repository';
import { SandboxProfileDocument } from '../schemas/sandbox-profile.schema';
import { ExtensionScope, PaginatedResponse } from '../interfaces';
import { CreateSandboxProfileDto } from './dto/create-sandbox-profile.dto';
import { UpdateSandboxProfileDto } from './dto/update-sandbox-profile.dto';

@Injectable()
export class SandboxProfilesService {
  constructor(private readonly profileRepo: SandboxProfileRepository) {}

  async findAll(
    scope: ExtensionScope,
    options?: { limit?: number; offset?: number },
  ): Promise<PaginatedResponse<SandboxProfileDocument>> {
    return this.profileRepo.find({}, scope, options);
  }

  async findById(id: string, scope: ExtensionScope): Promise<SandboxProfileDocument> {
    const profile = await this.profileRepo.findById(id, scope);
    if (!profile) throw new NotFoundException(`Sandbox profile ${id} not found`);
    return profile;
  }

  async create(
    dto: CreateSandboxProfileDto,
    scope: ExtensionScope,
  ): Promise<SandboxProfileDocument> {
    return this.profileRepo.create(dto as any, scope);
  }

  async update(
    id: string,
    dto: UpdateSandboxProfileDto,
    scope: ExtensionScope,
  ): Promise<SandboxProfileDocument> {
    const updated = await this.profileRepo.updateById(id, { $set: dto } as any, scope);
    if (!updated) throw new NotFoundException(`Sandbox profile ${id} not found`);
    return updated;
  }

  async delete(id: string, scope: ExtensionScope): Promise<void> {
    const deleted = await this.profileRepo.deleteById(id, scope);
    if (!deleted) throw new NotFoundException(`Sandbox profile ${id} not found`);
  }
}
