import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { ModuleConfig } from '../config/config.types';
import { CONFIG } from '../config/config.loader';

export interface IngressEntry {
  /** Sandbox ID this subdomain belongs to. */
  sandboxId: string;
  /** TCP host the proxy must connect to. */
  upstreamHost: string;
  /** TCP port the proxy must connect to. */
  upstreamPort: number;
}

/** A wake-up in flight, or the reason the last one failed. */
export interface WakeupState {
  state: 'starting' | 'error';
  /** ISO timestamp the wake-up began. */
  startedAt: string;
  /** Snapshot being restored. */
  snapshotId: string;
  /** Why it failed, or what it is waiting on while still starting. */
  message?: string;
}

const REGISTRY_PREFIX = 'sandbox:ingress:';
const WAKEUP_PREFIX = 'sandbox:autostart:';

/**
 * Persists subdomain → upstream mappings in Redis so any Operator
 * instance behind a load balancer can route requests for any sandbox.
 *
 * Keys are scoped by subdomain (the wildcard label) — for a request to
 * `<sub>.<wildcardDomain>`, the proxy reads `sandbox:ingress:<sub>`.
 */
@Injectable()
export class IngressRegistry implements OnModuleDestroy {
  private readonly logger = new Logger(IngressRegistry.name);
  private readonly redis: Redis;

  constructor(@Inject(CONFIG) private readonly config: ModuleConfig) {
    this.redis = new Redis(config.redis.url);
    this.redis.on('error', (err) => {
      this.logger.error(`Redis connection error: ${err.message}`);
    });
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  private key(subdomain: string): string {
    return `${REGISTRY_PREFIX}${subdomain.toLowerCase()}`;
  }

  async publish(
    subdomain: string,
    entry: IngressEntry,
    ttlSeconds: number,
  ): Promise<void> {
    const ttl = Math.max(1, Math.floor(ttlSeconds));
    await this.redis.set(this.key(subdomain), JSON.stringify(entry), 'EX', ttl);
  }

  async lookup(subdomain: string): Promise<IngressEntry | null> {
    const raw = await this.redis.get(this.key(subdomain));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as IngressEntry;
    } catch (err) {
      this.logger.warn(
        `Corrupt ingress entry for ${subdomain}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Remove the route for a subdomain.
   *
   * With `ownerSandboxId`, the entry is only removed if it still names that
   * sandbox. A subdomain belongs to a SNAPSHOT, not to a sandbox, so several
   * sandboxes restored from one snapshot compete for the same key and the last
   * to publish wins. An unconditional delete then lets a sandbox that expired
   * take down the route of whichever one currently holds it — leaving a live
   * sandbox unreachable and the next visit restoring yet another.
   *
   * Returns whether anything was removed.
   */
  async unpublish(subdomain: string, ownerSandboxId?: string): Promise<boolean> {
    const key = this.key(subdomain);
    if (!ownerSandboxId) {
      return (await this.redis.del(key)) > 0;
    }

    const current = await this.lookup(subdomain);
    if (!current) return false;
    if (current.sandboxId !== ownerSandboxId) return false;
    return (await this.redis.del(key)) > 0;
  }

  async extendTtl(subdomain: string, ttlSeconds: number): Promise<void> {
    const ttl = Math.max(1, Math.floor(ttlSeconds));
    await this.redis.expire(this.key(subdomain), ttl);
  }

  // --- Wake-up coordination -------------------------------------------------
  //
  // One page load fires dozens of requests (document, favicon, every asset),
  // and each one finds the same dormant subdomain. Without a claim they would
  // each start a restore. `SET NX` makes exactly one of them the restorer and
  // leaves the rest to render the waiting page.
  //
  // Redis rather than an in-process flag because several Operator instances can
  // sit behind the same load balancer, and they must not each restore.

  private wakeupKey(subdomain: string): string {
    return `${WAKEUP_PREFIX}${subdomain.toLowerCase()}`;
  }

  /**
   * Try to become the one who restores this subdomain. True means the caller
   * won and must proceed; false means someone else already did.
   *
   * The TTL is a deadlock guard: if the winner dies mid-restore the claim
   * expires and the next visitor retries, instead of the URL being stuck
   * "starting" forever.
   */
  async claimWakeup(
    subdomain: string,
    snapshotId: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const payload: WakeupState = {
      state: 'starting',
      startedAt: new Date().toISOString(),
      snapshotId,
    };
    const res = await this.redis.set(
      this.wakeupKey(subdomain),
      JSON.stringify(payload),
      'EX',
      Math.max(1, Math.floor(ttlSeconds)),
      'NX',
    );
    return res === 'OK';
  }

  async getWakeup(subdomain: string): Promise<WakeupState | null> {
    const raw = await this.redis.get(this.wakeupKey(subdomain));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as WakeupState;
    } catch {
      return null;
    }
  }

  /**
   * Record that a wake-up failed, so visitors are told why instead of watching
   * a spinner. Short-lived: it is a message for whoever is waiting right now,
   * and it must not keep a later, healthy retry from claiming the subdomain.
   */
  async failWakeup(
    subdomain: string,
    snapshotId: string,
    message: string,
    ttlSeconds: number,
  ): Promise<void> {
    const payload: WakeupState = {
      state: 'error',
      startedAt: new Date().toISOString(),
      snapshotId,
      message,
    };
    await this.redis.set(
      this.wakeupKey(subdomain),
      JSON.stringify(payload),
      'EX',
      Math.max(1, Math.floor(ttlSeconds)),
    );
  }

  /**
   * Say what a still-running wake-up is waiting on, and hold the claim open for
   * as long as it takes.
   *
   * Waiting is a legitimate outcome, not a failure: a snapshot being saved
   * cannot be restored yet, and the save is what makes the restore worth doing.
   * The claim would otherwise expire mid-wait and let a second visitor start a
   * competing restore.
   */
  async noteWakeupWaiting(
    subdomain: string,
    snapshotId: string,
    startedAt: string,
    message: string,
    ttlSeconds: number,
  ): Promise<void> {
    const payload: WakeupState = {
      state: 'starting',
      startedAt,
      snapshotId,
      message,
    };
    await this.redis.set(
      this.wakeupKey(subdomain),
      JSON.stringify(payload),
      'EX',
      Math.max(1, Math.floor(ttlSeconds)),
    );
  }

  async clearWakeup(subdomain: string): Promise<void> {
    await this.redis.del(this.wakeupKey(subdomain));
  }
}
