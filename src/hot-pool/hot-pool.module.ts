import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ModuleSettings,
  ModuleSettingsSchema,
} from '../schemas/module-settings.schema';
import { SandboxesModule } from '../sandboxes/sandboxes.module';
import { SnapshotsModule } from '../snapshots/snapshots.module';
import { HotPoolController } from './hot-pool.controller';
import { HotPoolService } from './hot-pool.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ModuleSettings.name, schema: ModuleSettingsSchema },
    ]),
    forwardRef(() => SandboxesModule),
    forwardRef(() => SnapshotsModule),
  ],
  controllers: [HotPoolController],
  providers: [HotPoolService],
  exports: [HotPoolService],
})
export class HotPoolModule {}
