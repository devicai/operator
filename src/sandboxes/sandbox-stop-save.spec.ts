import { SandboxesService } from './sandboxes.service';
import { SandboxStatus } from '../schemas/sandbox.schema';

/**
 * Covers the ordering that a save-on-stop depends on: the container must
 * outlive the capture that is reading its filesystem. Stopping it first (which
 * is what a client doing "snapshot, then stop" over HTTP used to do when the
 * snapshot call timed out) SIGKILLs the tar and loses the save.
 */
function makeService(doc: Record<string, any>, persistOutcome = 'saved') {
  const sandboxRepo = {
    updateById: jest.fn().mockImplementation(async (_id, update) => ({
      ...doc,
      status: update?.$set?.status ?? doc.status,
    })),
  };
  const snapshotsService = {
    persistToSnapshot: jest.fn().mockResolvedValue(persistOutcome),
  };
  const registry = { remove: jest.fn().mockResolvedValue(undefined) };
  const runtime = {
    get: jest.fn().mockResolvedValue(null),
    sweepOrphanedNetworks: jest.fn().mockResolvedValue(0),
  };

  const service = Object.create(SandboxesService.prototype) as SandboxesService;
  Object.assign(service as any, {
    sandboxRepo,
    snapshotsService,
    registry,
    runtime,
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  (service as any).findById = jest.fn().mockResolvedValue(doc);
  return { service, sandboxRepo, snapshotsService, runtime, registry };
}

const runningDoc = (over: Record<string, any> = {}) => ({
  _id: { toString: () => 'oid-sbx' },
  sandboxId: 'sbx1',
  name: 'sandbox-sbx1',
  status: SandboxStatus.RUNNING,
  snapshotId: 'snap1',
  ...over,
});

describe('SandboxesService.stop', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['setImmediate'] }));
  afterEach(() => jest.useRealTimers());

  it('answers with "stopping" and finishes the save off-request when async', async () => {
    const { service, snapshotsService, sandboxRepo } = makeService(runningDoc());

    const result = await service.stop('sbx1', {}, undefined, { async: true });

    expect(result.status).toBe(SandboxStatus.STOPPING);
    // The teardown has not run yet — only the status flip has.
    expect(sandboxRepo.updateById.mock.calls[0][1].$set.status).toBe(
      SandboxStatus.STOPPING,
    );
    await new Promise((r) => setImmediate(r));
    expect(snapshotsService.persistToSnapshot).toHaveBeenCalled();
  });

  it('saves before tearing the container down', async () => {
    const order: string[] = [];
    const { service, snapshotsService, registry } = makeService(runningDoc());
    (snapshotsService.persistToSnapshot as jest.Mock).mockImplementation(
      async () => {
        order.push('save');
        return 'saved';
      },
    );
    (registry.remove as jest.Mock).mockImplementation(async () => {
      order.push('teardown');
    });

    await service.stop('sbx1', {});

    expect(order).toEqual(['save', 'teardown']);
  });

  it('skips the save when the caller closes without saving', async () => {
    const { service, snapshotsService } = makeService(runningDoc());
    await service.stop('sbx1', {}, undefined, { save: false });
    expect(snapshotsService.persistToSnapshot).not.toHaveBeenCalled();
  });

  it('refuses to stop a sandbox that is being captured right now', async () => {
    const { service, registry } = makeService(
      runningDoc({ savingSnapshotId: 'snap1' }),
    );

    await expect(service.stop('sbx1', {})).rejects.toMatchObject({
      response: { code: 'SNAPSHOT_SAVE_IN_PROGRESS' },
    });
    expect(registry.remove).not.toHaveBeenCalled();
  });

  it('waits out a capture in flight instead of refusing, when async', async () => {
    // A client that snapshotted with `async` and then asked to stop wants the
    // teardown to happen *after* the capture, not to be told to come back.
    const doc = runningDoc({ savingSnapshotId: 'snap1' });
    const { service, sandboxRepo, registry } = makeService(doc);
    const fresh = { ...doc, savingSnapshotId: undefined };
    (sandboxRepo as any).findOne = jest.fn().mockResolvedValue(fresh);

    const result = await service.stop('sbx1', {}, undefined, { async: true });

    expect(result.status).toBe(SandboxStatus.STOPPING);
    expect(registry.remove).not.toHaveBeenCalled();
    jest.advanceTimersByTime(2_500);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(registry.remove).toHaveBeenCalled();
  });

  it('lets force through to abandon a stuck capture', async () => {
    const { service, registry } = makeService(
      runningDoc({ savingSnapshotId: 'snap1' }),
    );
    await service.stop('sbx1', {}, undefined, { force: true, save: false });
    expect(registry.remove).toHaveBeenCalled();
  });

  it('surfaces a concurrent save as a conflict instead of stopping anyway', async () => {
    const { service, registry } = makeService(runningDoc(), 'conflict');

    await expect(service.stop('sbx1', {})).rejects.toMatchObject({
      response: { code: 'SNAPSHOT_SAVE_IN_PROGRESS' },
    });
    expect(registry.remove).not.toHaveBeenCalled();
  });
});
