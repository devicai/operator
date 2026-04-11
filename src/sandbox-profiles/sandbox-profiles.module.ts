import { Module } from '@nestjs/common';
import { SandboxProfilesController } from './sandbox-profiles.controller';
import { SandboxProfilesService } from './sandbox-profiles.service';

@Module({
  controllers: [SandboxProfilesController],
  providers: [SandboxProfilesService],
  exports: [SandboxProfilesService],
})
export class SandboxProfilesModule {}
