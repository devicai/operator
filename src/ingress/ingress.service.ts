import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG } from '../config/config.loader';
import { IngressConfig, ModuleConfig } from '../config/config.types';
import {
  RUNTIME_PROVIDER,
  RuntimeProvider,
} from '../runtime/runtime-provider.interface';
import { SandboxDocument } from '../schemas/sandbox.schema';
import { SnapshotRepository } from '../repositories/snapshot.repository';
import { IngressEntry, IngressRegistry } from './ingress-registry';
import { subdomainForSnapshot, toDnsLabel } from './subdomain.util';

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
    private readonly snapshotRepo: SnapshotRepository,
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

    // Allow the runtime to make the sandbox reachable from this process
    // (e.g. Docker connects the local container to the per-sandbox bridge).
    if (this.runtime.attachLocal) {
      try {
        await this.runtime.attachLocal(sandbox.name);
      } catch (err) {
        this.logger.warn(
          `attachLocal(${sandbox.name}) failed: ${(err as Error).message}`,
        );
      }
    }

    const upstreamPort = sandbox.exposedHttpPort ?? cfg.defaultUpstreamPort;
    const address = await this.runtime.getAddress(sandbox.name, upstreamPort);
    if (!address) {
      this.logger.warn(
        `Cannot publish sandbox ${sandbox.sandboxId}: runtime did not return an address for port ${upstreamPort}`,
      );
      return null;
    }

    const subdomain = await this.resolveSubdomain(sandbox);
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
  async unpublish(
    sandbox: Pick<SandboxDocument, 'sandboxId' | 'subdomain' | 'name'>,
  ): Promise<void> {
    if (!this.isEnabled()) return;
    const subdomain = sandbox.subdomain ?? toDnsLabel(sandbox.sandboxId);
    await this.registry.unpublish(subdomain);
    if (this.runtime.detachLocal && sandbox.name) {
      try {
        await this.runtime.detachLocal(sandbox.name);
      } catch (err) {
        this.logger.debug(
          `detachLocal(${sandbox.name}) ignored: ${(err as Error).message}`,
        );
      }
    }
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

  /**
   * The subdomain a sandbox is published under.
   *
   * A sandbox restored from a snapshot answers on the SNAPSHOT's subdomain, so
   * the URL of whatever it serves survives across sessions — `restoreInternal`
   * mints a new `sandboxId` every time, and publishing by that id would hand
   * out a different URL on every restore. Anything not born of a snapshot keeps
   * the historical behaviour of being published under its own id.
   *
   * The origin is read from `metadata.restoredFrom`, not from `snapshotId`:
   * the latter is only set for LINKED restores, and an unlinked sandbox (a
   * fork, or one revived by visiting its URL) still belongs at the same
   * address.
   *
   * If two sandboxes of the same snapshot are alive at once they both claim
   * this subdomain and the last to publish wins — the registry entry is a
   * single key. That is the intended trade-off: the address identifies the
   * snapshot, not the process serving it.
   */
  private async resolveSubdomain(sandbox: SandboxDocument): Promise<string> {
    const origin =
      sandbox.snapshotId ?? (sandbox.metadata?.restoredFrom as string | undefined);
    if (!origin) return toDnsLabel(sandbox.sandboxId);

    try {
      const snapshot = await this.snapshotRepo.findOne(
        { snapshotId: origin } as any,
        {},
      );
      if (snapshot) return subdomainForSnapshot(snapshot);
    } catch (err) {
      this.logger.warn(
        `Could not resolve the subdomain of snapshot ${origin}, falling back ` +
          `to the sandbox id: ${(err as Error).message}`,
      );
    }
    // The snapshot was deleted while this sandbox was running, or the lookup
    // failed. Publishing under the sandbox id keeps it reachable.
    return toDnsLabel(sandbox.sandboxId);
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

