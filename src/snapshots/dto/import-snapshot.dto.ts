import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';

/**
 * Metadata for a snapshot created from an uploaded ZIP of files. The archive
 * becomes a workdir-scope snapshot: on restore its entries land inside the
 * sandbox working directory.
 */
export class ImportSnapshotDto {
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
      'Working directory the files restore into. Defaults to /workspace.',
  })
  @IsOptional()
  @IsString()
  workdir?: string;

  @ApiPropertyOptional({
    description:
      'Base image for sandboxes restored from this snapshot. Defaults to the configured default image.',
  })
  @IsOptional()
  @IsString()
  image?: string;
}
