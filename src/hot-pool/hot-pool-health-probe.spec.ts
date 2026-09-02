import { HotPoolService } from './hot-pool.service';
import { HotPoolHealthProbeConfig } from '../config/config.types';

/**
 * A pooled sandbox can sit warm for weeks, and Docker will keep calling it
 * healthy long after its OCI runtime was restarted underneath it — at which
 * point the container runs nothing new, ever. Since the pool hands out the
 * OLDEST pod first, those are precisely the ones users receive.
 *
 * These tests pin both halves of the answer: a claim never returns a pod that
 * cannot run a command, and the reconcile loop retires them even when nobody
 * is claiming.
 */
function makeService(opts: {
  /** Pods the repository will hand out, oldest first. */
  pods: string[];
  /** Sandbox IDs that fail their probe. */
  broken?: string[];
  probe?: HotPoolHealthProbeConfig;
}) {
  const broken = new Set(opts.broken ?? []);
  const queue = [...opts.pods];
  const destroyed: string[] = [];

  const docFor = (sandboxId: string, ageDays = 14) => ({
    sandboxId,
    name: `sandbox-${sandboxId}`,
    ttlSeconds: 600,
    createdAt: new Date(Date.now() - ageDays * 86_400_000),
    metadata: { hotPool: true },
  });

  const sandboxRepo = {
    atomicClaimHot: jest.fn(async () => {
      const next = queue.shift();
      return next ? docFor(next) : null;
    }),
    findHotReserved: jest.fn(async () => queue.map((id) => docFor(id))),
  };

  const sandboxesService = {
    syncRegistryTtl: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn(async (id: string) => {
      destroyed.push(id);
      const at = queue.indexOf(id);
      if (at !== -1) queue.splice(at, 1);
    }),
    probeHealth: jest.fn(async (doc: any) =>
      broken.has(doc.sandboxId)
        ? { healthy: false, reason: 'OCI runtime exec failed: unsafe procfs' }
        : { healthy: true },
    ),
  };

  const logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  const service = Object.create(HotPoolService.prototype) as HotPoolService;
  Object.assign(service as any, {
    logger,
    sandboxRepo,
    sandboxesService,
    lastProbeOk: new Map<string, number>(),
    unhealthyEvictions: 0,
    totalClaims: 0,
    liveConfig: {
      enabled: true,
      snapshotId: 'snap-1',
      healthProbe: opts.probe,
    },
    config: { defaults: { defaultTtlSeconds: 1800, maxTtlSeconds: 604800 } },
    // The refill after a claim is fire-and-forget; keep it out of the way.
    reconcile: jest.fn().mockResolvedValue(undefined),
  });

  return { service, sandboxRepo, sandboxesService, logger, destroyed, queue };
}

describe('hot pool claim health probe', () => {
  it('skips broken pods and serves the first one that answers', async () => {
    const h = makeService({
      pods: ['dead-1', 'dead-2', 'alive-1'],
      broken: ['dead-1', 'dead-2'],
    });

    const claimed = await h.service.claim({ ttlSeconds: 600 } as any);

    expect(claimed.sandboxId).toBe('alive-1');
    // Both dead pods are gone, not left in the pool to be served again.
    expect(h.destroyed).toEqual(['dead-1', 'dead-2']);
  });

  it('gives up after maxClaimAttempts so the caller can create a fresh sandbox', async () => {
    const h = makeService({
      pods: ['dead-1', 'dead-2', 'dead-3', 'alive-1'],
      broken: ['dead-1', 'dead-2', 'dead-3'],
      probe: { maxClaimAttempts: 2 },
    });

    await expect(h.service.claim({ ttlSeconds: 600 } as any)).rejects.toThrow(
      /No hot sandbox available/,
    );
    expect(h.destroyed).toEqual(['dead-1', 'dead-2']);
  });

  it('serves without probing when probing is disabled', async () => {
    const h = makeService({
      pods: ['dead-1'],
      broken: ['dead-1'],
      probe: { enabled: false },
    });

    const claimed = await h.service.claim({ ttlSeconds: 600 } as any);

    expect(claimed.sandboxId).toBe('dead-1');
    expect(h.sandboxesService.probeHealth).not.toHaveBeenCalled();
  });

  it('logs the runtime reason for every pod it throws away', async () => {
    const h = makeService({ pods: ['dead-1', 'alive-1'], broken: ['dead-1'] });

    await h.service.claim({ ttlSeconds: 600 } as any);

    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('unsafe procfs'),
    );
  });
});

describe('hot pool health sweep', () => {
  const sweep = (service: HotPoolService): Promise<void> =>
    (service as any).cleanupUnhealthyHotSandboxes();

  it('retires pods that stopped answering, even with nobody claiming', async () => {
    const h = makeService({
      pods: ['alive-1', 'dead-1', 'alive-2'],
      broken: ['dead-1'],
    });

    await sweep(h.service);

    expect(h.destroyed).toEqual(['dead-1']);
    expect(h.queue).toEqual(['alive-1', 'alive-2']);
  });

  it('does not re-probe a pod that answered inside the interval', async () => {
    const h = makeService({ pods: ['alive-1'], probe: { intervalMs: 60_000 } });

    await sweep(h.service);
    await sweep(h.service);

    expect(h.sandboxesService.probeHealth).toHaveBeenCalledTimes(1);
  });

  it('re-probes once the interval has elapsed', async () => {
    const h = makeService({ pods: ['alive-1'], probe: { intervalMs: 0 } });

    await sweep(h.service);
    await sweep(h.service);

    expect(h.sandboxesService.probeHealth).toHaveBeenCalledTimes(2);
  });

  it('forgets pods that left the pool, so the map cannot grow unbounded', async () => {
    const h = makeService({ pods: ['alive-1'] });
    await sweep(h.service);
    expect((h.service as any).lastProbeOk.size).toBe(1);

    h.queue.length = 0;
    await sweep(h.service);

    expect((h.service as any).lastProbeOk.size).toBe(0);
  });

  it('does nothing when probing is disabled', async () => {
    const h = makeService({
      pods: ['dead-1'],
      broken: ['dead-1'],
      probe: { enabled: false },
    });

    await sweep(h.service);

    expect(h.destroyed).toEqual([]);
  });
});
