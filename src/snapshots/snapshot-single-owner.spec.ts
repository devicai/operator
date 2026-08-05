import { SnapshotsService } from './snapshots.service';

/**
 * One writer per snapshot.
 *
 * A linked sandbox writes its WHOLE filesystem back on stop or expiry. Two of
 * them on one snapshot is a lost update by construction: neither save merges
 * with the other, so the later one erases whatever the earlier wrote, and
 * nothing anywhere says so.
 *
 * It happened on dev exactly this way. A visit woke the public URL, which
 * restored a sandbox inside the ingress; forty-eight seconds later an assistant
 * started a session, which restored a second one through the API. Neither
 * creator could see the other. Both committed "15 layers" nine minutes apart,
 * and the second commit — built from an image taken before the first had
 * written anything — silently discarded twenty minutes of work.
 *
 * So a linked restore of a snapshot that is already running hands back the
 * sandbox that owns it. The caller wanted to work on this snapshot; it is
 * already up as something, and that something is what it gets.
 */
function makeService(over: { owner?: any; ttlDefault?: number } = {}) {
  const owner = over.owner;
  const updates: any[] = [];

  const sandboxRepo = {
    findOwningSandbox: jest.fn(async () => owner ?? null),
    updateById: jest.fn(async (_id: string, patch: any) => {
      updates.push(patch.$set ?? patch);
      return { ...owner, ...(patch.$set ?? {}) };
    }),
    create: jest.fn(),
  };

  const service = Object.create(SnapshotsService.prototype) as SnapshotsService;
  Object.assign(service as any, {
    sandboxRepo,
    config: { defaults: { defaultTtlSeconds: over.ttlDefault ?? 1800 } },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });

  return { service, sandboxRepo, updates };
}

describe('single snapshot ownership', () => {
  describe('attachToOwner', () => {
    it('pushes the TTL out when the caller asked for longer', async () => {
      const owner = {
        _id: { toString: () => 'oid' },
        sandboxId: 'live1',
        snapshotId: 'snap1',
        cpus: 2,
        memoryMib: 512,
        expiresAt: new Date(Date.now() + 60_000), // a minute left
      };
      const { service, updates } = makeService({ owner });

      await (service as any).attachToOwner(owner, { ttlSeconds: 1800 });

      // Inheriting the last minute of somebody else's session would strand the
      // caller almost immediately.
      expect(updates).toHaveLength(1);
      expect(updates[0].ttlSeconds).toBe(1800);
      expect(new Date(updates[0].expiresAt).getTime()).toBeGreaterThan(
        Date.now() + 1_700_000,
      );
    });

    it('never shortens it — the other holder is still using it', async () => {
      const owner = {
        _id: { toString: () => 'oid' },
        sandboxId: 'live1',
        snapshotId: 'snap1',
        expiresAt: new Date(Date.now() + 3_600_000), // an hour left
      };
      const { service, updates } = makeService({ owner });

      await (service as any).attachToOwner(owner, { ttlSeconds: 60 });

      expect(updates).toHaveLength(0);
    });

    it('says out loud which request could not be honoured', async () => {
      const owner = {
        _id: { toString: () => 'oid' },
        sandboxId: 'live1',
        snapshotId: 'snap1',
        cpus: 2,
        memoryMib: 512,
        expiresAt: new Date(Date.now() + 3_600_000),
      };
      const { service } = makeService({ owner });
      const logger = (service as any).logger;

      await (service as any).attachToOwner(owner, {
        ttlSeconds: 60,
        memoryMib: 2048,
      });

      // A running container cannot be resized, and pretending the request was
      // applied is how someone ends up debugging a memory limit that never
      // changed.
      const line = logger.log.mock.calls[0][0];
      expect(line).toContain('already running as sandbox live1');
      expect(line).toContain('memoryMib 2048 != 512');
    });
  });

  describe('base version guard', () => {
    // The net behind the ownership rule: whatever path a second writer arrives
    // by, a save from a base the snapshot has moved past is refused instead of
    // erasing what came after.
    function persistWith(baseVersion: any, persistVersion: number) {
      const snapshotDoc = {
        _id: { toString: () => 'oid-snap' },
        snapshotId: 'snap1',
        status: 'ready',
        persistVersion,
      };
      const errors: any[] = [];
      const service = Object.create(
        SnapshotsService.prototype,
      ) as SnapshotsService;
      Object.assign(service as any, {
        snapshotRepo: {
          findOne: jest.fn(async () => snapshotDoc),
          updateById: jest.fn(async (_id: string, patch: any) => {
            errors.push(patch.$set ?? {});
            return snapshotDoc;
          }),
          updateOne: jest.fn(async () => null),
        },
        logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      });
      const sandboxDoc = {
        _id: { toString: () => 'oid-sbx' },
        sandboxId: 'sbx1',
        snapshotId: 'snap1',
        metadata: baseVersion === undefined ? {} : { baseVersion },
      };
      return { run: () => service.persistToSnapshot(sandboxDoc as any), errors };
    }

    it('refuses a save whose base the snapshot has moved past', async () => {
      const { run, errors } = persistWith(52, 54);

      expect(await run()).toBe('conflict');
      // Silence is what made this expensive to find the first time.
      expect(errors[0]['metadata.lastSaveError']).toContain('version 52');
      expect(errors[0]['metadata.lastSaveError']).toContain('now at 54');
      expect(errors[0]['metadata.lastSaveErrorFrom']).toBe('sbx1');
    });

    it('allows a save that is level with the snapshot', async () => {
      const { run } = persistWith(54, 54);
      // Gets past the guard and on to the claim, which this stub declines.
      expect(await run()).toBe('conflict');
    });

    it('does not judge a sandbox that has no base recorded', async () => {
      // Restored before the field existed: nothing to compare, and refusing
      // every such save would be worse than the risk it guards against.
      const { run, errors } = persistWith(undefined, 54);
      await run();
      expect(errors.some((e) => e['metadata.lastSaveError'])).toBe(false);
    });
  });
});
