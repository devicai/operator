import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { promises as fsp } from 'fs';
import { CONFIG } from '../config/config.loader';
import { ModuleConfig } from '../config/config.types';
import { Sandbox, SandboxStatus } from '../schemas/sandbox.schema';
import { Snapshot, SnapshotStatus } from '../schemas/snapshot.schema';
import { ResourceUsageService } from './resource-usage.service';

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  promises: { stat: jest.fn() },
}));

const mockedStat = fsp.stat as unknown as jest.Mock;

function buildSandboxModelMock(aggregateResult: { total: number }[] = []) {
  return {
    aggregate: jest.fn().mockResolvedValue(aggregateResult),
  };
}

function buildSnapshotModelMock(snapshots: Array<{ snapshotPath: string }> = []) {
  return {
    find: jest.fn().mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve(snapshots) }),
    }),
  };
}

function buildConfig(limits?: ModuleConfig['resourceLimits']): ModuleConfig {
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
    runtime: { type: 'microsandbox' },
    mcp: { enabled: true },
    extensions: { properties: [] },
    auth: { enabled: false, strategy: 'none' },
    logging: { level: 'info', format: 'json' },
    resourceLimits: limits,
  };
}

async function buildService(opts: {
  sandboxAgg?: { total: number }[];
  snapshots?: Array<{ snapshotPath: string }>;
  limits?: ModuleConfig['resourceLimits'];
}) {
  const sandboxModel = buildSandboxModelMock(opts.sandboxAgg);
  const snapshotModel = buildSnapshotModelMock(opts.snapshots);

  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [
      ResourceUsageService,
      { provide: getModelToken(Sandbox.name), useValue: sandboxModel },
      { provide: getModelToken(Snapshot.name), useValue: snapshotModel },
      { provide: CONFIG, useValue: buildConfig(opts.limits) },
    ],
  }).compile();

  return {
    service: moduleRef.get(ResourceUsageService),
    sandboxModel,
    snapshotModel,
  };
}

