import { HotPoolConfig } from '../config/config.types';

export interface HotPoolMetrics {
  /** Sandboxes currently parked in the pool. */
  current: number;
  /** Aggregate memory (MiB) reserved by current hot sandboxes. */
  currentMemoryMib: number;
  /**
   * How big the pool wants to be right now, given the active config and the
   * memory budget. Reconcile loops drive `current` toward this number.
   */
  target: number;
  /** Memory (MiB) the target represents (target * memoryMibPerSandbox). */
  targetMemoryMib: number;
  /** % of `resourceLimits.maxTotalMemoryMib` carved out for the pool. */
  reservedPercent: number | null;
  /** Absolute memory (MiB) reserved for the pool (target slice). */
  reservedMib: number;
  /** Total memory cap configured for the module. */
  totalLimitMib: number | null;
}

export interface HotPoolSandboxView {
  sandboxId: string;
  name: string;
  memoryMib: number;
  cpus: number;
  ageSeconds: number;
}

export interface HotPoolStatus {
  config: HotPoolConfig;
  /** Effective config after applying defaults and validating limits. */
  effective: HotPoolConfig;
  metrics: HotPoolMetrics;
  snapshot: { snapshotId: string; name: string } | null;
  hotSandboxes: HotPoolSandboxView[];
  lastReconcileAt: string | null;
  lastError: string | null;
}
