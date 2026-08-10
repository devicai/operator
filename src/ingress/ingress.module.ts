import { Global, Module } from '@nestjs/common';
import { IngressRegistry } from './ingress-registry';
import { IngressService } from './ingress.service';
import { IngressProxyServer } from './ingress-proxy.server';
import { SandboxWakeupService } from './sandbox-wakeup.service';

/**
 * Public ingress: exposes sandboxes at `<subdomain>.<wildcardDomain>` via an
 * embedded reverse proxy. The proxy server boots itself in `onModuleInit` only
 * when `ingress.enabled` is true.
 *
 * A sandbox restored from a snapshot is published under the SNAPSHOT's
 * subdomain, so the address outlives any single sandbox; `SandboxWakeupService`
 * uses that to restore one on demand when a visit finds nothing running.
 */
@Global()
@Module({
  providers: [
    IngressRegistry,
    IngressService,
    IngressProxyServer,
    SandboxWakeupService,
  ],
  exports: [IngressService, SandboxWakeupService],
})
export class IngressModule {}
