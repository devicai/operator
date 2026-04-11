import { Injectable, NotFoundException } from '@nestjs/common';
import { McpProfileRepository } from '../../repositories/mcp-profile.repository';
import { McpProfileDocument } from '../../schemas/mcp-profile.schema';
import { ExtensionScope } from '../../interfaces';
import { CreateMcpProfileDto, UpdateMcpProfileDto } from './dto/mcp-profile.dto';
import { AVAILABLE_MCP_TOOLS } from '../available-tools';

@Injectable()
export class McpProfilesService {
  constructor(private readonly repo: McpProfileRepository) {}

  getAvailableTools() {
    return AVAILABLE_MCP_TOOLS;
  }

  async findAll(scope: ExtensionScope): Promise<McpProfileDocument[]> {
    const result = await this.repo.find({}, scope, { limit: 100 });
    return result.data;
  }

  async findById(id: string, scope: ExtensionScope): Promise<McpProfileDocument> {
    const profile = await this.repo.findById(id, scope);
    if (!profile) throw new NotFoundException(`MCP profile ${id} not found`);
    return profile;
  }

  async resolveProfile(id: string): Promise<McpProfileDocument | null> {
    return this.repo.resolveProfile(id);
  }

  async create(dto: CreateMcpProfileDto, scope: ExtensionScope): Promise<McpProfileDocument> {
    return this.repo.create(dto as any, scope);
  }

  async update(
    id: string,
    dto: UpdateMcpProfileDto,
    scope: ExtensionScope,
  ): Promise<McpProfileDocument> {
    const updated = await this.repo.updateById(id, { $set: dto } as any, scope);
    if (!updated) throw new NotFoundException(`MCP profile ${id} not found`);
    return updated;
  }

  async delete(id: string, scope: ExtensionScope): Promise<void> {
    const deleted = await this.repo.deleteById(id, scope);
    if (!deleted) throw new NotFoundException(`MCP profile ${id} not found`);
  }
}
