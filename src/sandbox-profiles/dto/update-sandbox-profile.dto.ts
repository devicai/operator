import { PartialType } from '@nestjs/swagger';
import { CreateSandboxProfileDto } from './create-sandbox-profile.dto';

export class UpdateSandboxProfileDto extends PartialType(CreateSandboxProfileDto) {}
