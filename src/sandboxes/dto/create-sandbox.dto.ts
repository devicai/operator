import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsString, IsOptional, IsNumber, IsObject, Min, Max } from 'class-validator';

export class CreateSandboxDto {
  @ApiPropertyOptional({ description: 'Sandbox profile ID to use as base configuration' })
  @IsOptional()
  @IsString()
  profileId?: string;

  @ApiPropertyOptional({ description: 'External binding identifier for implicit resolution' })
  @IsOptional()
  @IsString()
  bindingId?: string;

  @ApiPropertyOptional({ default: 'node:24' })
  @IsOptional()
  @IsString()
  image?: string;

  @ApiPropertyOptional({ default: '/workspace' })
  @IsOptional()
  @IsString()
  workdir?: string;

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

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  envVars?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  initScript?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  ports?: Record<string, number>;

  @ApiPropertyOptional({ default: 1800 })
  @IsOptional()
  @IsNumber()
  @Min(60)
  ttlSeconds?: number;

  @ApiPropertyOptional({ default: 'allow-all' })
  @IsOptional()
  @IsString()
  networkPolicy?: string;

  @ApiPropertyOptional({
    description:
      'When true, the request first tries to claim a pre-warmed sandbox from ' +
      'the hot pool. Falls back to a regular create if the pool is empty or ' +
      'the requested config is incompatible.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  useHotPool?: boolean;
}
