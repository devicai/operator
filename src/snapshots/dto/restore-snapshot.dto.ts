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

  @ApiPropertyOptional({
    default: false,
    description:
      'Keep the restored sandbox alive while it is in use. Mirrors ' +
      '`autoExtend` on /sandboxes: an action arriving within ' +
      '`defaults.autoExtendWindowSeconds` of the expiry renews it for another ' +
      '`ttlSeconds`, capped by `defaults.maxTtlSeconds`.',
  })
  @IsOptional()
  @IsBoolean()
  autoExtend?: boolean;

  @ApiPropertyOptional({
    description:
      'Port inside the restored sandbox the public ingress proxy should ' +
      'forward HTTP traffic to. Defaults to the port captured in the ' +
      'snapshot, then to ingress.defaultUpstreamPort.',
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(65535)
  exposedHttpPort?: number;
}
