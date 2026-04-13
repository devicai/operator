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
import { SnapshotsService } from './snapshots.service';
import { CreateSnapshotDto } from './dto/create-snapshot.dto';
import { RestoreSnapshotDto } from './dto/restore-snapshot.dto';

@ApiTags('Snapshots')
@Controller('snapshots')
export class SnapshotsController {
  constructor(private readonly service: SnapshotsService) {}

  @Get()
  @ApiOperation({ summary: 'List snapshots' })
  findAll(
    @Req() req: any,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('sandboxId') sandboxId?: string,
  ) {
    return this.service.findAll(req.extensionScope ?? {}, {
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      sandboxId,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get snapshot by ID' })
  findById(@Param('id') id: string, @Req() req: any) {
    return this.service.findById(id, req.extensionScope ?? {});
  }

  @Post()
  @ApiOperation({ summary: 'Create snapshot from running sandbox' })
  create(@Body() dto: CreateSnapshotDto, @Req() req: any) {
    return this.service.create(dto, req.extensionScope ?? {});
  }

  @Post(':id/restore')
  @ApiOperation({ summary: 'Restore sandbox from snapshot' })
  restore(
    @Param('id') id: string,
    @Body() dto: RestoreSnapshotDto,
    @Req() req: any,
  ) {
    return this.service.restore(id, dto, req.extensionScope ?? {});
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete snapshot' })
  destroy(@Param('id') id: string, @Req() req: any) {
    return this.service.destroy(id, req.extensionScope ?? {});
  }
}
