import { SnapshotsService } from './snapshots.service';
import { SnapshotSaveStage } from '../schemas/snapshot.schema';

/**
 * The commit-based save: sealing the sandbox's writable layer instead of
 * walking, tarring, compressing and replaying it.
 *
 * Two properties matter more than the speed that motivated it.
 *
 * The first is that declining is free. Every reason not to commit — a workdir
 * snapshot, a runtime that cannot, a layer stack with no headroom, an outright
 * failure — has to end with the tarball path running exactly as it always did.
 * The tarball is the artifact of record; an optimisation that can lose a save
 * is not an optimisation.
 *
 * The second is that the image and the version it describes land in ONE write.
 * The tarball path bumps `persistVersion` when the artifact lands and rebuilds
 * the image afterwards, leaving a window where `imageSourceVersion` trails and
 * every restore falls back to replaying a tarball. That window is the whole
 * reason this path exists, so a test that let the two drift apart would be
 * testing the bug back in.
 */
function makeService(over: {
  snapshot?: any;
  canCommitLive?: boolean;
  outOfHeadroom?: boolean;
  commit?: jest.Mock;
  cleanupPreset?: string;
} = {}) {
  const snapshotDoc = {
    _id: { toString: () => 'oid-snap' },
    snapshotId: 'snap1',
    persistVersion: 4,
    imageGeneration: 2,
    workdir: '/workspace',
    ...over.snapshot,
  };

  const updates: any[] = [];
  const snapshotRepo = {
    updateById: jest.fn(async (_id: string, patch: any) => {
      updates.push(patch.$set ?? patch);
      return { ...snapshotDoc, ...(patch.$set ?? {}) };
    }),
  };

  const commit =
    over.commit ??
    jest.fn().mockResolvedValue({
      ref: 'devic-snapshot:snap1',
      uniqueSizeBytes: 52_428_800,
      layers: 10,
    });

  const imageService = {
    canCommitLive: jest.fn().mockReturnValue(over.canCommitLive ?? true),
    isOutOfLayerHeadroom: jest.fn().mockReturnValue(over.outOfHeadroom ?? false),
    scheduleConsolidation: jest.fn(),
    refFor: (id: string) => `devic-snapshot:${id}`,
  };

  const sandbox = { exec: jest.fn().mockResolvedValue({ code: 0, stderr: '' }) };

  // A successful save moves the sandbox's base to the version it just wrote,
  // or its own next save would conflict with itself.
  const sandboxRepo = { updateById: jest.fn().mockResolvedValue(undefined) };

  const service = Object.create(SnapshotsService.prototype) as SnapshotsService;
  Object.assign(service as any, {
    snapshotRepo,
    sandboxRepo,
    imageService,
    runtime: { commitImage: commit },
    config: { snapshots: { cleanup: over.cleanupPreset ?? 'conservative' } },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  });

  const run = (opts: any = { terminal: true }, scope = 'full') =>
    (service as any).persistByCommit(
      snapshotDoc,
      { _id: { toString: () => 'oid-sbx' }, sandboxId: 'sbx1', currentCwd: '/workspace' },
      sandbox,
      'sandbox-sbx1',
      scope,
      Date.now() - 700,
      opts,
    );

  return { run, updates, commit, imageService, sandbox, snapshotRepo, sandboxRepo };
}

const setOf = (updates: any[], key: string) =>
  updates.find((u) => key in u);

