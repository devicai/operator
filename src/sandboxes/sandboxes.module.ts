import { Module, forwardRef } from '@nestjs/common';
import { SandboxesController } from './sandboxes.controller';
import { SandboxesService } from './sandboxes.service';
import { SandboxTtlService } from './sandbox-ttl.service';
import { SandboxRegistry } from './sandbox-registry';
import { SnapshotsModule } from '../snapshots/snapshots.module';

@Module({
  imports: [forwardRef(() => SnapshotsModule)],
  controllers: [SandboxesController],
  providers: [SandboxesService, SandboxTtlService, SandboxRegistry],
  exports: [SandboxesService, SandboxRegistry],
})
export class SandboxesModule {}
