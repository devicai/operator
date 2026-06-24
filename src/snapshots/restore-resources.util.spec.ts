import { resolveRestoreMemoryMib } from './restore-resources.util';

describe('resolveRestoreMemoryMib', () => {
  const base = {
    snapshotMemoryMib: 256,
    defaultMemoryMib: 256,
    snapshotFloorMib: 512,
    hotReserved: false,
  };

  it('raises a 256 MiB hot-slice snapshot to the restore floor', () => {
    expect(resolveRestoreMemoryMib(base)).toBe(512);
  });

  it('keeps a snapshot value already above the floor', () => {
    expect(
      resolveRestoreMemoryMib({ ...base, snapshotMemoryMib: 1024 }),
    ).toBe(1024);
  });

  it('honours an explicit request even below the floor', () => {
    expect(
      resolveRestoreMemoryMib({ ...base, requestedMemoryMib: 256 }),
    ).toBe(256);
  });

  it('honours an explicit request above the floor', () => {
    expect(
      resolveRestoreMemoryMib({ ...base, requestedMemoryMib: 2048 }),
    ).toBe(2048);
  });

  it('exempts hot-reserve provisioning from the floor', () => {
    expect(resolveRestoreMemoryMib({ ...base, hotReserved: true })).toBe(256);
  });

  it('falls back to the global default when the snapshot recorded nothing', () => {
    expect(
      resolveRestoreMemoryMib({
        ...base,
        snapshotMemoryMib: undefined,
        snapshotFloorMib: 0,
      }),
    ).toBe(256);
  });

  it('treats a missing floor as no floor', () => {
    expect(
      resolveRestoreMemoryMib({ ...base, snapshotFloorMib: undefined }),
    ).toBe(256);
  });
});
