import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { McpProfilesService } from './mcp-profiles.service';
import { CreateMcpProfileDto, UpdateMcpProfileDto } from './dto/mcp-profile.dto';

@ApiTags('MCP Profiles')
@Controller('mcp-profiles')
export class McpProfilesController {
  constructor(private readonly service: McpProfilesService) {}

  @Get('available-tools')
  @ApiOperation({ summary: 'List available MCP tools' })
  getAvailableTools() {
    return this.service.getAvailableTools();
  }

  @Get()
  @ApiOperation({ summary: 'List MCP profiles' })
  findAll(@Req() req: any) {
    return this.service.findAll(req.extensionScope ?? {});
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get MCP profile by ID' })
  findById(@Param('id') id: string, @Req() req: any) {
    return this.service.findById(id, req.extensionScope ?? {});
  }

  @Post()
  @ApiOperation({ summary: 'Create MCP profile' })
  create(@Body() dto: CreateMcpProfileDto, @Req() req: any) {
    return this.service.create(dto, req.extensionScope ?? {});
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update MCP profile' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateMcpProfileDto,
    @Req() req: any,
  ) {
    return this.service.update(id, dto, req.extensionScope ?? {});
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete MCP profile' })
  delete(@Param('id') id: string, @Req() req: any) {
    return this.service.delete(id, req.extensionScope ?? {});
  }
}
