import { SandboxTtlService } from './sandbox-ttl.service';

const HOUR_MS = 3_600_000;

/**
 * Instantiates the service without the Nest DI graph (Redis registry, Docker
 * provider, snapshots) so the reaper and the sweeper can be driven directly.
 */
function makeService(overrides: {
  expired?: any[];
  managed?: any[];
  liveNames?: string[];
  listManaged?: boolean;
} = {}) {
  const sandboxRepo = {
    findExpired: jest.fn().mockResolvedValue(overrides.expired ?? []),
    atomicExpire: jest.fn().mockImplementation(async () => ({})),
    findLiveContainerNames: jest
      .fn()
      .mockResolvedValue(overrides.liveNames ?? []),
  };
  const registry = {
    get: jest.fn().mockResolvedValue(null),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const runtime: any = {
    remove: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    sweepOrphanedNetworks: jest.fn().mockResolvedValue(0),
  };
  if (overrides.listManaged !== false) {
    runtime.listManaged = jest.fn().mockResolvedValue(overrides.managed ?? []);
  }
  const snapshotsService = {
    persistToSnapshot: jest.fn().mockResolvedValue(undefined),
  };

  const service = Object.create(SandboxTtlService.prototype) as SandboxTtlService;
  Object.assign(service as any, {
    sandboxRepo,
    registry,
    runtime,
    snapshotsService,
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    running: false,
    sweeping: false,
  });
  return { service, sandboxRepo, registry, runtime, snapshotsService };
}

const expiredDoc = (id: string) => ({
  _id: { toString: () => `oid-${id}` },
  sandboxId: id,
  name: `sandbox-${id}`,
});

describe('SandboxTtlService.checkExpiredSandboxes', () => {
  it('removes the container instead of merely stopping it', async () => {
    // An expired sandbox cannot be resumed, so a stopped container would just
    // hold its writable layer forever.
    const { service, runtime } = makeService({ expired: [expiredDoc('abc')] });
    await service.checkExpiredSandboxes();
    expect(runtime.remove).toHaveBeenCalledWith('sandbox-abc');
  });

  it('reaps from the document, not the Redis registry', async () => {
    // Regression: the registry key lives `ttl + 60s`. A reap arriving after it
    // lapsed found no container name and silently left the container running,
    // while the document was already marked expired and never revisited.
    const { service, registry, runtime } = makeService({
      expired: [expiredDoc('late')],
    });
    registry.get.mockResolvedValue(null); // key already gone

    await service.checkExpiredSandboxes();

    expect(runtime.remove).toHaveBeenCalledWith('sandbox-late');
    expect(registry.remove).toHaveBeenCalledWith('late');
  });

  it('persists a linked sandbox to its snapshot before tearing it down', async () => {
    const { service, snapshotsService, runtime } = makeService({
      expired: [{ ...expiredDoc('linked'), snapshotId: 'snap-1' }],
    });
    await service.checkExpiredSandboxes();
    expect(snapshotsService.persistToSnapshot).toHaveBeenCalled();
    expect(runtime.remove).toHaveBeenCalled();
  });

  it('keeps reaping the rest when one removal fails', async () => {
    const { service, runtime } = makeService({
      expired: [expiredDoc('one'), expiredDoc('two')],
    });
    runtime.remove.mockRejectedValueOnce(new Error('daemon busy'));
    await service.checkExpiredSandboxes();
    expect(runtime.remove).toHaveBeenCalledTimes(2);
  });

  it('skips a document another worker already expired', async () => {
    const { service, sandboxRepo, runtime } = makeService({
      expired: [expiredDoc('raced')],
    });
    sandboxRepo.atomicExpire.mockResolvedValue(null);
    await service.checkExpiredSandboxes();
    expect(runtime.remove).not.toHaveBeenCalled();
  });
});

describe('SandboxTtlService.sweepOrphanedContainers', () => {
  const old = (name: string, status = 'exited') => ({
    name,
    status,
    createdAtMs: Date.now() - 24 * HOUR_MS,
  });

  it('reclaims containers whose sandbox is gone or in a terminal state', async () => {
    const { service, runtime } = makeService({
      managed: [old('sandbox-dead1'), old('sandbox-dead2', 'running')],
      liveNames: [],
    });

    await service.sweepOrphanedContainers();

    expect(runtime.remove).toHaveBeenCalledWith('sandbox-dead1');
    // A *running* container whose document is terminal is the harder half of
    // the leak: nothing else will ever stop it.
    expect(runtime.remove).toHaveBeenCalledWith('sandbox-dead2');
  });

  it('never touches a container that still has a live document', async () => {
    const { service, runtime } = makeService({
      managed: [old('sandbox-live', 'running'), old('sandbox-dead')],
      liveNames: ['sandbox-live'],
    });

    await service.sweepOrphanedContainers();

    expect(runtime.remove).toHaveBeenCalledTimes(1);
    expect(runtime.remove).toHaveBeenCalledWith('sandbox-dead');
  });

  it('spares freshly created containers so an in-flight create is safe', async () => {
    const { service, runtime } = makeService({
      managed: [{ name: 'sandbox-new', status: 'running', createdAtMs: Date.now() }],
      liveNames: [],
    });
    await service.sweepOrphanedContainers();
    expect(runtime.remove).not.toHaveBeenCalled();
  });

  it('is a no-op on runtimes that cannot list their sandboxes', async () => {
    const { service, sandboxRepo } = makeService({ listManaged: false });
    await service.sweepOrphanedContainers();
    expect(sandboxRepo.findLiveContainerNames).not.toHaveBeenCalled();
  });

  it('does not query the database when the runtime holds nothing', async () => {
    const { service, sandboxRepo } = makeService({ managed: [] });
    await service.sweepOrphanedContainers();
    expect(sandboxRepo.findLiveContainerNames).not.toHaveBeenCalled();
  });

  it('carries on after a failed removal', async () => {
    const { service, runtime } = makeService({
      managed: [old('sandbox-a'), old('sandbox-b')],
      liveNames: [],
    });
    runtime.remove.mockRejectedValueOnce(new Error('in use'));
    await service.sweepOrphanedContainers();
    expect(runtime.remove).toHaveBeenCalledTimes(2);
  });

  it('does not run two sweeps at once', async () => {
    const { service, runtime } = makeService({
      managed: [old('sandbox-a')],
      liveNames: [],
    });
    (service as any).sweeping = true;
    await service.sweepOrphanedContainers();
    expect(runtime.remove).not.toHaveBeenCalled();
  });
});
