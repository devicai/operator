import { SandboxesService } from './sandboxes.service';
import { SandboxRepository } from '../repositories/sandbox.repository';

/**
 * Exercises only the listing surface of the service: the filters an operator
 * drives from the UI, and which sort the repository is asked for. Everything
 * else is stubbed — instantiating the service directly keeps this free of the
 * Nest DI graph (runtime provider, Redis registry, ingress…).
 */
function makeService() {
  const sandboxRepo = {
    find: jest.fn().mockResolvedValue({ data: [], pagination: {} }),
    findByActivity: jest.fn().mockResolvedValue({ data: [], pagination: {} }),
  };
  const service = Object.create(SandboxesService.prototype) as SandboxesService;
  (service as any).sandboxRepo = sandboxRepo;
  return { service, sandboxRepo };
}

const filterOf = (mock: jest.Mock) => mock.mock.calls[0][0];

describe('SandboxesService.findAll', () => {
  it('sorts by activity by default so a freshly claimed pod is not buried', async () => {
    const { service, sandboxRepo } = makeService();
    await service.findAll({}, {});
    expect(sandboxRepo.findByActivity).toHaveBeenCalled();
    expect(sandboxRepo.find).not.toHaveBeenCalled();
  });

  it('falls back to raw creation order when asked', async () => {
    const { service, sandboxRepo } = makeService();
    await service.findAll({}, { sortBy: 'created' });
    expect(sandboxRepo.find).toHaveBeenCalled();
    expect(sandboxRepo.findByActivity).not.toHaveBeenCalled();
  });

  it('matches sandboxes claimed before claimedAt existed', async () => {
    const { service, sandboxRepo } = makeService();
    await service.findAll({}, { fromHotPool: true });
    expect(filterOf(sandboxRepo.findByActivity as jest.Mock).$or).toEqual(
      SandboxRepository.CLAIMED_FROM_POOL_FILTER.$or,
    );
  });

  it('excludes every pooled sandbox when asked for the never-pooled ones', async () => {
    const { service, sandboxRepo } = makeService();
    await service.findAll({}, { fromHotPool: false, hotReserved: false });
    const filter = filterOf(sandboxRepo.findByActivity as jest.Mock);
    expect(filter.$nor).toEqual([SandboxRepository.CLAIMED_FROM_POOL_FILTER]);
    expect(filter.hotReserved).toEqual({ $ne: true });
  });

  it('resolves a snapshot filter against links, restores and pool provenance', async () => {
    const { service, sandboxRepo } = makeService();
    await service.findAll({}, { snapshotId: 'snap-9' });
    expect(filterOf(sandboxRepo.findByActivity as jest.Mock).$and).toEqual([
      {
        $or: [
          { snapshotId: 'snap-9' },
          { 'metadata.restoredFrom': 'snap-9' },
          { 'metadata.hotPoolSnapshotId': 'snap-9' },
        ],
      },
    ]);
  });

  it('combines origin and snapshot filters without either clobbering the other', async () => {
    const { service, sandboxRepo } = makeService();
    await service.findAll({}, { fromHotPool: true, snapshotId: 'snap-9', status: 'running' });
    const filter = filterOf(sandboxRepo.findByActivity as jest.Mock);
    expect(filter.status).toBe('running');
    expect(filter.$or).toBeDefined(); // hot-pool origin
    expect(filter.$and).toHaveLength(1); // snapshot provenance
  });

  it('does not filter at all when no flags are given', async () => {
    const { service, sandboxRepo } = makeService();
    await service.findAll({}, { limit: 20 });
    expect(filterOf(sandboxRepo.findByActivity as jest.Mock)).toEqual({});
  });
});
