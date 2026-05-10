import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG } from '../config/config.loader';
import { IngressConfig, ModuleConfig } from '../config/config.types';
import {
  RUNTIME_PROVIDER,
  RuntimeProvider,
} from '../runtime/runtime-provider.interface';
import { SandboxDocument } from '../schemas/sandbox.schema';
import { IngressEntry, IngressRegistry } from './ingress-registry';

export interface PublishResult {
  /** Subdomain assigned to the sandbox (label only, no domain). */
  subdomain: string;
  /** Public URL the sandbox is reachable at, including scheme. */
  publicUrl: string;
  /** Internal endpoint the proxy will forward to (host:port). */
  internalEndpoint: string;
}

/**
 * Coordinates assignment, persistence and teardown of public subdomains for
 * sandboxes. The actual request routing is done by `IngressProxyServer`,
 * which reads the same Redis registry this service writes to.
 */
@Injectable()
export class IngressService {
  private readonly logger = new Logger(IngressService.name);

  constructor(
    @Inject(CONFIG) private readonly config: ModuleConfig,
    @Inject(RUNTIME_PROVIDER) private readonly runtime: RuntimeProvider,
    private readonly registry: IngressRegistry,
  ) {}

  /** Whether the ingress feature is enabled in the loaded config. */
  isEnabled(): boolean {
    return Boolean(this.config.ingress?.enabled);
  }

  /** Resolve the configured ingress block. Throws when ingress is disabled. */
  private requireConfig(): Required<
    Pick<
      IngressConfig,
      | 'enabled'
      | 'wildcardDomain'
      | 'publicScheme'
      | 'proxyPort'
      | 'proxyHost'
      | 'defaultUpstreamPort'
      | 'upstreamTimeoutMs'
      | 'registryMaxTtlSeconds'
    >
  > {
    const cfg = this.config.ingress;
    if (!cfg?.enabled) {
      throw new Error('Ingress is disabled');
    }
    return {
      enabled: cfg.enabled,
      wildcardDomain: cfg.wildcardDomain,
      publicScheme: cfg.publicScheme ?? 'https',
      proxyPort: cfg.proxyPort ?? 8080,
      proxyHost: cfg.proxyHost ?? '0.0.0.0',
      defaultUpstreamPort: cfg.defaultUpstreamPort ?? 80,
      upstreamTimeoutMs: cfg.upstreamTimeoutMs ?? 30000,
      registryMaxTtlSeconds: cfg.registryMaxTtlSeconds ?? 24 * 60 * 60,
    };
  }

  /**
   * Publish a sandbox under its public subdomain. No-op (returns null) if
   * the ingress feature is disabled. Returns the publication metadata so the
   * caller can persist it on the sandbox doc.
   */
  async publish(sandbox: SandboxDocument): Promise<PublishResult | null> {
    if (!this.isEnabled()) return null;
    const cfg = this.requireConfig();

    const upstreamPort = sandbox.exposedHttpPort ?? cfg.defaultUpstreamPort;
    const address = await this.runtime.getAddress(sandbox.name, upstreamPort);
    if (!address) {
      this.logger.warn(
        `Cannot publish sandbox ${sandbox.sandboxId}: runtime did not return an address for port ${upstreamPort}`,
      );
      return null;
    }

    const subdomain = sandbox.sandboxId.toLowerCase();
    const entry: IngressEntry = {
      sandboxId: sandbox.sandboxId,
      upstreamHost: address.host,
      upstreamPort: address.port,
    };
    const ttl = this.computeTtlSeconds(sandbox, cfg.registryMaxTtlSeconds);
    await this.registry.publish(subdomain, entry, ttl);

    const publicUrl = `${cfg.publicScheme}://${subdomain}.${cfg.wildcardDomain}`;
    const internalEndpoint = `${address.host}:${address.port}`;

    this.logger.log(
      `Published sandbox ${sandbox.sandboxId} at ${publicUrl} → ${internalEndpoint}`,
    );

    return { subdomain, publicUrl, internalEndpoint };
  }

  /** Remove a sandbox's subdomain entry. Idempotent. */
  async unpublish(sandbox: Pick<SandboxDocument, 'sandboxId' | 'subdomain'>): Promise<void> {
    if (!this.isEnabled()) return;
    const subdomain = (sandbox.subdomain ?? sandbox.sandboxId).toLowerCase();
    await this.registry.unpublish(subdomain);
    this.logger.log(`Unpublished sandbox ${sandbox.sandboxId} (${subdomain})`);
  }

  /**
   * Refresh the TTL on an already-published subdomain. Used when the caller
   * extends the sandbox lifetime via `extendTtl`.
   */
  async refreshTtl(
    sandbox: Pick<SandboxDocument, 'sandboxId' | 'subdomain' | 'expiresAt'>,
  ): Promise<void> {
    if (!this.isEnabled() || !sandbox.subdomain) return;
    const cfg = this.requireConfig();
    const ttl = this.computeTtlSeconds(
      sandbox as SandboxDocument,
      cfg.registryMaxTtlSeconds,
    );
    await this.registry.extendTtl(sandbox.subdomain.toLowerCase(), ttl);
  }

  private computeTtlSeconds(
    sandbox: Pick<SandboxDocument, 'expiresAt'>,
    maxTtl: number,
  ): number {
    if (!sandbox.expiresAt) return maxTtl;
    const remainingMs = new Date(sandbox.expiresAt).getTime() - Date.now();
    if (remainingMs <= 0) return 60;
    return Math.min(maxTtl, Math.ceil(remainingMs / 1000) + 60);
  }
}
