import { Test, TestingModule } from '@nestjs/testing';
import { CONFIG } from '../config/config.loader';
import { ModuleConfig } from '../config/config.types';
import { DockerRuntimeProvider } from './docker.runtime-provider';

const createContainer = jest.fn();
const getContainer = jest.fn();
const getImage = jest.fn();
const listImages = jest.fn();
const listContainers = jest.fn();
const df = jest.fn();
const info = jest.fn();

jest.mock('dockerode', () =>
  jest.fn().mockImplementation(() => ({
    createContainer,
    getContainer,
    getImage,
    listImages,
    listContainers,
    df,
    info,
    modem: { followProgress: jest.fn() },
  })),
);

function buildConfig(runtime = 'sysbox-runc'): ModuleConfig {
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
    runtime: {
      type: 'docker',
      docker: { socketPath: '/var/run/docker.sock', runtime, network: 'bridge' },
    },
    mcp: { enabled: true },
    extensions: { properties: [] },
    auth: { enabled: false, strategy: 'none' },
    logging: { level: 'info', format: 'json' },
  } as ModuleConfig;
}

async function buildProvider(config: ModuleConfig = buildConfig()) {
  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [DockerRuntimeProvider, { provide: CONFIG, useValue: config }],
  }).compile();
  return moduleRef.get(DockerRuntimeProvider);
}

