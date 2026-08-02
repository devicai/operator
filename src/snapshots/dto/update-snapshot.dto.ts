import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { DNS_LABEL_PATTERN } from '../../ingress/subdomain.util';

export class UpdateSnapshotDto {
  @ApiPropertyOptional({
    description:
      'Subdomain to serve this snapshot under, e.g. "my-app" for ' +
      'my-app.sandbox.devic.ai. Must be a valid DNS label: lowercase letters, ' +
      'digits and hyphens, not starting or ending with a hyphen. Send null to ' +
      'clear it and fall back to the label derived from the snapshot id.',
    nullable: true,
  })
  @IsOptional()
  // A null slug is how a caller releases the subdomain, so it must skip the
  // format check rather than be rejected by it.
  @ValidateIf((o) => o.slug !== null)
  @MaxLength(63)
  @Matches(DNS_LABEL_PATTERN, {
    message:
      'slug must be a valid DNS label: lowercase letters, digits and hyphens, ' +
      'not starting or ending with a hyphen',
  })
  slug?: string | null;

  @ApiPropertyOptional({
    description:
      'Restore this snapshot automatically when its public URL is visited and ' +
      'no sandbox is serving it. Enabled unless explicitly set to false.',
  })
  @IsOptional()
  @IsBoolean()
  autoRestart?: boolean;
}
