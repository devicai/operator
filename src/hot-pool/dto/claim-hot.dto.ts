import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class ClaimHotDto {
  @ApiPropertyOptional({
    description:
      'External binding identifier to attach to the claimed sandbox. ' +
      'Mirrors `bindingId` on /sandboxes.',
  })
  @IsOptional()
  @IsString()
  bindingId?: string;

  @ApiPropertyOptional({ description: 'TTL (seconds) for the claimed sandbox.' })
  @IsOptional()
  @IsInt()
  @Min(60)
  ttlSeconds?: number;

  @ApiPropertyOptional({
    description:
      'Renew the claimed sandbox while it is in use. Mirrors `autoExtend` on ' +
      '/sandboxes. A pod sitting in the pool never auto-extends — the flag ' +
      'only starts applying once the sandbox has an owner.',
  })
  @IsOptional()
  @IsBoolean()
  autoExtend?: boolean;
}
