import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsNumber, IsBoolean, Min, Max } from 'class-validator';

export class RestoreSnapshotDto {
  @ApiPropertyOptional({ description: 'Custom name for the restored sandbox' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'TTL in seconds for the restored sandbox' })
  @IsOptional()
  @IsNumber()
  @Min(60)
  ttlSeconds?: number;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(8)
  cpus?: number;

  @ApiPropertyOptional({ default: 256 })
  @IsOptional()
  @IsNumber()
  @Min(256)
  @Max(8192)
  memoryMib?: number;

  @ApiPropertyOptional({
    default: true,
    description:
      'If true, the sandbox stays linked to the snapshot and auto-saves on stop/TTL. ' +
      'If false, the sandbox is fully independent (fork).',
  })
  @IsOptional()
  @IsBoolean()
  linked?: boolean;
}
