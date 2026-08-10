import { SnapshotsService } from './snapshots.service';

/**
 * What a visit to a dormant public URL does.
 *
 * The subdomain belongs to the SNAPSHOT, not to a sandbox, so every sandbox
 * restored from one shares the same registry key. That makes "no route" an
 * ambiguous signal: it can mean nothing is running, or that something is
 * running and lost the address — which is exactly what happened on dev when an
 * older sandbox expired and its unpublish deleted the route its younger sibling
 * was serving. Restoring on that signal alone put two sandboxes of one snapshot
 * in the air, competing for the address and racing to save into it.
 */
function makeService(runningSandbox: any = null) {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const sandboxRepo = {
    findRunningFromSnapshot: jest.fn(async () => runningSandbox),
  };
  const publishIfEnabled = jest.fn(async (s: any) => s);
  // `restore` now reports whether it created a sandbox or handed back the one
  // that already owns the snapshot, so it returns the pair rather than the doc.
  const restore = jest.fn(async () => ({
    sandbox: { sandboxId: 'freshBox' },
    attached: false,
  }));

  const service = Object.create(SnapshotsService.prototype) as SnapshotsService;
  Object.assign(service as any, {
    logger,
    sandboxRepo,
    publishIfEnabled,
    restore,
  });

  const wake = (snapshotId = 'snap1', ttl = 1800) =>
    (service as any).wakeRestore(snapshotId, ttl);

  return { wake, sandboxRepo, publishIfEnabled, restore, logger };
}

describe('wakeRestore', () => {
  it('restores when no sandbox of the snapshot is running', async () => {
    const { wake, restore, publishIfEnabled } = makeService(null);

    const result = await wake('snap1', 900);

    expect(restore).toHaveBeenCalledWith('snap1', { ttlSeconds: 900 }, {});
    expect(publishIfEnabled).not.toHaveBeenCalled();
    expect(result).toEqual({ sandboxId: 'freshBox' });
  });

  it('republishes a running sandbox instead of minting a second one', async () => {
    const live = { sandboxId: 'liveBox', name: 'sandbox-liveBox' };
    const { wake, restore, publishIfEnabled } = makeService(live);

    const result = await wake('snap1');

    expect(restore).not.toHaveBeenCalled();
    expect(publishIfEnabled).toHaveBeenCalledWith(live, {});
    expect(result).toEqual({ sandboxId: 'liveBox' });
  });

  // Losing the lookup must not cost the visitor their sandbox: restoring is
  // still better than serving an error page.
  it('falls back to restoring when the lookup fails', async () => {
    const { wake, sandboxRepo, restore } = makeService(null);
    sandboxRepo.findRunningFromSnapshot.mockRejectedValueOnce(
      new Error('mongo is down'),
    );

    const result = await wake('snap1');

    expect(restore).toHaveBeenCalled();
    expect(result).toEqual({ sandboxId: 'freshBox' });
  });
});
