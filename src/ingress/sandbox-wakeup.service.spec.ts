import { Test, TestingModule } from '@nestjs/testing';
import { Server, createServer } from 'net';
import { AddressInfo } from 'net';
import { CONFIG } from '../config/config.loader';
import { ModuleConfig } from '../config/config.types';
import { SnapshotRepository } from '../repositories/snapshot.repository';
import { SnapshotStatus } from '../schemas/snapshot.schema';
import { IngressRegistry, WakeupState } from './ingress-registry';
import { SandboxWakeupService } from './sandbox-wakeup.service';

/**
 * The behaviour that matters here is not "a restore happens" but how many
 * happen: one page load fires dozens of requests at a dormant subdomain, and
 * each one lands in `wake()`.
 */
describe('SandboxWakeupService', () => {
  let service: SandboxWakeupService;

  const claims = new Set<string>();
  const wakeups = new Map<string, WakeupState>();
  const routes = new Map<string, any>();

  const registry = {
    claimWakeup: jest.fn(async (sub: string, snapshotId: string) => {
      if (claims.has(sub)) return false;
      claims.add(sub);
      wakeups.set(sub, {
        state: 'starting',
        startedAt: new Date().toISOString(),
        snapshotId,
      });
      return true;
    }),
    getWakeup: jest.fn(async (sub: string) => wakeups.get(sub) ?? null),
    failWakeup: jest.fn(async (sub: string, snapshotId: string, message: string) => {
      wakeups.set(sub, {
        state: 'error',
        startedAt: new Date().toISOString(),
        snapshotId,
        message,
      });
    }),
    clearWakeup: jest.fn(async (sub: string) => {
      wakeups.delete(sub);
      claims.delete(sub);
    }),
    lookup: jest.fn(async (sub: string) => routes.get(sub) ?? null),
  };

  const snapshots = new Map<string, any>();
  const snapshotRepo = {
    findBySubdomain: jest.fn(async (sub: string) => snapshots.get(sub) ?? null),
  };

  const buildConfig = (ingress: Record<string, any> = {}): ModuleConfig =>
    ({
      ingress: {
        enabled: true,
        wildcardDomain: 'sandbox.devic.test',
        ...ingress,
      },
    }) as ModuleConfig;

  const build = async (config = buildConfig()): Promise<SandboxWakeupService> => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SandboxWakeupService,
        { provide: CONFIG, useValue: config },
        { provide: IngressRegistry, useValue: registry },
        { provide: SnapshotRepository, useValue: snapshotRepo },
      ],
    }).compile();
    return moduleRef.get(SandboxWakeupService);
  };

  beforeEach(async () => {
    claims.clear();
    wakeups.clear();
    routes.clear();
    snapshots.clear();
    jest.clearAllMocks();
    service = await build();
  });

  const readySnapshot = (over: Record<string, any> = {}) => ({
    snapshotId: 'snap1',
    status: SnapshotStatus.READY,
    ...over,
  });

  it('restores the snapshot behind a dormant subdomain', async () => {
    snapshots.set('my-app', readySnapshot());
    const restore = jest.fn(async () => ({ sandboxId: 'newBox' }));
    service.registerRestorer(restore);

    const outcome = await service.wake('my-app');

    expect(outcome.kind).toBe('waking');
    // The restore is fired without being awaited, so let the microtask run.
    await new Promise((r) => setImmediate(r));
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('restores UNLINKED, so a visit can never write back into the snapshot', async () => {
    snapshots.set('my-app', readySnapshot());
    const restore = jest.fn(async () => ({ sandboxId: 'newBox' }));
    service.registerRestorer(restore);

    await service.wake('my-app');
    await new Promise((r) => setImmediate(r));

    // The service decides the TTL; linkage is the caller's contract and is
    // asserted where the restorer is registered (snapshots.service).
    expect(restore).toHaveBeenCalledWith('snap1', 1800);
  });

  it('lets exactly one of many concurrent visits do the restoring', async () => {
    snapshots.set('my-app', readySnapshot());
    const restore = jest.fn(async () => ({ sandboxId: 'newBox' }));
    service.registerRestorer(restore);

    const outcomes = await Promise.all(
      Array.from({ length: 25 }, () => service.wake('my-app')),
    );
    await new Promise((r) => setImmediate(r));

    expect(outcomes.filter((o) => o.kind === 'waking')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'already-waking')).toHaveLength(24);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('does not restore a snapshot that opted out', async () => {
    snapshots.set('my-app', readySnapshot({ autoRestart: false }));
    const restore = jest.fn();
    service.registerRestorer(restore);

    const outcome = await service.wake('my-app');

    expect(outcome.kind).toBe('disabled');
    expect(restore).not.toHaveBeenCalled();
    expect(registry.claimWakeup).not.toHaveBeenCalled();
  });

  it('treats an unknown subdomain as nothing to wake', async () => {
    const restore = jest.fn();
    service.registerRestorer(restore);

    expect((await service.wake('nope')).kind).toBe('unknown');
    expect(restore).not.toHaveBeenCalled();
  });

  // A snapshot mid-creation has no complete artifact, and a failed one has
  // nothing worth serving.
  it.each([SnapshotStatus.CREATING, SnapshotStatus.FAILED])(
    'does not wake a snapshot in status %s',
    async (status) => {
      snapshots.set('my-app', readySnapshot({ status }));
      const restore = jest.fn();
      service.registerRestorer(restore);

      expect((await service.wake('my-app')).kind).toBe('unknown');
      expect(restore).not.toHaveBeenCalled();
    },
  );

  it('does nothing when auto-restart is off globally', async () => {
    service = await build(buildConfig({ autoRestart: false }));
    snapshots.set('my-app', readySnapshot());
    const restore = jest.fn();
    service.registerRestorer(restore);

    expect((await service.wake('my-app')).kind).toBe('unknown');
    expect(snapshotRepo.findBySubdomain).not.toHaveBeenCalled();
  });

  it('records the reason when a restore fails, instead of spinning forever', async () => {
    snapshots.set('my-app', readySnapshot());
    service.registerRestorer(async () => {
      throw new Error('not enough memory');
    });

    await service.wake('my-app');
    await new Promise((r) => setImmediate(r));

    expect(await service.status('my-app')).toEqual({
      state: 'error',
      message: 'not enough memory',
    });
  });

  it('clears the claim once the sandbox is up, so a later stop can wake again', async () => {
    snapshots.set('my-app', readySnapshot());
    service.registerRestorer(async () => ({ sandboxId: 'newBox' }));

    await service.wake('my-app');
    await new Promise((r) => setImmediate(r));

    expect(registry.clearWakeup).toHaveBeenCalledWith('my-app');
    expect(claims.has('my-app')).toBe(false);
  });

  describe('status', () => {
    /** A listening socket, so 'ready' can be told apart from 'merely routed'. */
    const listeners: Server[] = [];
    const listen = async (): Promise<number> => {
      const server = createServer(() => undefined);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      listeners.push(server);
      return (server.address() as AddressInfo).port;
    };

    afterEach(async () => {
      await Promise.all(
        listeners.splice(0).map((s) => new Promise((r) => s.close(r))),
      );
    });

    it('reports ready only once the port actually answers', async () => {
      const port = await listen();
      routes.set('my-app', {
        sandboxId: 'box',
        upstreamHost: '127.0.0.1',
        upstreamPort: port,
      });
      expect(await service.status('my-app')).toEqual({ state: 'ready' });
    });

    // The route is written when the sandbox is published, which is well before
    // anything inside it listens. Reporting ready there sends the waiting page
    // reloading straight into a 502 — and since a snapshot restores files, not
    // processes, that is the normal case rather than a race.
    it('keeps waiting when the sandbox is routed but nothing is listening', async () => {
      routes.set('my-app', {
        sandboxId: 'box',
        // Port 1 on loopback: nothing binds it, so the connection is refused.
        upstreamHost: '127.0.0.1',
        upstreamPort: 1,
      });
      expect(await service.status('my-app')).toEqual({ state: 'starting' });
    });

    it('reports idle when nothing is happening', async () => {
      expect(await service.status('my-app')).toEqual({ state: 'idle' });
    });

    it('reports how long a wake-up has been running', async () => {
      wakeups.set('my-app', {
        state: 'starting',
        startedAt: new Date(Date.now() - 9000).toISOString(),
        snapshotId: 'snap1',
      });
      const status = await service.status('my-app');
      expect(status.state).toBe('starting');
      expect(status.elapsedSeconds).toBeGreaterThanOrEqual(8);
    });
  });
});
