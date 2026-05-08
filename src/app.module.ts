import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_INTERCEPTOR, APP_GUARD } from '@nestjs/core';
import { loadConfig, CONFIG } from './config/config.loader';
import { EXTENSIONS_TOKEN, applyExtensions } from './providers/extensions.provider';
import { ExtensionScopeInterceptor } from './interceptors/extension-scope.interceptor';
import { ApiKeyGuard } from './guards/api-key.guard';
import { HealthController } from './health/health.controller';
import { Sandbox, SandboxSchema } from './schemas/sandbox.schema';
import { SandboxProfile, SandboxProfileSchema } from './schemas/sandbox-profile.schema';
import { McpProfile, McpProfileSchema } from './schemas/mcp-profile.schema';
import { Snapshot, SnapshotSchema } from './schemas/snapshot.schema';
import { SandboxRepository } from './repositories/sandbox.repository';
import { SandboxProfileRepository } from './repositories/sandbox-profile.repository';
import { McpProfileRepository } from './repositories/mcp-profile.repository';
import { SnapshotRepository } from './repositories/snapshot.repository';
import { ResourceUsageService } from './providers/resource-usage.service';
import { UsageController } from './providers/usage.controller';
import { SandboxesModule } from './sandboxes/sandboxes.module';
import { SandboxProfilesModule } from './sandbox-profiles/sandbox-profiles.module';
import { SnapshotsModule } from './snapshots/snapshots.module';
import { McpModule } from './mcp/mcp.module';
import { TerminalModule } from './terminal/terminal.module';
import { RuntimeModule } from './runtime/runtime.module';
import { HotPoolModule } from './hot-pool/hot-pool.module';

const config = loadConfig();

applyExtensions(SandboxSchema, 'Sandbox', config.extensions.properties);
applyExtensions(SandboxProfileSchema, 'SandboxProfile', config.extensions.properties);
applyExtensions(McpProfileSchema, 'McpProfile', config.extensions.properties);
applyExtensions(SnapshotSchema, 'Snapshot', config.extensions.properties);

@Global()
@Module({
  imports: [
    ScheduleModule.forRoot(),
    MongooseModule.forRoot(config.database.uri ?? 'mongodb://localhost:27017/devic-sandbox'),
    MongooseModule.forFeature([
      { name: Sandbox.name, schema: SandboxSchema },
      { name: SandboxProfile.name, schema: SandboxProfileSchema },
      { name: McpProfile.name, schema: McpProfileSchema },
      { name: Snapshot.name, schema: SnapshotSchema },
    ]),
    RuntimeModule,
    SandboxesModule,
    SandboxProfilesModule,
    SnapshotsModule,
    McpModule,
    TerminalModule,
    HotPoolModule,
  ],
  controllers: [HealthController, UsageController],
  providers: [
    { provide: CONFIG, useValue: config },
    { provide: EXTENSIONS_TOKEN, useValue: config.extensions.properties },
    { provide: APP_INTERCEPTOR, useClass: ExtensionScopeInterceptor },
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    SandboxRepository,
    SandboxProfileRepository,
    McpProfileRepository,
    SnapshotRepository,
    ResourceUsageService,
  ],
  exports: [
    MongooseModule,
    SandboxRepository,
    SandboxProfileRepository,
    McpProfileRepository,
    SnapshotRepository,
    ResourceUsageService,
    CONFIG,
    EXTENSIONS_TOKEN,
  ],
})
export class AppModule {}
