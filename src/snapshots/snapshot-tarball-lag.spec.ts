import { SnapshotImageService } from './snapshot-image.service';

/**
 * How far the portable tarball is behind the image.
 *
 * This number drives a warning, so it has to be right in the direction that
 * matters: claiming a snapshot is at risk when it is not teaches people to
 * ignore the warning, which costs more than not having one.
 */
function lagOf(snapshot: any): number {
  const service = Object.create(
    SnapshotImageService.prototype,
  ) as SnapshotImageService;
  return service.tarballLag(snapshot);
}

describe('tarballLag', () => {
  it('reports the gap a commit-based save opened', () => {
    expect(lagOf({ persistVersion: 36, tarballVersion: 35 })).toBe(1);
    expect(lagOf({ persistVersion: 40, tarballVersion: 35 })).toBe(5);
  });

  it('reports none once the refresh has caught up', () => {
    expect(lagOf({ persistVersion: 36, tarballVersion: 36 })).toBe(0);
  });

  // The case that produced a false alarm on dev: a snapshot last saved days
  // before commit-based saves existed. Its tarball is current — the only path
  // that ran back then wrote it — but the field is unset, and reading unset as
  // version zero turned the whole version count into a phantom lag.
  it('treats an absent tarballVersion as current, not as version zero', () => {
    expect(lagOf({ persistVersion: 2 })).toBe(0);
    expect(lagOf({ persistVersion: 2, tarballVersion: null })).toBe(0);
    expect(lagOf({ persistVersion: 34 })).toBe(0);
  });

  it('still reports a lag once the field exists, even at zero', () => {
    // Backfilled to 0 by a first commit save on a never-persisted snapshot:
    // from here on the gap is real and must be visible.
    expect(lagOf({ persistVersion: 1, tarballVersion: 0 })).toBe(1);
  });
});
