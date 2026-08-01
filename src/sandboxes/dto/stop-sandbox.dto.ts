import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class StopSandboxDto {
  @ApiPropertyOptional({
    default: true,
    description:
      'Persist the filesystem back into the linked snapshot before stopping. ' +
      'Ignored when the sandbox is not linked to one. Set false to discard the ' +
      "session's changes.",
  })
  @IsOptional()
  @IsBoolean()
  save?: boolean;

  @ApiPropertyOptional({
    description:
      'Snapshot to save into, when the caller wants to name it rather than ' +
      'rely on the link the sandbox was restored with. Required to save a ' +
      'sandbox that was restored unlinked; must otherwise match the linked one.',
  })
  @IsOptional()
  @IsString()
  snapshotId?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Return as soon as the save is claimed and finish it in the background. ' +
      'The sandbox goes to "stopping", the snapshot to saveState "saving", and ' +
      'the container is torn down only once the capture has finished — a ' +
      'capture killed halfway loses the save. Poll GET /sandboxes/:id/status.',
  })
  @IsOptional()
  @IsBoolean()
  async?: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      'Stop even while a capture of this sandbox is in flight, killing it. ' +
      'Only for abandoning a save that is stuck.',
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
