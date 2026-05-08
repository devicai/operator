import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

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
}
