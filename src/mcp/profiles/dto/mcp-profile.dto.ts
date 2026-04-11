import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean, IsArray } from 'class-validator';

export class CreateMcpProfileDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedTools?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultSandboxProfileId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  readOnly?: boolean;
}

export class UpdateMcpProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedTools?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultSandboxProfileId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  readOnly?: boolean;
}
