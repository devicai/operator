import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Res,
  HttpCode,
  Optional,
  StreamableFile,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { IngressService } from '../ingress/ingress.service';
import { ApiTags, ApiOperation, ApiConsumes } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { tmpdir } from 'os';
import type { Response } from 'express';
import { SnapshotsService } from './snapshots.service';
import { CreateSnapshotDto } from './dto/create-snapshot.dto';
import { RestoreSnapshotDto } from './dto/restore-snapshot.dto';
import { ImportSnapshotDto } from './dto/import-snapshot.dto';
import { UpdateSnapshotDto } from './dto/update-snapshot.dto';
import { inspectStartCommand } from './start-command.validation';
import { uploadLimits } from '../config/upload-limits';

@ApiTags('Snapshots')
@Controller('snapshots')
export class SnapshotsController {
  constructor(
    private readonly service: SnapshotsService,
    @Optional() private readonly ingress?: IngressService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List snapshots' })
  async findAll(
    @Req() req: any,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('sandboxId') sandboxId?: string,
  ) {
    const page = await this.service.findAll(req.extensionScope ?? {}, {
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      sandboxId,
    });
    return { ...page, data: (page.data ?? []).map((d) => this.withPublicUrl(d)) };
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
  async findById(@Param('id') id: string, @Req() req: any) {
    return this.withPublicUrl(
      await this.service.findById(id, req.extensionScope ?? {}),
    );
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
  @ApiOperation({
    summary: 'Restore sandbox from snapshot',
    description:
      'A linked restore (the default) takes ownership of the snapshot: the ' +
      'sandbox writes its whole filesystem back on stop or expiry. Only one ' +
      'sandbox may own a snapshot at a time, because a second would overwrite ' +
      "the first's work on the way out rather than merge with it. When the " +
      'snapshot is already running, the live sandbox is returned instead of a ' +
      'second one and `attachedToExisting` is true — check it before assuming ' +
      'a fresh filesystem, and note the TTL you asked for was applied to it. ' +
      'Restore with `linked: false` to fork instead: forks never write back, ' +
      'so any number can run at once.',
  })
  async restore(
    @Param('id') id: string,
    @Body() dto: RestoreSnapshotDto,
    @Req() req: any,
  ) {
    const { sandbox, attached } = await this.service.restore(
      id,
      dto,
      req.extensionScope ?? {},
    );
    return { ...(sandbox as any).toJSON(), attachedToExisting: attached };
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a snapshot subdomain, auto-restart and start command',
    description:
      'Sets the subdomain this snapshot is served under, whether visiting ' +
      'that URL restores it when nothing is running, and what to run once it ' +
      'is back. Takes effect on the next publish; a sandbox already serving ' +
      'this snapshot keeps its current URL. When a start command is given, ' +
      'the response carries startCommandWarnings: static problems found in it ' +
      'that would otherwise only show up as a 502 on the public URL. They are ' +
      'advisory — the command is saved either way.',
  })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateSnapshotDto,
    @Req() req: any,
  ) {
    const updated = this.withPublicUrl(
      await this.service.update(id, dto, req.extensionScope ?? {}),
    );
    if (dto.startCommand === undefined) return updated;

    const startCommandWarnings = await inspectStartCommand(
      dto.startCommand ?? '',
    );
    return { ...updated, startCommandWarnings };
  }

  /**
   * Attach the address this snapshot is served at. Derived, not stored: only
   * the ingress knows the wildcard domain, and callers should not have to
   * configure it a second time to render a link.
   */
  private withPublicUrl(doc: any): any {
    const plain = typeof doc?.toObject === 'function' ? doc.toObject() : doc;
    const publicUrl = this.ingress?.publicUrlForSnapshot(plain) ?? null;
    return publicUrl ? { ...plain, publicUrl } : plain;
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete snapshot' })
  destroy(@Param('id') id: string, @Req() req: any) {
    return this.service.destroy(id, req.extensionScope ?? {});
  }
}
