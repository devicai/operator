import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class WriteFileDto {
  @ApiProperty({ description: 'Absolute path inside the sandbox' })
  @IsString()
  path: string;

  @ApiProperty({ description: 'File content (text)' })
  @IsString()
  content: string;
}