describe('ResourceUsageService', () => {
  beforeEach(() => {
    mockedStat.mockReset();
  });

  describe('getTotalMemoryMib', () => {
    it('returns 0 when no active sandboxes exist', async () => {
      const { service } = await buildService({ sandboxAgg: [] });
      expect(await service.getTotalMemoryMib()).toBe(0);
    });

    it('returns the aggregated memoryMib from active sandboxes', async () => {
      const { service, sandboxModel } = await buildService({
        sandboxAgg: [{ total: 1280 }],
      });
      expect(await service.getTotalMemoryMib()).toBe(1280);

      const aggregateCall = sandboxModel.aggregate.mock.calls[0][0];
      expect(aggregateCall[0].$match.status.$in).toEqual([
        SandboxStatus.PENDING,
        SandboxStatus.CREATING,
        SandboxStatus.RUNNING,
        SandboxStatus.STOPPING,
      ]);
      expect(aggregateCall[1].$group.total).toEqual({ $sum: '$memoryMib' });
    });
  });

  describe('getTotalSnapshotBytes', () => {
    it('returns 0 when there are no ready snapshots', async () => {
      const { service } = await buildService({ snapshots: [] });
      expect(await service.getTotalSnapshotBytes()).toBe(0);
      expect(mockedStat).not.toHaveBeenCalled();
    });

    it('only queries snapshots in ready status', async () => {
      const { service, snapshotModel } = await buildService({
        snapshots: [{ snapshotPath: '/tmp/a.tar.gz' }],
      });
      mockedStat.mockResolvedValue({ size: 100 });

      await service.getTotalSnapshotBytes();
      const filter = snapshotModel.find.mock.calls[0][0];
      expect(filter).toEqual({ status: SnapshotStatus.READY });
    });

    it('sums real file sizes from disk via fs.stat', async () => {
      const { service } = await buildService({
        snapshots: [
          { snapshotPath: '/tmp/a.tar.gz' },
          { snapshotPath: '/tmp/b.tar.gz' },
          { snapshotPath: '/tmp/c.tar.gz' },
        ],
      });
      mockedStat
        .mockResolvedValueOnce({ size: 1_000_000 })
        .mockResolvedValueOnce({ size: 2_500_000 })
        .mockResolvedValueOnce({ size: 500_000 });

      expect(await service.getTotalSnapshotBytes()).toBe(4_000_000);
      expect(mockedStat).toHaveBeenCalledTimes(3);
    });

    it('treats missing files as zero bytes (no throw)', async () => {
      const { service } = await buildService({
        snapshots: [
          { snapshotPath: '/tmp/exists.tar.gz' },
          { snapshotPath: '/tmp/missing.tar.gz' },
        ],
      });
      mockedStat
        .mockResolvedValueOnce({ size: 4096 })
        .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      expect(await service.getTotalSnapshotBytes()).toBe(4096);
    });
  });

  describe('assertMemoryAvailable', () => {
    it('is a no-op when no limit is configured', async () => {
      const { service, sandboxModel } = await buildService({});
      await expect(service.assertMemoryAvailable(99999)).resolves.toBeUndefined();
      expect(sandboxModel.aggregate).not.toHaveBeenCalled();
    });

    it('is a no-op when the limit is zero', async () => {
      const { service, sandboxModel } = await buildService({
        limits: { maxTotalMemoryMib: 0 },
      });
      await expect(service.assertMemoryAvailable(99999)).resolves.toBeUndefined();
      expect(sandboxModel.aggregate).not.toHaveBeenCalled();
    });

    it('passes when projected total is under the limit', async () => {
      const { service } = await buildService({
        sandboxAgg: [{ total: 700 }],
        limits: { maxTotalMemoryMib: 1024 },
      });
      await expect(service.assertMemoryAvailable(256)).resolves.toBeUndefined();
    });

    it('passes when projected total exactly equals the limit', async () => {
      const { service } = await buildService({
        sandboxAgg: [{ total: 768 }],
        limits: { maxTotalMemoryMib: 1024 },
      });
      await expect(service.assertMemoryAvailable(256)).resolves.toBeUndefined();
    });

    it('throws BadRequestException when the projected total exceeds the limit', async () => {
      const { service } = await buildService({
        sandboxAgg: [{ total: 900 }],
        limits: { maxTotalMemoryMib: 1024 },
      });
      await expect(service.assertMemoryAvailable(256)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.assertMemoryAvailable(256)).rejects.toThrow(
        /requested 256 MiB \+ in-use 900 MiB/,
      );
    });

    it('throws even when the request alone exceeds the limit on an empty cluster', async () => {
      const { service } = await buildService({
        sandboxAgg: [],
        limits: { maxTotalMemoryMib: 1024 },
      });
      await expect(service.assertMemoryAvailable(2048)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('assertDiskAvailable', () => {
    it('is a no-op when no limit is configured', async () => {
      const { service, snapshotModel } = await buildService({});
      await expect(service.assertDiskAvailable()).resolves.toBeUndefined();
      expect(snapshotModel.find).not.toHaveBeenCalled();
    });

    it('passes when current usage is below the limit', async () => {
      const { service } = await buildService({
        snapshots: [{ snapshotPath: '/tmp/a.tar.gz' }],
        limits: { maxTotalDiskBytes: 10_000 },
      });
      mockedStat.mockResolvedValue({ size: 5_000 });
      await expect(service.assertDiskAvailable()).resolves.toBeUndefined();
    });

    it('throws when current usage already meets the limit', async () => {
      const { service } = await buildService({
        snapshots: [{ snapshotPath: '/tmp/a.tar.gz' }],
        limits: { maxTotalDiskBytes: 10_000 },
      });
      mockedStat.mockResolvedValue({ size: 10_000 });
      await expect(service.assertDiskAvailable()).rejects.toThrow(BadRequestException);
    });

    it('throws when current usage exceeds the limit', async () => {
      const { service } = await buildService({
        snapshots: [{ snapshotPath: '/tmp/a.tar.gz' }],
        limits: { maxTotalDiskBytes: 10_000 },
      });
      mockedStat.mockResolvedValue({ size: 15_000 });
      await expect(service.assertDiskAvailable()).rejects.toThrow(
        /Disk limit exceeded/,
      );
    });
  });

  describe('getUsageSummary', () => {
    it('combines memory and disk usage with their configured limits', async () => {
      const { service } = await buildService({
        sandboxAgg: [{ total: 512 }],
        snapshots: [{ snapshotPath: '/tmp/a.tar.gz' }],
        limits: { maxTotalMemoryMib: 1024, maxTotalDiskBytes: 4096 },
      });
      mockedStat.mockResolvedValue({ size: 1024 });

      expect(await service.getUsageSummary()).toEqual({
        memory: { usedMib: 512, limitMib: 1024 },
        disk: { usedBytes: 1024, limitBytes: 4096 },
      });
    });

    it('reports null limits when no resourceLimits section is configured', async () => {
      const { service } = await buildService({
        sandboxAgg: [{ total: 0 }],
        snapshots: [],
      });
      expect(await service.getUsageSummary()).toEqual({
        memory: { usedMib: 0, limitMib: null },
        disk: { usedBytes: 0, limitBytes: null },
      });
    });
  });
});
