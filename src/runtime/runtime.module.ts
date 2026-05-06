import { Global, Module, Inject, Logger } from '@nestjs/common';
import { CONFIG } from '../config/config.loader';
import { ModuleConfig } from '../config/config.types';
import { RUNTIME_PROVIDER, RuntimeProvider } from './runtime-provider.interface';
import { MicrosandboxRuntimeProvider } from './microsandbox.runtime-provider';
import { DockerRuntimeProvider } from './docker.runtime-provider';

@Global()
@Module({
  providers: [
    MicrosandboxRuntimeProvider,
    DockerRuntimeProvider,
    {
      provide: RUNTIME_PROVIDER,
      inject: [CONFIG, MicrosandboxRuntimeProvider, DockerRuntimeProvider],
      useFactory: (
        config: ModuleConfig,
        msb: MicrosandboxRuntimeProvider,
        docker: DockerRuntimeProvider,
      ): RuntimeProvider => {
        const logger = new Logger('RuntimeModule');
        const type = config.runtime.type;
        logger.log(`Selected runtime backend: ${type}`);
        switch (type) {
          case 'microsandbox':
            return msb;
          case 'docker':
            return docker;
          default:
            throw new Error(`Unknown runtime.type: ${type}`);
        }
      },
    },
  ],
  exports: [RUNTIME_PROVIDER],
})
export class RuntimeModule {}
