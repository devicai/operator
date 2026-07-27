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
  /**
   * Total successful claims served by this process since boot. Resets when
   * the service restarts — it's a runtime counter, not a persisted total.
   */
  totalClaims: number;
  /** ISO timestamp of the most recent successful claim, or null. */
  lastClaimedAt: string | null;
}

export interface HotPoolSandboxView {
  sandboxId: string;
  name: string;
  memoryMib: number;
  cpus: number;
  ageSeconds: number;
}

/**
 * A sandbox the pool has already handed out. Surfacing these is what lets an
 * operator answer "which pod is serving the session I just started?" — the
 * claimed sandbox keeps its pre-warm `createdAt`, so it is not where a
 * chronological listing would suggest.
 */
export interface HotPoolClaimView {
  sandboxId: string;
  name: string;
  status: string;
  /** TTL granted at claim time, in seconds. */
  ttlSeconds: number;
  claimedAt: string | null;
  expiresAt: string | null;
  bindingId: string | null;
}

export interface HotPoolStatus {
  config: HotPoolConfig;
  /** Effective config after applying defaults and validating limits. */
  effective: HotPoolConfig;
  metrics: HotPoolMetrics;
  snapshot: { snapshotId: string; name: string } | null;
  hotSandboxes: HotPoolSandboxView[];
  /** Most recently claimed sandboxes, newest first. */
  recentClaims: HotPoolClaimView[];
  lastReconcileAt: string | null;
  lastError: string | null;
}
