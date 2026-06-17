import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class WriteFileDto {
  @ApiProperty({
    description:
      'File path inside the sandbox workspace (/workspace). Relative paths ' +
      'resolve against the workspace; absolute paths must stay inside it. ' +
      'Paths outside the workspace are rejected.',
  })
  @IsString()
  path: string;

  @ApiProperty({ description: 'File content (text)' })
  @IsString()
  content: string;
}
