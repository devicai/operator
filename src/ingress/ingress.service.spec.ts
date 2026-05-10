import { Test, TestingModule } from '@nestjs/testing';
import { CONFIG } from '../config/config.loader';
import { ModuleConfig } from '../config/config.types';
import { RUNTIME_PROVIDER } from '../runtime/runtime-provider.interface';
import { IngressEntry, IngressRegistry } from './ingress-registry';
import { IngressService } from './ingress.service';

describe('IngressService', () => {
  let service: IngressService;
  const registryStore = new Map<string, IngressEntry>();
  const registry: Pick<IngressRegistry, 'publish' | 'unpublish' | 'extendTtl' | 'lookup'> = {
    publish: jest.fn(async (sub, entry) => {
      registryStore.set(sub, entry);
    }),
    unpublish: jest.fn(async (sub) => {
      registryStore.delete(sub);
    }),
    extendTtl: jest.fn(async () => {}),
    lookup: jest.fn(async (sub) => registryStore.get(sub) ?? null),
  };
  const runtime = {
    create: jest.fn(),
    get: jest.fn(),
    remove: jest.fn(),
    getAddress: jest.fn(),
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
    jest.clearAllMocks();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        IngressService,
        { provide: CONFIG, useValue: buildConfig(true) },
        { provide: RUNTIME_PROVIDER, useValue: runtime },
        { provide: IngressRegistry, useValue: registry },
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

  it('unpublish is a no-op when ingress is disabled', async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        IngressService,
        { provide: CONFIG, useValue: buildConfig(false) },
        { provide: RUNTIME_PROVIDER, useValue: runtime },
        { provide: IngressRegistry, useValue: registry },
      ],
    }).compile();
    const disabled = moduleRef.get(IngressService);
    await disabled.unpublish({ sandboxId: 's', subdomain: 's' } as any);
    expect(registry.unpublish).not.toHaveBeenCalled();
  });
});
