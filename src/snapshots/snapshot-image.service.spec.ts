import { Test, TestingModule } from '@nestjs/testing';
import { CONFIG } from '../config/config.loader';
import { ModuleConfig } from '../config/config.types';
import { SnapshotRepository } from '../repositories/snapshot.repository';
import { RUNTIME_PROVIDER } from '../runtime/runtime-provider.interface';
import { SnapshotImageService } from './snapshot-image.service';

function buildConfig(imageCache?: any): ModuleConfig {
  return {
    server: { port: 3200, basePath: '/api/v1' },
    database: { provider: 'mongodb', uri: 'mongodb://localhost/test' },
    redis: { url: 'redis://localhost' },
    defaults: {
      defaultImage: 'node:24',
      defaultCpus: 1,
      defaultMemoryMib: 256,
      defaultTtlSeconds: 1800,
      maxTtlSeconds: 7200,
      ttlCheckIntervalMs: 30000,
    },
    runtime: { type: 'docker', docker: {} },
    snapshots: { imageCache: imageCache ?? { enabled: true } },
    mcp: { enabled: true },
    extensions: { properties: [] },
    auth: { enabled: false, strategy: 'none' },
    logging: { level: 'info', format: 'json' },
  } as ModuleConfig;
}

function snapshotDoc(overrides: Record<string, any> = {}) {
  return {
    _id: { toString: () => 'oid-1' },
    snapshotId: 'snap1',
    image: 'node:24',
    workdir: '/workspace',
    cpus: 1,
    memoryMib: 512,
    envVars: {},
    scope: 'full',
    compression: 'gzip',
    persistVersion: 3,
    ...overrides,
  } as any;
}

async function build(
  config: ModuleConfig,
  runtime: Record<string, any>,
  repo: Record<string, any>,
) {
  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [
      SnapshotImageService,
      { provide: CONFIG, useValue: config },
      { provide: RUNTIME_PROVIDER, useValue: runtime },
      { provide: SnapshotRepository, useValue: repo },
    ],
  }).compile();
  return moduleRef.get(SnapshotImageService);
}

function baseRuntime(over: Record<string, any> = {}) {
  return {
    commitImage: jest.fn().mockResolvedValue({
      ref: 'devic-snapshot:snap1',
      uniqueSizeBytes: 100,
      layers: 9,
    }),
    imageExists: jest.fn().mockResolvedValue(true),
    removeImage: jest.fn().mockResolvedValue(true),
    listSnapshotImages: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({}),
    remove: jest.fn().mockResolvedValue(undefined),
    ...over,
  };
}

function baseRepo(over: Record<string, any> = {}) {
  return {
    updateById: jest.fn().mockResolvedValue(undefined),
    findOne: jest.fn().mockResolvedValue(snapshotDoc()),
    find: jest.fn().mockResolvedValue({ data: [] }),
    ...over,
  };
}

