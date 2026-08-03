import { Test, TestingModule } from '@nestjs/testing';
import { CONFIG } from '../config/config.loader';
import { ModuleConfig } from '../config/config.types';
import { RUNTIME_PROVIDER } from '../runtime/runtime-provider.interface';
import { SnapshotRepository } from '../repositories/snapshot.repository';
import { SandboxRepository } from '../repositories/sandbox.repository';
import { IngressEntry, IngressRegistry } from './ingress-registry';
import { IngressService } from './ingress.service';

describe('IngressService', () => {
  let service: IngressService;
  /** Snapshots the subdomain resolver may find, keyed by snapshotId. */
  const snapshots = new Map<string, { snapshotId: string; slug?: string }>();
  const snapshotRepo = {
    findOne: jest.fn(async (filter: any) => snapshots.get(filter.snapshotId) ?? null),
  };
  /** Sandboxes that were already published when the process started. */
  const published: any[] = [];
  const sandboxRepo = {
    findPublished: jest.fn(async () => published),
  };
  const registryStore = new Map<string, IngressEntry>();
  const registry: Pick<IngressRegistry, 'publish' | 'unpublish' | 'extendTtl' | 'lookup'> = {
    publish: jest.fn(async (sub, entry) => {
      registryStore.set(sub, entry);
    }),
    // Mirrors the real compare-and-delete: a subdomain belongs to the snapshot,
    // so several sandboxes contend for it and only its current holder may
    // release it.
    unpublish: jest.fn(async (sub, ownerSandboxId?: string) => {
      const current = registryStore.get(sub);
      if (!current) return false;
      if (ownerSandboxId && current.sandboxId !== ownerSandboxId) return false;
      registryStore.delete(sub);
      return true;
    }),
    extendTtl: jest.fn(async () => {}),
    lookup: jest.fn(async (sub) => registryStore.get(sub) ?? null),
  };
  const runtime = {
    create: jest.fn(),
    get: jest.fn(),
    remove: jest.fn(),
    getAddress: jest.fn(),
    attachLocal: jest.fn(),
    detachLocal: jest.fn(),
  };

  const buildConfig = (enabled: boolean): ModuleConfig =>
    ({
      ingress: enabled
        ? {
            enabled: true,
            wildcardDomain: 'sandbox.devic.test',
            publicScheme: 'https',
            proxyPort: 8080,
            proxyHost: '0.0.0.0',
            defaultUpstreamPort: 80,
            upstreamTimeoutMs: 30000,
            registryMaxTtlSeconds: 86400,
          }
        : { enabled: false, wildcardDomain: 'sandbox.devic.test' },
    }) as ModuleConfig;

  beforeEach(async () => {
    registryStore.clear();
    snapshots.clear();
    published.length = 0;
    jest.clearAllMocks();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        IngressService,
        { provide: CONFIG, useValue: buildConfig(true) },
        { provide: RUNTIME_PROVIDER, useValue: runtime },
        { provide: IngressRegistry, useValue: registry },
        { provide: SnapshotRepository, useValue: snapshotRepo },
        { provide: SandboxRepository, useValue: sandboxRepo },
      ],
    }).compile();
    service = moduleRef.get(IngressService);
  });

  it('publishes a sandbox using its sandboxId as subdomain', async () => {
    runtime.getAddress.mockResolvedValueOnce({ host: '172.18.0.5', port: 80 });
    const result = await service.publish({
      sandboxId: 'AbC123def456',
      name: 'sandbox-AbC123def456',
      exposedHttpPort: undefined,
      expiresAt: new Date(Date.now() + 60_000),
    } as any);
    expect(result).toEqual({
      subdomain: 'abc123def456',
      publicUrl: 'https://abc123def456.sandbox.devic.test',
      internalEndpoint: '172.18.0.5:80',
    });
    expect(registry.publish).toHaveBeenCalledWith(
      'abc123def456',
      { sandboxId: 'AbC123def456', upstreamHost: '172.18.0.5', upstreamPort: 80 },
      expect.any(Number),
    );
  });

  it.each([
    { id: '-pUsem7mCwab', expected: 's-pusem7mcwab' },
    { id: '_abc123', expected: 's-abc123' },
    { id: 'foo_bar-baz', expected: 'foo-bar-baz' },
    { id: 'trailing-', expected: 'trailing-x' },
  ])('sanitizes sandboxId $id into a valid DNS label ($expected)', async ({ id, expected }) => {
    runtime.getAddress.mockResolvedValueOnce({ host: '10.0.0.1', port: 80 });
    const result = await service.publish({
      sandboxId: id,
      name: `sandbox-${id}`,
      exposedHttpPort: undefined,
      expiresAt: new Date(Date.now() + 60_000),
    } as any);
    expect(result?.subdomain).toBe(expected);
    expect(result?.publicUrl).toBe(`https://${expected}.sandbox.devic.test`);
  });

  it('uses exposedHttpPort when defined', async () => {
    runtime.getAddress.mockResolvedValueOnce({ host: 'h', port: 3000 });
    await service.publish({
      sandboxId: 'sbx',
      name: 'sandbox-sbx',
      exposedHttpPort: 3000,
      expiresAt: new Date(Date.now() + 1_000),
    } as any);
    expect(runtime.getAddress).toHaveBeenCalledWith('sandbox-sbx', 3000);
  });

  it('returns null when runtime cannot resolve an address', async () => {
    runtime.getAddress.mockResolvedValueOnce(null);
    const result = await service.publish({
      sandboxId: 'sbx',
      name: 'sandbox-sbx',
      expiresAt: new Date(Date.now() + 1_000),
    } as any);
    expect(result).toBeNull();
    expect(registry.publish).not.toHaveBeenCalled();
  });

  it('clamps TTL to remaining lifetime + a small grace window', async () => {
    runtime.getAddress.mockResolvedValueOnce({ host: 'h', port: 80 });
    await service.publish({
      sandboxId: 'sbx',
      name: 'sandbox-sbx',
      expiresAt: new Date(Date.now() + 120_000),
    } as any);
    const ttl = (registry.publish as jest.Mock).mock.calls[0][2] as number;
    expect(ttl).toBeGreaterThanOrEqual(120);
    expect(ttl).toBeLessThanOrEqual(120 + 60 + 5);
  });

  it('calls attachLocal before resolving the address on publish', async () => {
    const order: string[] = [];
    runtime.attachLocal.mockImplementationOnce(async () => {
      order.push('attach');
    });
    runtime.getAddress.mockImplementationOnce(async () => {
      order.push('getAddress');
      return { host: 'h', port: 80 };
    });
    await service.publish({
      sandboxId: 'sbx',
      name: 'sandbox-sbx',
      expiresAt: new Date(Date.now() + 1_000),
    } as any);
    expect(order).toEqual(['attach', 'getAddress']);
  });

  it('detaches the local container on unpublish', async () => {
    await service.unpublish({
      sandboxId: 'sbx',
      subdomain: 'sbx',
      name: 'sandbox-sbx',
    } as any);
    expect(runtime.detachLocal).toHaveBeenCalledWith('sandbox-sbx');
  });

  // The point of these: a restored sandbox gets a brand-new sandboxId every
  // time, so publishing by that id hands out a URL that dies with the session.
  describe('stable subdomains for snapshot-backed sandboxes', () => {
    it('publishes under the snapshot slug when there is one', async () => {
      snapshots.set('snapABC', { snapshotId: 'snapABC', slug: 'my-app' });
      runtime.getAddress.mockResolvedValueOnce({ host: '10.1.1.1', port: 3000 });

      const result = await service.publish({
        sandboxId: 'freshSandbox1',
        name: 'sandbox-freshSandbox1',
        snapshotId: 'snapABC',
        exposedHttpPort: 3000,
      } as any);

      expect(result?.subdomain).toBe('my-app');
      expect(result?.publicUrl).toBe('https://my-app.sandbox.devic.test');
    });

    it('falls back to a label derived from the snapshot id when there is no slug', async () => {
      snapshots.set('Snap_XY', { snapshotId: 'Snap_XY' });
      runtime.getAddress.mockResolvedValueOnce({ host: '10.1.1.2', port: 80 });

      const result = await service.publish({
        sandboxId: 'anotherSandbox',
        name: 'sandbox-anotherSandbox',
        snapshotId: 'Snap_XY',
      } as any);

      expect(result?.subdomain).toBe('snap-xy');
    });

    // An unlinked restore (a fork, or one woken by a visit) never gets
    // `snapshotId` on the document, but it still belongs at the same address.
    it('reads the origin from metadata.restoredFrom when the sandbox is unlinked', async () => {
      snapshots.set('snapORIG', { snapshotId: 'snapORIG', slug: 'demo-site' });
      runtime.getAddress.mockResolvedValueOnce({ host: '10.1.1.3', port: 8000 });

      const result = await service.publish({
        sandboxId: 'unlinkedOne',
        name: 'sandbox-unlinkedOne',
        metadata: { restoredFrom: 'snapORIG', linked: false },
      } as any);

      expect(result?.subdomain).toBe('demo-site');
    });

    it('keeps publishing by sandbox id when the sandbox has no snapshot', async () => {
      runtime.getAddress.mockResolvedValueOnce({ host: '10.1.1.4', port: 80 });

      const result = await service.publish({
        sandboxId: 'PlainBox9',
        name: 'sandbox-PlainBox9',
      } as any);

      expect(result?.subdomain).toBe('plainbox9');
      expect(snapshotRepo.findOne).not.toHaveBeenCalled();
    });

    // The snapshot can be deleted while a sandbox of it is still running.
    it('falls back to the sandbox id when the snapshot is gone', async () => {
      runtime.getAddress.mockResolvedValueOnce({ host: '10.1.1.5', port: 80 });

      const result = await service.publish({
        sandboxId: 'OrphanBox',
        name: 'sandbox-OrphanBox',
        snapshotId: 'deletedSnap',
      } as any);

      expect(result?.subdomain).toBe('orphanbox');
    });

    it('stays reachable when the snapshot lookup itself fails', async () => {
      snapshotRepo.findOne.mockRejectedValueOnce(new Error('mongo is down'));
      runtime.getAddress.mockResolvedValueOnce({ host: '10.1.1.6', port: 80 });

      const result = await service.publish({
        sandboxId: 'ResilientBox',
        name: 'sandbox-ResilientBox',
        snapshotId: 'snapABC',
      } as any);

      expect(result?.subdomain).toBe('resilientbox');
    });
  });

  // Reachability lives in the container: Docker puts each sandbox on its own
  // bridge and `publish` joins THIS container to it, an attachment that dies
  // with the container. After a restart the routes in Redis still resolve but
  // name addresses nothing here can reach — and a route that exists suppresses
  // the wake-up that would replace it, so nothing recovers on its own.
  describe('on startup', () => {
    it('reattaches to sandboxes that were already published', async () => {
      published.push(
        { sandboxId: 'BoxOne', name: 'sandbox-BoxOne', subdomain: 'boxone' },
        { sandboxId: 'BoxTwo', name: 'sandbox-BoxTwo', subdomain: 'boxtwo' },
      );
      runtime.getAddress.mockResolvedValue({ host: '172.21.0.2', port: 80 });

      await service.onModuleInit();
      await new Promise((r) => setImmediate(r));

      expect(runtime.attachLocal).toHaveBeenCalledWith('sandbox-BoxOne');
      expect(runtime.attachLocal).toHaveBeenCalledWith('sandbox-BoxTwo');
      expect(registry.publish).toHaveBeenCalledTimes(2);
    });

    it('keeps going when one sandbox cannot be reattached', async () => {
      published.push(
        { sandboxId: 'Broken', name: 'sandbox-Broken', subdomain: 'broken' },
        { sandboxId: 'Fine', name: 'sandbox-Fine', subdomain: 'fine' },
      );
      runtime.getAddress
        .mockRejectedValueOnce(new Error('no such container'))
        .mockResolvedValue({ host: '172.21.0.3', port: 80 });

      await service.onModuleInit();
      await new Promise((r) => setImmediate(r));

      expect(registry.publish).toHaveBeenCalledTimes(1);
    });

    it('does nothing when ingress is disabled', async () => {
      const moduleRef: TestingModule = await Test.createTestingModule({
        providers: [
          IngressService,
          { provide: CONFIG, useValue: buildConfig(false) },
          { provide: RUNTIME_PROVIDER, useValue: runtime },
          { provide: IngressRegistry, useValue: registry },
          { provide: SnapshotRepository, useValue: snapshotRepo },
          { provide: SandboxRepository, useValue: sandboxRepo },
        ],
      }).compile();

      await moduleRef.get(IngressService).onModuleInit();

      expect(sandboxRepo.findPublished).not.toHaveBeenCalled();
    });
  });

  // A subdomain belongs to the SNAPSHOT, so every sandbox restored from one
  // contends for the same key and the last to publish wins. Observed on dev:
  // an older sandbox expired, its unpublish deleted the route its younger
  // sibling was serving, and the next visit — finding no route — restored a
  // third sandbox.
  describe('releasing a shared subdomain', () => {
    it('does not take down a route another sandbox has taken over', async () => {
      runtime.getAddress.mockResolvedValue({ host: '172.21.0.2', port: 80 });
      snapshots.set('snapX', { snapshotId: 'snapX' });

      await service.publish({
        sandboxId: 'older',
        name: 'sandbox-older',
        snapshotId: 'snapX',
      } as any);
      await service.publish({
        sandboxId: 'newer',
        name: 'sandbox-newer',
        snapshotId: 'snapX',
      } as any);

      // The older one expires now, well after handing the address over.
      await service.unpublish({
        sandboxId: 'older',
        subdomain: 'snapx',
        name: 'sandbox-older',
      } as any);

      expect(registryStore.get('snapx')?.sandboxId).toBe('newer');
    });

    it('still releases the route when it is the one serving', async () => {
      runtime.getAddress.mockResolvedValue({ host: '172.21.0.2', port: 80 });
      snapshots.set('snapX', { snapshotId: 'snapX' });

      await service.publish({
        sandboxId: 'only',
        name: 'sandbox-only',
        snapshotId: 'snapX',
      } as any);
      await service.unpublish({
        sandboxId: 'only',
        subdomain: 'snapx',
        name: 'sandbox-only',
      } as any);

      expect(registryStore.has('snapx')).toBe(false);
    });
  });

  it('unpublish is a no-op when ingress is disabled', async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        IngressService,
        { provide: CONFIG, useValue: buildConfig(false) },
        { provide: RUNTIME_PROVIDER, useValue: runtime },
        { provide: IngressRegistry, useValue: registry },
        { provide: SnapshotRepository, useValue: snapshotRepo },
        { provide: SandboxRepository, useValue: sandboxRepo },
      ],
    }).compile();
    const disabled = moduleRef.get(IngressService);
    await disabled.unpublish({ sandboxId: 's', subdomain: 's' } as any);
    expect(registry.unpublish).not.toHaveBeenCalled();
  });
});