describe('DockerRuntimeProvider — snapshot image cache', () => {
  beforeEach(() => {
    createContainer.mockReset();
    getContainer.mockReset();
    getImage.mockReset();
    listImages.mockReset();
    listContainers.mockReset();
    df.mockReset();
    info.mockReset();
    info.mockResolvedValue({ SecurityOptions: [] });
    df.mockResolvedValue({ Images: [] });
    listContainers.mockResolvedValue([]);
  });

  describe('commitImage', () => {
    it('commits, charges only the delta over the base image, and tags repo:tag', async () => {
      const commit = jest.fn().mockResolvedValue({});
      getContainer.mockReturnValue({ commit });
      // Real numbers from a local commit: the image inspects at 425 820 532
      // and its node:24 parent at 399 603 014, a true delta of 26 217 518 —
      // which matched the tarball that produced it to the byte.
      getImage.mockImplementation((ref: string) => ({
        inspect: jest.fn().mockResolvedValue(
          ref === 'sha256:base'
            ? { Id: 'sha256:base', Size: 399_603_014 }
            : {
                Id: 'sha256:new',
                Size: 425_820_532,
                Parent: 'sha256:base',
                RootFS: { Layers: new Array(9).fill('l') },
              },
        ),
      }));

      const provider = await buildProvider();
      const out = await provider.commitImage('helper-1', 'devic-snapshot:abc', {
        'devic-sandbox.snapshot': 'abc',
      });

      expect(commit).toHaveBeenCalledWith(
        expect.objectContaining({ repo: 'devic-snapshot', tag: 'abc' }),
      );
      expect(out.layers).toBe(9);
      expect(out.uniqueSizeBytes).toBe(26_217_518);
    });

    it('charges the whole image when it has no parent to subtract', async () => {
      getContainer.mockReturnValue({ commit: jest.fn().mockResolvedValue({}) });
      getImage.mockReturnValue({
        inspect: jest.fn().mockResolvedValue({
          Id: 'sha256:orphan',
          Size: 1000,
          RootFS: { Layers: ['a'] },
        }),
      });
      const provider = await buildProvider();
      await expect(
        provider.commitImage('h', 'devic-snapshot:orphan'),
      ).resolves.toMatchObject({ uniqueSizeBytes: 1000 });
    });

    it('discards a commit at the layer ceiling instead of publishing an unstartable image', async () => {
      // 71 layers is measured to fail `docker start` under sysbox-runc while 70
      // works. Publishing it would hand out a snapshot that commits cleanly and
      // then refuses to boot, with an opaque OCI error and no clue why.
      const remove = jest.fn().mockResolvedValue({});
      getContainer.mockReturnValue({ commit: jest.fn().mockResolvedValue({}) });
      getImage.mockReturnValue({
        inspect: jest.fn().mockResolvedValue({
          Id: 'sha256:deep',
          RootFS: { Layers: new Array(71).fill('l') },
        }),
        remove,
      });

      const provider = await buildProvider();
      await expect(
        provider.commitImage('helper-1', 'devic-snapshot:deep'),
      ).rejects.toThrow(/71 layers/);
      expect(remove).toHaveBeenCalled();
    });

    it('accepts an image exactly at the last known-good depth', async () => {
      getContainer.mockReturnValue({ commit: jest.fn().mockResolvedValue({}) });
      getImage.mockReturnValue({
        inspect: jest.fn().mockResolvedValue({
          Id: 'sha256:ok',
          RootFS: { Layers: new Array(69).fill('l') },
        }),
      });
      const provider = await buildProvider();
      await expect(
        provider.commitImage('h', 'devic-snapshot:ok'),
      ).resolves.toMatchObject({ layers: 69 });
    });
  });

  describe('removeImage', () => {
    it('reports success when the image is already gone', async () => {
      getImage.mockReturnValue({
        remove: jest.fn().mockRejectedValue({ statusCode: 404 }),
      });
      const provider = await buildProvider();
      expect(await provider.removeImage('devic-snapshot:x')).toBe(true);
    });

    it('reports failure when a container still holds the image', async () => {
      getImage.mockReturnValue({
        remove: jest
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('conflict: container is using it'), {
              statusCode: 409,
            }),
          ),
      });
      const provider = await buildProvider();
      expect(await provider.removeImage('devic-snapshot:x')).toBe(false);
    });
  });

  describe('listSnapshotImages', () => {
    it('keeps only the configured repository and flags images held by a container', async () => {
      listImages.mockResolvedValue([
        {
          Id: 'sha256:a',
          Created: 1000,
          RepoTags: ['devic-snapshot:aaa', 'other/repo:zzz'],
        },
        { Id: 'sha256:b', Created: 2000, RepoTags: ['devic-snapshot:bbb'] },
      ]);
      listContainers.mockResolvedValue([{ ImageID: 'sha256:b' }]);
      getImage.mockImplementation((ref: string) => ({
        inspect: jest.fn().mockResolvedValue(
          ref === 'devic-snapshot:aaa'
            ? { Id: 'sha256:a', Size: 500, Parent: 'sha256:p' }
            : ref === 'devic-snapshot:bbb'
              ? { Id: 'sha256:b', Size: 900, Parent: 'sha256:p' }
              : { Id: 'sha256:p', Size: 100 },
        ),
      }));

      const provider = await buildProvider();
      const out = await provider.listSnapshotImages('devic-snapshot');

      expect(out.map((i) => i.tag).sort()).toEqual(['aaa', 'bbb']);
      expect(out.find((i) => i.tag === 'aaa')).toMatchObject({
        uniqueSizeBytes: 400,
        inUse: false,
      });
      expect(out.find((i) => i.tag === 'bbb')).toMatchObject({
        uniqueSizeBytes: 800,
        inUse: true,
      });
    });

    it('splits a reference whose registry host carries a port', async () => {
      listImages.mockResolvedValue([
        {
          Id: 'sha256:c',
          Created: 1,
          RepoTags: ['reg.example.com:5000/devic-snapshot:ccc'],
        },
      ]);
      const provider = await buildProvider();
      const out = await provider.listSnapshotImages(
        'reg.example.com:5000/devic-snapshot',
      );
      expect(out).toHaveLength(1);
      expect(out[0].tag).toBe('ccc');
    });
  });

  describe('diff with a declared baseline', () => {
    it('ignores docker diff and walks against the declared base image', async () => {
      // The container runs devic-snapshot:abc but its tarball must stay a diff
      // against node:24. `docker diff` can only compare against the image the
      // container was created from, so it must not be consulted here at all.
      const changes = jest.fn().mockResolvedValue([{ Path: '/x', Kind: 1 }]);
      getContainer.mockReturnValue({
        inspect: jest.fn().mockResolvedValue({
          State: { Status: 'running' },
          Config: {
            Image: 'devic-snapshot:abc',
            Labels: { 'devic-sandbox.diff-baseline': 'node:24' },
          },
        }),
        changes,
      });

      // runc: without a baseline this would have gone straight to changes().
      const provider = await buildProvider(buildConfig('runc'));
      const spy = jest
        .spyOn(provider as any, 'getBaseManifest')
        .mockResolvedValue(new Map());
      const handle = await provider.get('box');
      const sandbox = await handle!.connect();
      await sandbox.diff().catch(() => undefined);

      expect(spy).toHaveBeenCalledWith('node:24');
      expect(changes).not.toHaveBeenCalled();
    });
  });
});
