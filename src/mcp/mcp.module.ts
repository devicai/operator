import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { McpProfilesController } from './profiles/mcp-profiles.controller';
import { McpProfilesService } from './profiles/mcp-profiles.service';
import { SandboxesModule } from '../sandboxes/sandboxes.module';

@Module({
  imports: [SandboxesModule],
  controllers: [McpController, McpProfilesController],
  providers: [McpProfilesService],
  exports: [McpProfilesService],
})
export class McpModule {}
