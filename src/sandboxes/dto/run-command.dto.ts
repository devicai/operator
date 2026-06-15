import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsObject, IsInt, Min, Max } from 'class-validator';

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

  @ApiPropertyOptional({
    description:
      'Per-command time budget in seconds. When the command does not finish in ' +
      'time it is aborted and the sandbox shell is reset (exit code 124). ' +
      'Overrides the server default; 0 disables the timeout for this command.',
    minimum: 0,
    maximum: 86400,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86400)
  timeoutSeconds?: number;
}