describe('SnapshotImageService', () => {
  describe('isUsable', () => {
    it('refuses an image built from an older capture', async () => {
      // The tarball has moved on. Serving this image would hand back content
      // the snapshot no longer describes — silently, and with no way to notice.
      const svc = await build(buildConfig(), baseRuntime(), baseRepo());
      const usable = await svc.isUsable(
        snapshotDoc({
          imageState: 'ready',
          imageRef: 'devic-snapshot:snap1',
          imageSourceVersion: 2,
          persistVersion: 3,
        }),
      );
      expect(usable).toBe(false);
    });

    it('refuses when the image is no longer on the daemon', async () => {
      const runtime = baseRuntime({
        imageExists: jest.fn().mockResolvedValue(false),
      });
      const svc = await build(buildConfig(), runtime, baseRepo());
      expect(
        await svc.isUsable(
          snapshotDoc({
            imageState: 'ready',
            imageRef: 'devic-snapshot:snap1',
            imageSourceVersion: 3,
          }),
        ),
      ).toBe(false);
    });

    it('accepts when state, version and daemon all agree', async () => {
      const svc = await build(buildConfig(), baseRuntime(), baseRepo());
      expect(
        await svc.isUsable(
          snapshotDoc({
            imageState: 'ready',
            imageRef: 'devic-snapshot:snap1',
            imageSourceVersion: 3,
          }),
        ),
      ).toBe(true);
    });

    it('is inert while disabled', async () => {
      const svc = await build(
        buildConfig({ enabled: false }),
        baseRuntime(),
        baseRepo(),
      );
      expect(
        await svc.isUsable(
          snapshotDoc({
            imageState: 'ready',
            imageRef: 'devic-snapshot:snap1',
            imageSourceVersion: 3,
          }),
        ),
      ).toBe(false);
    });
  });

  describe('build', () => {
    it('builds on the ORIGINAL base image, never on a previous snapshot image', async () => {
      // This is what keeps depth pinned at base+1. Committing on top of
      // devic-snapshot:snap1 would add a layer per persist, and at 71 layers
      // the image stops being startable under sysbox-runc.
      const runtime = baseRuntime();
      const svc = await build(buildConfig(), runtime, baseRepo());
      svc.registerTarballApplier(async () => undefined);

      await svc.build(
        snapshotDoc({
          imageRef: 'devic-snapshot:snap1',
          imageState: 'ready',
        }),
      );

      expect(runtime.create).toHaveBeenCalledWith(
        expect.objectContaining({ image: 'node:24' }),
      );
    });

    it('publishes the image and records the version it came from', async () => {
      const runtime = baseRuntime();
      const repo = baseRepo();
      const svc = await build(buildConfig(), runtime, repo);
      svc.registerTarballApplier(async () => undefined);

      await svc.build(snapshotDoc());

      expect(repo.updateById).toHaveBeenCalledWith(
        'oid-1',
        expect.objectContaining({
          $set: expect.objectContaining({
            imageState: 'ready',
            imageRef: 'devic-snapshot:snap1',
            imageSourceVersion: 3,
          }),
        }),
        {},
      );
    });

    it('throws away a build that a newer capture overtook', async () => {
      // A second persist landed while this build was running. Committing now
      // would publish stale content under a tag the restore path trusts.
      const runtime = baseRuntime();
      const repo = baseRepo({
        findOne: jest.fn().mockResolvedValue(snapshotDoc({ persistVersion: 4 })),
      });
      const svc = await build(buildConfig(), runtime, repo);
      svc.registerTarballApplier(async () => undefined);

      await svc.build(snapshotDoc({ persistVersion: 3 }));

      expect(runtime.commitImage).not.toHaveBeenCalled();
      expect(repo.updateById).toHaveBeenCalledWith(
        'oid-1',
        { $set: { imageState: 'none' } },
        {},
      );
    });

    it('marks the snapshot failed and removes the helper when extraction throws', async () => {
      const runtime = baseRuntime();
      const repo = baseRepo();
      const svc = await build(buildConfig(), runtime, repo);
      svc.registerTarballApplier(async () => {
        throw new Error('tar exploded');
      });

      await svc.build(snapshotDoc());

      expect(repo.updateById).toHaveBeenCalledWith(
        'oid-1',
        { $set: { imageState: 'failed' } },
        {},
      );
      expect(runtime.remove).toHaveBeenCalled();
      expect(runtime.commitImage).not.toHaveBeenCalled();
    });

    it('removes the throwaway container even when the build succeeds', async () => {
      const runtime = baseRuntime();
      const svc = await build(buildConfig(), runtime, baseRepo());
      svc.registerTarballApplier(async () => undefined);
      await svc.build(snapshotDoc());
      expect(runtime.remove).toHaveBeenCalled();
    });

    it('does not start a second build for a snapshot already building', async () => {
      const runtime = baseRuntime();
      const svc = await build(buildConfig(), runtime, baseRepo());
      let release: () => void = () => undefined;
      let entered: () => void = () => undefined;
      const inApplier = new Promise<void>((r) => (entered = r));
      svc.registerTarballApplier(() => {
        entered();
        return new Promise<void>((r) => (release = r));
      });

      const first = svc.build(snapshotDoc());
      // Let the first build get as far as the extraction before racing it,
      // otherwise it is still awaiting its own status write and has not
      // created anything yet.
      await inApplier;

      await svc.build(snapshotDoc());
      expect(runtime.create).toHaveBeenCalledTimes(1);

      release();
      await first;
    });
  });

  describe('enforceCap', () => {
    it('evicts least recently restored first and stops once under the cap', async () => {
      const runtime = baseRuntime({
        listSnapshotImages: jest.fn().mockResolvedValue([
          { ref: 'devic-snapshot:old', tag: 'old', uniqueSizeBytes: 60, createdAtMs: 1, inUse: false },
          { ref: 'devic-snapshot:mid', tag: 'mid', uniqueSizeBytes: 60, createdAtMs: 2, inUse: false },
          { ref: 'devic-snapshot:new', tag: 'new', uniqueSizeBytes: 60, createdAtMs: 3, inUse: false },
        ]),
      });
      const repo = baseRepo({
        find: jest.fn().mockResolvedValue({
          data: [
            { snapshotId: 'old', imageLastUsedAt: new Date(1000) },
            { snapshotId: 'mid', imageLastUsedAt: new Date(2000) },
            { snapshotId: 'new', imageLastUsedAt: new Date(3000) },
          ],
        }),
        findOne: jest.fn().mockResolvedValue(null),
      });
      const svc = await build(
        buildConfig({ enabled: true, maxTotalBytes: 100 }),
        runtime,
        repo,
      );

      await svc.enforceCap();

      // 180 total against a cap of 100: dropping 'old' and 'mid' suffices.
      expect(runtime.removeImage).toHaveBeenCalledWith('devic-snapshot:old');
      expect(runtime.removeImage).toHaveBeenCalledWith('devic-snapshot:mid');
      expect(runtime.removeImage).not.toHaveBeenCalledWith('devic-snapshot:new');
    });

    it('never evicts an image a live sandbox is running from', async () => {
      const runtime = baseRuntime({
        listSnapshotImages: jest.fn().mockResolvedValue([
          { ref: 'devic-snapshot:busy', tag: 'busy', uniqueSizeBytes: 500, createdAtMs: 1, inUse: true },
        ]),
      });
      const svc = await build(
        buildConfig({ enabled: true, maxTotalBytes: 10 }),
        runtime,
        baseRepo({ findOne: jest.fn().mockResolvedValue(null) }),
      );

      await svc.enforceCap();
      expect(runtime.removeImage).not.toHaveBeenCalled();
    });

    it('does nothing without a cap', async () => {
      const runtime = baseRuntime();
      const svc = await build(buildConfig({ enabled: true }), runtime, baseRepo());
      await svc.enforceCap();
      expect(runtime.listSnapshotImages).not.toHaveBeenCalled();
    });
  });

  describe('reclaimOrphans', () => {
    it('removes an image whose snapshot is gone and keeps the rest', async () => {
      const runtime = baseRuntime({
        listSnapshotImages: jest.fn().mockResolvedValue([
          { ref: 'devic-snapshot:gone', tag: 'gone', uniqueSizeBytes: 500, inUse: false },
          { ref: 'devic-snapshot:live', tag: 'live', uniqueSizeBytes: 700, inUse: false },
        ]),
      });
      // Only 'live' still has a snapshot behind it.
      const repo = baseRepo({
        find: jest.fn().mockResolvedValue({
          data: [{ snapshotId: 'live' }],
        }),
      });
      const svc = await build(buildConfig({ enabled: true }), runtime, repo);

      await svc.reclaimOrphans();

      expect(runtime.removeImage).toHaveBeenCalledWith('devic-snapshot:gone');
      expect(runtime.removeImage).not.toHaveBeenCalledWith('devic-snapshot:live');
    });

    it('collects garbage even with no cap configured', async () => {
      // The whole point: enforceCap returns early without a cap, so orphans
      // would otherwise be kept forever.
      const runtime = baseRuntime({
        listSnapshotImages: jest.fn().mockResolvedValue([
          { ref: 'devic-snapshot:gone', tag: 'gone', uniqueSizeBytes: 500, inUse: false },
        ]),
      });
      const svc = await build(
        buildConfig({ enabled: true }),
        runtime,
        baseRepo({ find: jest.fn().mockResolvedValue({ data: [] }) }),
      );

      await svc.reclaimOrphans();

      expect(runtime.removeImage).toHaveBeenCalledWith('devic-snapshot:gone');
    });

    it('leaves an orphan a container still holds, for the next sweep', async () => {
      // Exactly what was observed on dev: the snapshot was deleted while its
      // stopped sandbox container still referenced the image. The daemon would
      // refuse, so do not even ask — and do not log a failure every sweep.
      const runtime = baseRuntime({
        listSnapshotImages: jest.fn().mockResolvedValue([
          { ref: 'devic-snapshot:gone', tag: 'gone', uniqueSizeBytes: 500, inUse: true },
        ]),
      });
      const svc = await build(
        buildConfig({ enabled: true }),
        runtime,
        baseRepo({ find: jest.fn().mockResolvedValue({ data: [] }) }),
      );

      await svc.reclaimOrphans();

      expect(runtime.removeImage).not.toHaveBeenCalled();
    });

    it('does nothing when the cache is off', async () => {
      const runtime = baseRuntime();
      const svc = await build(
        buildConfig({ enabled: false }),
        runtime,
        baseRepo(),
      );
      await svc.reclaimOrphans();
      expect(runtime.listSnapshotImages).not.toHaveBeenCalled();
    });

    it('survives a daemon that fails mid-reclaim', async () => {
      const runtime = baseRuntime({
        listSnapshotImages: jest
          .fn()
          .mockRejectedValue(new Error('daemon unreachable')),
      });
      const svc = await build(buildConfig({ enabled: true }), runtime, baseRepo());
      await expect(svc.reclaimOrphans()).resolves.toBeUndefined();
    });
  });
});
