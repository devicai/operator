export interface RestoreMemoryInputs {
  /** Explicit `memoryMib` from the restore request, if any. Always wins. */
  requestedMemoryMib?: number;
  /** Memory the snapshot recorded (inherited from its source sandbox). */
  snapshotMemoryMib?: number;
  /** Global default used when the snapshot recorded nothing. */
  defaultMemoryMib: number;
  /** Floor for user restores (config: defaults.snapshotMemoryMib). */
  snapshotFloorMib?: number;
  /** Hot-reserve provisioning is exempt from the floor. */
  hotReserved: boolean;
}

/**
 * Resolve the memory (MiB) a sandbox restored from a snapshot should get.
 *
 * User restores back interactive / persistent environments that install CLIs
 * (`npm i …`), which swap and blow the 45s REST budget at the 256 MiB hot
 * slice. So a floor is applied: a restored sandbox never drops below
 * `snapshotFloorMib`. An explicit request always wins, a snapshot that recorded
 * a higher value keeps it, and hot-reserve provisioning (the on-demand pool) is
 * exempt — it stays on `hotPool.memoryMibPerSandbox`.
 */
export function resolveRestoreMemoryMib(i: RestoreMemoryInputs): number {
  if (i.requestedMemoryMib != null) return i.requestedMemoryMib;
  const inherited = i.snapshotMemoryMib ?? i.defaultMemoryMib;
  const floor = i.hotReserved ? 0 : (i.snapshotFloorMib ?? 0);
  return Math.max(inherited, floor);
}
