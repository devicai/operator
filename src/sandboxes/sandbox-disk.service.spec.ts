import { SandboxDiskService } from './sandbox-disk.service';

const GB = 1024 * 1024 * 1024;

function makeService(opts: {
  warn?: number;
  limit?: number;
  managed?: Array<{ name: string; sizeRwBytes?: number }>;
  running?: Array<{ sandboxId: string; name: string }>;
  listManaged?: boolean;
} = {}) {
  const sandboxRepo = {
    findRunning: jest.fn().mockResolvedValue(
      (opts.running ?? []).map((r) => ({ ...r, _id: { toString: () => `oid-${r.sandboxId}` } })),
    ),
    updateById: jest.fn().mockResolvedValue({}),
  };
  const runtime: any = {};
  if (opts.listManaged !== false) {
    runtime.listManaged = jest.fn().mockResolvedValue(
      (opts.managed ?? []).map((m) => ({
        name: m.name,
        createdAtMs: Date.now(),
        status: 'running',
        ...(m.sizeRwBytes !== undefined ? { sizeRwBytes: m.sizeRwBytes } : {}),
      })),
    );
  }
  const sandboxesService = { stop: jest.fn().mockResolvedValue({}) };
  const config = {
    resourceLimits: {
      warnSandboxDiskBytes: opts.warn,
      maxSandboxDiskBytes: opts.limit,
    },
  };

  const service = Object.create(SandboxDiskService.prototype) as SandboxDiskService;
  Object.assign(service as any, {
    sandboxRepo,
    runtime,
    sandboxesService,
    config,
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    running: false,
  });
  return { service, sandboxRepo, runtime, sandboxesService };
}

describe('SandboxDiskService.checkDiskUsage', () => {
  it('stops a sandbox that crossed the cap, recording why', async () => {
    const { service, sandboxesService } = makeService({
      limit: 8 * GB,
      managed: [{ name: 'sandbox-fat', sizeRwBytes: 10 * GB }],
      running: [{ sandboxId: 'fat', name: 'sandbox-fat' }],
    });

    await service.checkDiskUsage();

    expect(sandboxesService.stop).toHaveBeenCalledWith('fat', {}, 'disk-limit');
  });

  it('leaves a sandbox below the cap alone', async () => {
    const { service, sandboxesService } = makeService({
      limit: 8 * GB,
      managed: [{ name: 'sandbox-ok', sizeRwBytes: 2 * GB }],
      running: [{ sandboxId: 'ok', name: 'sandbox-ok' }],
    });

    await service.checkDiskUsage();

    expect(sandboxesService.stop).not.toHaveBeenCalled();
  });

  it('warns without stopping between the warn and the cap', async () => {
    const { service, sandboxesService } = makeService({
      warn: 3 * GB,
      limit: 8 * GB,
      managed: [{ name: 'sandbox-heavy', sizeRwBytes: 5 * GB }],
      running: [{ sandboxId: 'heavy', name: 'sandbox-heavy' }],
    });

    await service.checkDiskUsage();

    expect((service as any).logger.warn).toHaveBeenCalled();
    expect(sandboxesService.stop).not.toHaveBeenCalled();
  });

  it('records usage on every sandbox so growth is visible before the cap', async () => {
    const { service, sandboxRepo } = makeService({
      limit: 8 * GB,
      managed: [{ name: 'sandbox-small', sizeRwBytes: 1024 }],
      running: [{ sandboxId: 'small', name: 'sandbox-small' }],
    });

    await service.checkDiskUsage();

    const [, update] = sandboxRepo.updateById.mock.calls[0];
    expect(update.$set.diskBytes).toBe(1024);
    expect(update.$set.diskCheckedAt).toBeInstanceOf(Date);
  });

  it('does nothing when no thresholds are configured', async () => {
    const { service, runtime } = makeService({
      managed: [{ name: 'sandbox-any', sizeRwBytes: 100 * GB }],
      running: [{ sandboxId: 'any', name: 'sandbox-any' }],
    });
    await service.checkDiskUsage();
    expect(runtime.listManaged).not.toHaveBeenCalled();
  });

  it('is a no-op on runtimes that cannot report sizes', async () => {
    const { service, sandboxRepo } = makeService({
      limit: 8 * GB,
      listManaged: false,
    });
    await service.checkDiskUsage();
    expect(sandboxRepo.findRunning).not.toHaveBeenCalled();
  });

  it('skips containers the runtime reported without a size', async () => {
    const { service, sandboxRepo, sandboxesService } = makeService({
      limit: 1,
      managed: [{ name: 'sandbox-nosize' }],
      running: [{ sandboxId: 'nosize', name: 'sandbox-nosize' }],
    });
    await service.checkDiskUsage();
    expect(sandboxRepo.findRunning).not.toHaveBeenCalled();
    expect(sandboxesService.stop).not.toHaveBeenCalled();
  });

  it('ignores a running document with no container of its own', async () => {
    // Stale document, or a sandbox whose container was reclaimed elsewhere.
    const { service, sandboxRepo } = makeService({
      limit: 8 * GB,
      managed: [{ name: 'sandbox-other', sizeRwBytes: 10 * GB }],
      running: [{ sandboxId: 'ghost', name: 'sandbox-ghost' }],
    });
    await service.checkDiskUsage();
    expect(sandboxRepo.updateById).not.toHaveBeenCalled();
  });

  it('keeps checking the rest when one stop fails', async () => {
    const { service, sandboxesService } = makeService({
      limit: 1 * GB,
      managed: [
        { name: 'sandbox-a', sizeRwBytes: 2 * GB },
        { name: 'sandbox-b', sizeRwBytes: 3 * GB },
      ],
      running: [
        { sandboxId: 'a', name: 'sandbox-a' },
        { sandboxId: 'b', name: 'sandbox-b' },
      ],
    });
    sandboxesService.stop.mockRejectedValueOnce(new Error('already stopped'));

    await service.checkDiskUsage();

    expect(sandboxesService.stop).toHaveBeenCalledTimes(2);
  });

  it('does not overlap with a check already in flight', async () => {
    const { service, runtime } = makeService({
      limit: 8 * GB,
      managed: [{ name: 'sandbox-a', sizeRwBytes: 10 * GB }],
      running: [{ sandboxId: 'a', name: 'sandbox-a' }],
    });
    (service as any).running = true;
    await service.checkDiskUsage();
    expect(runtime.listManaged).not.toHaveBeenCalled();
  });
});
