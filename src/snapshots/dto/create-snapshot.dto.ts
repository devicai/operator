import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';

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
}
