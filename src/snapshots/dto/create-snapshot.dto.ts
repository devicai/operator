import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsIn, IsBoolean } from 'class-validator';

export type SnapshotScope = 'full' | 'workdir';

export class CreateSnapshotDto {
  @ApiProperty({ description: 'ID of the sandbox to snapshot' })
  @IsString()
  sandboxId: string;

  @ApiPropertyOptional({ description: 'Snapshot name' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'Snapshot description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description:
      "What the snapshot captures. 'full' (default): the whole filesystem diff " +
      'vs the base image — installed packages (apt/npm-g/pip), /usr/local/bin ' +
      "binaries and /etc configs survive a restore. 'workdir': only the working " +
      'directory (lighter, legacy behaviour).',
    enum: ['full', 'workdir'],
  })
  @IsOptional()
  @IsIn(['full', 'workdir'])
  scope?: SnapshotScope;

  @ApiPropertyOptional({
    description:
      'Return as soon as the snapshot document exists (status "creating") and ' +
      'capture in the background. A full capture of a large filesystem takes ' +
      'minutes — longer than a typical reverse proxy will hold a request open ' +
      '— so a synchronous call gets cut and the client cannot tell whether the ' +
      'capture is still running. Poll GET /snapshots/:id for the final status.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  async?: boolean;
}
