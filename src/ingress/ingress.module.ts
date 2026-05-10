import { Global, Module } from '@nestjs/common';
import { IngressRegistry } from './ingress-registry';
import { IngressService } from './ingress.service';
import { IngressProxyServer } from './ingress-proxy.server';

/**
 * Public ingress: exposes running sandboxes at `<id>.<wildcardDomain>`
 * via an embedded reverse proxy. The proxy server boots itself in
 * `onModuleInit` only when `ingress.enabled` is true.
 */
@Global()
@Module({
  providers: [IngressRegistry, IngressService, IngressProxyServer],
  exports: [IngressService],
})
export class IngressModule {}
