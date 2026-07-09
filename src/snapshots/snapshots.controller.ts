import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Res,
  HttpCode,
  StreamableFile,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiConsumes } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { tmpdir } from 'os';
import type { Response } from 'express';
import { SnapshotsService } from './snapshots.service';
import { CreateSnapshotDto } from './dto/create-snapshot.dto';
import { RestoreSnapshotDto } from './dto/restore-snapshot.dto';
import { ImportSnapshotDto } from './dto/import-snapshot.dto';
import { uploadLimits } from '../config/upload-limits';

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

  @Post('import')
  @ApiOperation({
    summary: 'Create a snapshot from an uploaded ZIP of files',
    description:
      'The archive becomes a workdir-scope snapshot: restoring it lands the ' +
      'ZIP entries inside the sandbox working directory.',
  })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({ destination: tmpdir() }),
      limits: { fileSize: uploadLimits().maxSnapshotZipMb * 1024 * 1024 },
    }),
  )
  importFromZip(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: ImportSnapshotDto,
    @Req() req: any,
  ) {
    return this.service.importFromZip(file, dto, req.extensionScope ?? {});
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get snapshot by ID' })
  findById(@Param('id') id: string, @Req() req: any) {
    return this.service.findById(id, req.extensionScope ?? {});
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Download snapshot contents as a ZIP archive' })
  async download(
    @Param('id') id: string,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { stream, filename } = await this.service.downloadAsZip(
      id,
      req.extensionScope ?? {},
    );
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    return new StreamableFile(stream);
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
