import { Module, forwardRef } from '@nestjs/common';
import { SandboxesController } from './sandboxes.controller';
import { SandboxesService } from './sandboxes.service';
import { SandboxTtlService } from './sandbox-ttl.service';
import { SandboxRegistry } from './sandbox-registry';
import { SnapshotsModule } from '../snapshots/snapshots.module';
import { HotPoolModule } from '../hot-pool/hot-pool.module';

@Module({
  imports: [
    forwardRef(() => SnapshotsModule),
    forwardRef(() => HotPoolModule),
  ],
  controllers: [SandboxesController],
  providers: [SandboxesService, SandboxTtlService, SandboxRegistry],
  exports: [SandboxesService, SandboxRegistry],
})
export class SandboxesModule {}
