import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsObject } from 'class-validator';

export class RunCommandDto {
  @ApiProperty({ description: 'Shell command to execute' })
  @IsString()
  command: string;

  @ApiPropertyOptional({ description: 'Working directory override' })
  @IsOptional()
  @IsString()
  cwd?: string;

  @ApiPropertyOptional({ description: 'Additional environment variables for this command' })
  @IsOptional()
  @IsObject()
  env?: Record<string, string>;
}
