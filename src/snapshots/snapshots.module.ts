import { Module, forwardRef } from '@nestjs/common';
import { SandboxesModule } from '../sandboxes/sandboxes.module';
import { SnapshotsController } from './snapshots.controller';
import { SnapshotsService } from './snapshots.service';
import { SnapshotImageService } from './snapshot-image.service';

@Module({
  imports: [forwardRef(() => SandboxesModule)],
  controllers: [SnapshotsController],
  providers: [SnapshotsService, SnapshotImageService],
  exports: [SnapshotsService, SnapshotImageService],
})
export class SnapshotsModule {}