describe('persistByCommit', () => {
  it('publishes the image and the version it describes in one write', async () => {
    const { run, updates, commit } = makeService();

    const outcome = await run();

    expect(outcome).toBe('saved');
    expect(commit).toHaveBeenCalledWith(
      'sandbox-sbx1',
      'devic-snapshot:snap1',
      expect.objectContaining({ pause: true }),
    );

    const published = setOf(updates, 'persistVersion');
    expect(published.persistVersion).toBe(5);
    // The pair that must never drift: a restore reads `imageSourceVersion` and
    // falls back to the tarball the moment it disagrees with `persistVersion`.
    expect(published.imageSourceVersion).toBe(5);
    expect(published.imageState).toBe('ready');
    expect(published.imageLayers).toBe(10);
    expect(published.imageGeneration).toBe(3);
    expect(published.lastSaveMethod).toBe('commit');
    expect(published.lastSaveDurationMs).toBeGreaterThan(0);
  });

  it('leaves the tarball version alone, so the lag stays visible', async () => {
    const { run, updates } = makeService({
      snapshot: { persistVersion: 4, tarballVersion: 4 },
    });

    await run();

    // Claiming the tarball is current when only the image moved would hide the
    // window in which the image is the only fresh copy.
    expect(setOf(updates, 'persistVersion').tarballVersion).toBeUndefined();
  });

  // A snapshot last saved before this feature existed has no `tarballVersion`,
  // and its tarball is current: the only path that ran then wrote it. Leaving
  // the field unset made every later reader compute a lag equal to the whole
  // version count — a real snapshot on dev, correct and days old, was flagged
  // "tarball -2" in orange.
  it('backfills tarballVersion on the first commit save of an old snapshot', async () => {
    const { run, updates } = makeService({
      snapshot: { persistVersion: 2, tarballVersion: undefined },
    });

    await run();

    const published = setOf(updates, 'persistVersion');
    // The tarball on disk holds version 2 — the one being left behind.
    expect(published.tarballVersion).toBe(2);
    expect(published.persistVersion).toBe(3);
  });

  it('leaves an existing tarballVersion untouched', async () => {
    const { run, updates } = makeService({
      snapshot: { persistVersion: 9, tarballVersion: 7 },
    });

    await run();

    expect(setOf(updates, 'persistVersion').tarballVersion).toBeUndefined();
  });

  it('asks for the background pass that refreshes the tarball', async () => {
    const { run, imageService } = makeService();
    await run();
    expect(imageService.scheduleConsolidation).toHaveBeenCalled();
  });

  it('drops regenerable caches before sealing, on a terminal save', async () => {
    const { run, sandbox } = makeService();

    await run({ terminal: true });

    const rm = sandbox.exec.mock.calls.find((c: any[]) =>
      String(c[0]).startsWith('rm -rf'),
    );
    expect(rm).toBeDefined();
    expect(rm[0]).toContain("'/var/cache/apt'");
    // Never the pseudo-filesystems: they are excluded from archives but must
    // not be deleted out of a container. Matched quoted, because the command
    // ends in `2>/dev/null` and a bare '/dev' would hit that instead.
    expect(rm[0]).not.toContain("'/proc'");
    expect(rm[0]).not.toContain("'/sys'");
    expect(rm[0]).not.toContain("'/dev'");
    expect(rm[0]).not.toContain("'/tmp'");
  });

  it('does not touch caches, nor freeze, when the session lives on', async () => {
    const { run, sandbox, commit } = makeService();

    await run({ terminal: false });

    expect(
      sandbox.exec.mock.calls.some((c: any[]) => String(c[0]).startsWith('rm -rf')),
    ).toBe(false);
    expect(commit).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ pause: false }),
    );
  });

  it('declines a workdir snapshot without consulting anything', async () => {
    const { run, imageService, commit } = makeService();

    expect(await run({ terminal: true }, 'workdir')).toBeNull();
    expect(imageService.canCommitLive).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('declines when the feature is off', async () => {
    const { run, commit } = makeService({ canCommitLive: false });
    expect(await run()).toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });

  it('declines and asks for consolidation when layers ran out', async () => {
    const { run, commit, imageService } = makeService({ outOfHeadroom: true });

    expect(await run()).toBeNull();
    expect(commit).not.toHaveBeenCalled();
    expect(imageService.scheduleConsolidation).toHaveBeenCalled();
  });

  it('falls back to the tarball when the commit fails', async () => {
    const { run, updates } = makeService({
      commit: jest.fn().mockRejectedValue(new Error('no space left on device')),
    });

    expect(await run()).toBeNull();
    // Nothing was published: the caller goes on to write the tarball, and a
    // half-updated document would have it write under the wrong version.
    expect(setOf(updates, 'persistVersion')).toBeUndefined();
  });

  it('treats a guard that throws as a decline, not as a failed save', async () => {
    const { run, imageService } = makeService();
    imageService.canCommitLive.mockImplementation(() => {
      throw new TypeError('canCommitLive is not a function');
    });

    // The tarball path is perfectly able to complete this save; a broken guard
    // must not be what takes it down.
    expect(await run()).toBeNull();
  });

  // Releasing the claim used to `$unset` the stage unconditionally. A
  // commit-based save schedules the background pass BEFORE it returns, so by
  // the time the release ran the snapshot was already reporting `tarball` —
  // and that wipe left the field empty for the whole refresh, which on a 1 GB
  // snapshot is two and a half minutes of the UI showing nothing while the
  // durable copy is visibly behind.
  it('does not clear a background stage when the save releases its claim', async () => {
    const filtered: any[] = [];
    const service = Object.create(SnapshotsService.prototype) as SnapshotsService;
    Object.assign(service as any, {
      snapshotRepo: {
        updateById: jest.fn().mockResolvedValue({}),
        updateOne: jest.fn(async (filter: any) => {
          filtered.push(filter);
          return {};
        }),
      },
      sandboxRepo: { updateById: jest.fn().mockResolvedValue(undefined) },
      logger: { warn: jest.fn() },
    });

    await (service as any).releaseSnapshotSave(
      { _id: { toString: () => 'oid' }, snapshotId: 'snap1' },
      { _id: { toString: () => 'sbx' } },
    );

    expect(filtered).toHaveLength(1);
    const stages = filtered[0].saveStage.$in;
    expect(stages).toEqual(
      expect.arrayContaining([
        SnapshotSaveStage.COMMITTING,
        SnapshotSaveStage.CAPTURING,
      ]),
    );
    expect(stages).not.toContain(SnapshotSaveStage.TARBALL);
    expect(stages).not.toContain(SnapshotSaveStage.CONSOLIDATING);
  });

  it('reports the stages it goes through', async () => {
    const { run, updates } = makeService();

    await run({ terminal: true });

    const stages = updates.filter((u) => u.saveStage).map((u) => u.saveStage);
    expect(stages).toEqual([
      SnapshotSaveStage.CLEANING,
      SnapshotSaveStage.COMMITTING,
    ]);
  });
});
