import { Module, forwardRef } from '@nestjs/common';
import { SandboxesModule } from '../sandboxes/sandboxes.module';
import { SnapshotsController } from './snapshots.controller';
import { SnapshotsService } from './snapshots.service';

@Module({
  imports: [forwardRef(() => SandboxesModule)],
  controllers: [SnapshotsController],
  providers: [SnapshotsService],
  exports: [SnapshotsService],
})
export class SnapshotsModule {}
