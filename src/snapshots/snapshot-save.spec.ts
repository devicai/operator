import { ConflictException } from '@nestjs/common';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SnapshotsService } from './snapshots.service';
import { SnapshotSaveState, SnapshotStatus } from '../schemas/snapshot.schema';

/**
 * Drives the save path without the Nest DI graph. The capture itself is stubbed
 * — what matters here is the claim, where the bytes land, and who is allowed to
 * touch the sandbox while a capture is running.
 */
function makeService(overrides: { snapshot?: any; claim?: any } = {}) {
  const snapshotDoc = overrides.snapshot ?? {
    _id: { toString: () => 'oid-snap' },
    snapshotId: 'snap1',
    status: SnapshotStatus.READY,
    scope: 'full',
    compression: 'gzip',
    snapshotPath: '/tmp/does-not-matter.tar.gz',
    saveState: SnapshotSaveState.IDLE,
  };

  const snapshotRepo = {
    findOne: jest.fn().mockResolvedValue(snapshotDoc),
    updateOne: jest
      .fn()
      .mockResolvedValue(
        overrides.claim === undefined ? snapshotDoc : overrides.claim,
      ),
    updateById: jest.fn().mockResolvedValue(snapshotDoc),
    updateMany: jest.fn().mockResolvedValue(0),
  };
  const sandboxRepo = { updateById: jest.fn().mockResolvedValue(undefined) };
  const registry = { get: jest.fn().mockResolvedValue(null) };
  const sandbox = { exec: jest.fn(), copyToHost: jest.fn(), diff: jest.fn() };
  const runtime = {
    get: jest.fn().mockResolvedValue({
      status: 'running',
      connect: async () => sandbox,
    }),
  };

  const service = Object.create(SnapshotsService.prototype) as SnapshotsService;
  Object.assign(service as any, {
    snapshotRepo,
    sandboxRepo,
    registry,
    runtime,
    config: {},
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  return { service, snapshotRepo, sandboxRepo, snapshotDoc };
}

const sandboxDoc = (over: Record<string, any> = {}) =>
  ({
    _id: { toString: () => 'oid-sbx' },
    sandboxId: 'sbx1',
    name: 'sandbox-sbx1',
    workdir: '/workspace',
    snapshotId: 'snap1',
    ...over,
  }) as any;

describe('persistToSnapshot', () => {
  it('claims the snapshot so a second save cannot interleave over the artifact', async () => {
    const { service, snapshotRepo } = makeService({ claim: null });

    const outcome = await service.persistToSnapshot(sandboxDoc());

    expect(outcome).toBe('conflict');
    // The claim is a compare-and-swap on saveState, not a blind write.
    const [filter, update] = snapshotRepo.updateOne.mock.calls[0];
    expect(filter.saveState).toEqual({ $ne: SnapshotSaveState.SAVING });
    expect(update.$set.saveState).toBe(SnapshotSaveState.SAVING);
  });

  it('flags the sandbox for the duration and clears it afterwards', async () => {
    const { service, sandboxRepo } = makeService();
    (service as any).captureFullToHost = jest
      .fn()
      .mockRejectedValue(new Error('boom'));

    const outcome = await service.persistToSnapshot(sandboxDoc());

    expect(outcome).toBe('failed');
    const updates = sandboxRepo.updateById.mock.calls.map(([, u]) => u);
    expect(updates[0].$set.savingSnapshotId).toBe('snap1');
    // Even when the capture blows up, the flag must not outlive it — it gates
    // stop/destroy and would strand the sandbox.
    expect(updates[updates.length - 1].$unset).toHaveProperty(
      'savingSnapshotId',
    );
  });

  it('writes to a temp file and renames, leaving the old artifact readable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'snap-save-'));
    const target = join(dir, 'snap1.tar.gz');
    writeFileSync(target, 'PREVIOUS');

    const { service } = makeService({
      snapshot: {
        _id: { toString: () => 'oid-snap' },
        snapshotId: 'snap1',
        status: SnapshotStatus.READY,
        scope: 'full',
        compression: 'gzip',
        snapshotPath: target,
        saveState: SnapshotSaveState.IDLE,
      },
    });

    let duringCapture = '';
    (service as any).captureFullToHost = jest
      .fn()
      .mockImplementation(async (_s: any, _w: any, _i: any, _c: any, tmp: string) => {
        // Mid-capture the artifact of record must still be the previous one.
        duringCapture = readFileSync(target, 'utf-8');
        writeFileSync(tmp, 'NEW');
        return { deletes: [], stats: {} };
      });

    const outcome = await service.persistToSnapshot(sandboxDoc());

    expect(outcome).toBe('saved');
    expect(duringCapture).toBe('PREVIOUS');
    expect(readFileSync(target, 'utf-8')).toBe('NEW');
    expect(existsSync(`${target}.saving-sbx1`)).toBe(false);
  });

  it('refuses to commit an empty capture over a good artifact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'snap-save-'));
    const target = join(dir, 'snap2.tar.gz');
    writeFileSync(target, 'PREVIOUS');

    const { service } = makeService({
      snapshot: {
        _id: { toString: () => 'oid-snap' },
        snapshotId: 'snap2',
        status: SnapshotStatus.READY,
        scope: 'full',
        compression: 'gzip',
        snapshotPath: target,
        saveState: SnapshotSaveState.IDLE,
      },
    });
    (service as any).captureFullToHost = jest
      .fn()
      .mockImplementation(async (_s: any, _w: any, _i: any, _c: any, tmp: string) => {
        writeFileSync(tmp, '');
        return { deletes: [], stats: {} };
      });

    const outcome = await service.persistToSnapshot(sandboxDoc());

    expect(outcome).toBe('failed');
    expect(readFileSync(target, 'utf-8')).toBe('PREVIOUS');
  });
});

describe('restore while a save is running', () => {
  const savingSnapshot = {
    snapshotId: 'snap1',
    status: SnapshotStatus.READY,
    saveState: SnapshotSaveState.SAVING,
    savingSince: new Date('2026-08-01T09:24:46Z'),
    savingSandboxId: 'sbx1',
    snapshotPath: '/tmp/none.tar.gz',
  };

  it('refuses without force, naming the code the caller can act on', async () => {
    const { service } = makeService();
    (service as any).findById = jest.fn().mockResolvedValue(savingSnapshot);

    await expect(
      (service as any).restoreInternal('snap1', {}, {}, {
        skipMemoryCheck: true,
        hotReserved: false,
      }),
    ).rejects.toMatchObject({
      response: { code: 'SNAPSHOT_SAVE_IN_PROGRESS' },
    });
  });

  it('gets past the guard with force (and then fails on the missing file)', async () => {
    // Proves the guard — and only the guard — is what force lifts: the call now
    // reaches the on-disk check instead of the 409.
    const { service } = makeService();
    (service as any).findById = jest.fn().mockResolvedValue(savingSnapshot);

    const err = await (service as any)
      .restoreInternal('snap1', { force: true }, {}, {
        skipMemoryCheck: true,
        hotReserved: false,
      })
      .catch((e: Error) => e);

    expect(err).not.toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/not found on disk/i);
  });
});
