import { Module } from '@nestjs/common';
import { TerminalGateway } from './terminal.gateway';
import { SandboxesModule } from '../sandboxes/sandboxes.module';

@Module({
  imports: [SandboxesModule],
  providers: [TerminalGateway],
})
export class TerminalModule {}
