import { SandboxesService } from './sandboxes.service';
import { SandboxStatus } from '../schemas/sandbox.schema';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/**
 * Drives the auto-extension path alone: a sandbox created with `autoExtend`
 * renews itself when an action lands close to its expiry. The service is
 * instantiated without the Nest DI graph so the clock and the repository are
 * the only things that matter here.
 */
function makeService(
  config: { maxTtlSeconds?: number; autoExtendWindowSeconds?: number } = {},
) {
  const sandboxRepo = {
    atomicExtendExpiry: jest
      .fn()
      .mockImplementation(async (_id: string, _from: Date, to: Date) => ({
        sandboxId: 'sbx-1',
        subdomain: undefined,
        expiresAt: to,
      })),
  };
  const registry = { extendTtl: jest.fn().mockResolvedValue(undefined) };
  const logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  const service = Object.create(SandboxesService.prototype) as SandboxesService;
  Object.assign(service as any, {
    sandboxRepo,
    registry,
    logger,
    config: {
      defaults: {
        maxTtlSeconds: config.maxTtlSeconds ?? 7200,
        autoExtendWindowSeconds: config.autoExtendWindowSeconds,
      },
    },
    ingressService: undefined,
  });
  return { service, sandboxRepo, registry, logger };
}

/**
 * A running sandbox `remainingMs` away from expiry, created `ageMs` ago. The
 * defaults put it inside the renewal window with plenty of budget left.
 */
function makeDoc(
  overrides: {
    remainingMs?: number;
    ageMs?: number;
    ttlSeconds?: number;
    autoExtend?: boolean;
    status?: SandboxStatus;
    claimedAt?: Date;
  } = {},
) {
  const now = Date.now();
  const ageMs = overrides.ageMs ?? 30 * MINUTE;
  return {
    _id: { toString: () => 'oid-1' },
    sandboxId: 'sbx-1',
    status: overrides.status ?? SandboxStatus.RUNNING,
    autoExtend: overrides.autoExtend ?? true,
    ttlSeconds: overrides.ttlSeconds ?? 1800,
    expiresAt: new Date(now + (overrides.remainingMs ?? 10 * SECOND)),
    createdAt: new Date(now - ageMs),
    claimedAt: overrides.claimedAt,
  } as any;
}

/** The service keeps `maybeAutoExtend` private; the tests drive it directly. */
const autoExtend = (service: SandboxesService, doc: any): Promise<void> =>
  (service as any).maybeAutoExtend(doc);

describe('SandboxesService auto-extension', () => {
  it('renews by a full ttlSeconds when an action lands inside the window', async () => {
    const { service, sandboxRepo, registry } = makeService();
    const doc = makeDoc({ remainingMs: 10 * SECOND, ttlSeconds: 1800 });

    await autoExtend(service, doc);

    const [id, from, to] = sandboxRepo.atomicExtendExpiry.mock.calls[0];
    expect(id).toBe('oid-1');
    expect(from).toEqual(doc.expiresAt);
    expect(to.getTime() - doc.expiresAt.getTime()).toBe(1800 * SECOND);
    // The Redis key must outlive the document, not the other way round.
    expect(registry.extendTtl).toHaveBeenCalledWith('sbx-1', expect.any(Number));
    expect(registry.extendTtl.mock.calls[0][1]).toBeGreaterThan(1800);
  });

  it('leaves a sandbox with time to spare alone', async () => {
    const { service, sandboxRepo } = makeService();

    await autoExtend(service, makeDoc({ remainingMs: 5 * MINUTE }));

    expect(sandboxRepo.atomicExtendExpiry).not.toHaveBeenCalled();
  });

  it('honours a configured window wider than the default', async () => {
    const { service, sandboxRepo } = makeService({ autoExtendWindowSeconds: 120 });

    await autoExtend(service, makeDoc({ remainingMs: 90 * SECOND }));

    expect(sandboxRepo.atomicExtendExpiry).toHaveBeenCalled();
  });

  it('ignores sandboxes that never asked for it', async () => {
    const { service, sandboxRepo } = makeService();

    await autoExtend(service, makeDoc({ autoExtend: false }));

    expect(sandboxRepo.atomicExtendExpiry).not.toHaveBeenCalled();
  });

  it('does not resurrect a sandbox the reaper already owns', async () => {
    const { service, sandboxRepo } = makeService();

    // Past its expiry: the reaper may be inside atomicExpire right now, and a
    // renewed document would read RUNNING with its container already removed.
    await autoExtend(service, makeDoc({ remainingMs: -5 * SECOND }));
    await autoExtend(service, makeDoc({ status: SandboxStatus.STOPPED }));

    expect(sandboxRepo.atomicExtendExpiry).not.toHaveBeenCalled();
  });

  it('clamps the last renewal to the max TTL instead of overshooting it', async () => {
    // 100 min old, 10s left, ttl 30 min, ceiling 2 h → only ~20 min available.
    const { service, sandboxRepo } = makeService({ maxTtlSeconds: 7200 });
    const doc = makeDoc({
      ageMs: 100 * MINUTE,
      remainingMs: 10 * SECOND,
      ttlSeconds: 1800,
    });

    await autoExtend(service, doc);

    const to = sandboxRepo.atomicExtendExpiry.mock.calls[0][2];
    const ceiling = doc.createdAt.getTime() + 7200 * SECOND;
    expect(to.getTime()).toBe(ceiling);
    expect(to.getTime()).toBeLessThan(doc.expiresAt.getTime() + 1800 * SECOND);
  });

  it('stops renewing once the max TTL is exhausted', async () => {
    const { service, sandboxRepo, logger } = makeService({ maxTtlSeconds: 7200 });

    await autoExtend(
      service,
      makeDoc({ ageMs: 7200 * SECOND, remainingMs: 10 * SECOND }),
    );

    expect(sandboxRepo.atomicExtendExpiry).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });

  it('measures the ceiling from the claim, not from when the pod was pre-warmed', async () => {
    // A hot-pool pod created 3 days ago and claimed a minute ago still gets a
    // full extension; anchoring on createdAt would grant it nothing.
    const { service, sandboxRepo } = makeService({ maxTtlSeconds: 7200 });
    const doc = makeDoc({
      ageMs: 3 * 24 * 60 * MINUTE,
      claimedAt: new Date(Date.now() - MINUTE),
      remainingMs: 10 * SECOND,
      ttlSeconds: 1800,
    });

    await autoExtend(service, doc);

    const to = sandboxRepo.atomicExtendExpiry.mock.calls[0][2];
    expect(to.getTime() - doc.expiresAt.getTime()).toBe(1800 * SECOND);
  });

  it('skips the side effects when a concurrent action won the race', async () => {
    const { service, sandboxRepo, registry } = makeService();
    sandboxRepo.atomicExtendExpiry.mockResolvedValueOnce(null);

    await autoExtend(service, makeDoc());

    expect(registry.extendTtl).not.toHaveBeenCalled();
  });

  it('never fails the action it was called for', async () => {
    const { service, sandboxRepo, registry, logger } = makeService();
    sandboxRepo.atomicExtendExpiry.mockRejectedValueOnce(new Error('mongo down'));

    await expect(autoExtend(service, makeDoc())).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();

    registry.extendTtl.mockRejectedValueOnce(new Error('redis down'));
    await expect(autoExtend(service, makeDoc())).resolves.toBeUndefined();
  });
});
