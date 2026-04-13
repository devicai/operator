import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SandboxesService } from './sandboxes.service';
import { CreateSandboxDto } from './dto/create-sandbox.dto';
import { RunCommandDto } from './dto/run-command.dto';
import { WriteFileDto } from './dto/write-file.dto';

@ApiTags('Sandboxes')
@Controller('sandboxes')
export class SandboxesController {
  constructor(private readonly service: SandboxesService) {}

  @Get()
  @ApiOperation({ summary: 'List sandboxes' })
  findAll(
    @Req() req: any,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('status') status?: string,
  ) {
    return this.service.findAll(req.extensionScope ?? {}, {
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      status,
    });
  }

  @Get('by-binding/:bindingId')
  @ApiOperation({ summary: 'Get sandbox by binding ID' })
  findByBinding(@Param('bindingId') bindingId: string, @Req() req: any) {
    return this.service.findByBinding(bindingId, req.extensionScope ?? {});
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get sandbox by ID' })
  findById(@Param('id') id: string, @Req() req: any) {
    return this.service.findById(id, req.extensionScope ?? {});
  }

  @Get(':id/status')
  @ApiOperation({ summary: 'Get sandbox status with remaining TTL' })
  getStatus(@Param('id') id: string, @Req() req: any) {
    return this.service.getStatus(id, req.extensionScope ?? {});
  }

  @Post()
  @ApiOperation({ summary: 'Create sandbox' })
  create(@Body() dto: CreateSandboxDto, @Req() req: any) {
    return this.service.create(dto, req.extensionScope ?? {});
  }

  @Post('by-binding/:bindingId/command')
  @ApiOperation({ summary: 'Execute command in sandbox resolved by binding ID' })
  async runCommandByBinding(
    @Param('bindingId') bindingId: string,
    @Body() dto: RunCommandDto,
    @Req() req: any,
  ) {
    const scope = req.extensionScope ?? {};
    const sandbox = await this.service.findByBinding(bindingId, scope);
    if (!sandbox) {
      return { error: `No sandbox found for binding ${bindingId}` };
    }
    return this.service.runCommand(sandbox.sandboxId, dto, scope);
  }

  @Post(':id/command')
  @ApiOperation({ summary: 'Execute command in sandbox' })
  runCommand(
    @Param('id') id: string,
    @Body() dto: RunCommandDto,
    @Req() req: any,
  ) {
    return this.service.runCommand(id, dto, req.extensionScope ?? {});
  }

  @Post(':id/stop')
  @ApiOperation({ summary: 'Stop sandbox' })
  stop(@Param('id') id: string, @Req() req: any) {
    return this.service.stop(id, req.extensionScope ?? {});
  }

  @Post(':id/extend-ttl')
  @ApiOperation({ summary: 'Extend sandbox TTL' })
  extendTtl(
    @Param('id') id: string,
    @Body('additionalSeconds') additionalSeconds: number,
    @Req() req: any,
  ) {
    return this.service.extendTtl(id, additionalSeconds, req.extensionScope ?? {});
  }

  @Get(':id/files')
  @ApiOperation({ summary: 'Read file from sandbox' })
  readFile(
    @Param('id') id: string,
    @Query('path') filePath: string,
    @Req() req: any,
  ) {
    return this.service.readFile(id, filePath, req.extensionScope ?? {});
  }

  @Post(':id/files')
  @ApiOperation({ summary: 'Write file to sandbox' })
  writeFile(
    @Param('id') id: string,
    @Body() dto: WriteFileDto,
    @Req() req: any,
  ) {
    return this.service.writeFile(id, dto.path, dto.content, req.extensionScope ?? {});
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Destroy sandbox' })
  destroy(@Param('id') id: string, @Req() req: any) {
    return this.service.destroy(id, req.extensionScope ?? {});
  }
}
