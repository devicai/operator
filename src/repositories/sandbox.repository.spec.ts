import { SandboxRepository } from './sandbox.repository';
import { SandboxStatus } from '../schemas/sandbox.schema';

function makeRepository(claimResult: unknown = { sandboxId: 'abc' }) {
  const exec = jest.fn().mockResolvedValue(claimResult);
  const model: any = {
    findOneAndUpdate: jest.fn().mockReturnValue({ exec }),
    aggregate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue([]) }),
    countDocuments: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(0) }),
  };
  // No extension properties -> applyScope is a no-op.
  const repo = new SandboxRepository(model, []);
  return { repo, model };
}

describe('SandboxRepository.atomicClaimHot', () => {
  it('replaces the pool placeholder TTL with the lifetime the caller asked for', async () => {
    const { repo, model } = makeRepository();
    const before = Date.now();

    await repo.atomicClaimHot('snap-1', {
      ttlSeconds: 300,
      maxTtlSeconds: 86400,
      bindingId: 'session-7',
    });

    const [filter, update] = model.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({
      hotReserved: true,
      status: SandboxStatus.RUNNING,
      'metadata.hotPoolSnapshotId': 'snap-1',
    });
    expect(update.$set.ttlSeconds).toBe(300);
    expect(update.$set.hotReserved).toBe(false);
    expect(update.$set.bindingId).toBe('session-7');

    const expiresIn = update.$set.expiresAt.getTime() - before;
    expect(expiresIn).toBeGreaterThan(299_000);
    expect(expiresIn).toBeLessThan(301_000);
  });

  it('caps the granted TTL at the module maximum', async () => {
    const { repo, model } = makeRepository();
    await repo.atomicClaimHot('snap-1', {
      ttlSeconds: 60 * 60 * 24 * 365,
      maxTtlSeconds: 1800,
    });
    expect(model.findOneAndUpdate.mock.calls[0][1].$set.ttlSeconds).toBe(1800);
  });

  it('marks the claim so a served sandbox is distinguishable from a cold start', async () => {
    const { repo, model } = makeRepository();
    await repo.atomicClaimHot('snap-1', { ttlSeconds: 300, maxTtlSeconds: 1800 });

    const { $set } = model.findOneAndUpdate.mock.calls[0][1];
    expect($set.claimedFromHotPool).toBe(true);
    expect($set.claimedAt).toBeInstanceOf(Date);
    // Legacy readers still find the timestamp in the metadata bag.
    expect($set['metadata.hotClaimedAt']).toBe($set.claimedAt.toISOString());
  });

  it('leaves bindingId untouched when the caller does not supply one', async () => {
    const { repo, model } = makeRepository();
    await repo.atomicClaimHot('snap-1', { ttlSeconds: 300, maxTtlSeconds: 1800 });
    expect(model.findOneAndUpdate.mock.calls[0][1].$set).not.toHaveProperty(
      'bindingId',
    );
  });
});

describe('SandboxRepository.findByActivity', () => {
  it('sorts by claim time, falling back to creation for never-pooled sandboxes', async () => {
    const { repo, model } = makeRepository();
    await repo.findByActivity({ status: 'running' } as any, {}, {
      limit: 50,
      offset: 100,
    });

    const pipeline = model.aggregate.mock.calls[0][0];
    expect(pipeline[0]).toEqual({ $match: { status: 'running' } });
    expect(pipeline[1].$addFields.activityAt.$ifNull).toEqual([
      '$claimedAt',
      { $toDate: '$metadata.hotClaimedAt' },
      '$createdAt',
    ]);
    expect(pipeline[2]).toEqual({ $sort: { activityAt: -1, _id: -1 } });
    expect(pipeline[3]).toEqual({ $skip: 100 });
    expect(pipeline[4]).toEqual({ $limit: 50 });
  });

  it('reports totals over the whole filtered set, not just the page', async () => {
    const { repo, model } = makeRepository();
    model.countDocuments.mockReturnValue({
      exec: jest.fn().mockResolvedValue(482),
    });

    const page = await repo.findByActivity({} as any, {}, { limit: 20, offset: 40 });

    expect(page.pagination).toEqual({
      total: 482,
      limit: 20,
      offset: 40,
      hasMore: true,
    });
  });
});
