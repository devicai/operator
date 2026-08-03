export type SandboxStatus = 'pending' | 'creating' | 'running' | 'stopping' | 'stopped' | 'expired' | 'failed';

export interface SandboxDto {
  _id: string;
  sandboxId: string;
  name: string;
  profileId?: string;
  status: SandboxStatus;
  image: string;
  workdir: string;
  currentCwd: string;
  cpus: number;
  memoryMib: number;
  envVars: Record<string, string>;
  ports: Record<string, number>;
  ttlSeconds: number;
  expiresAt: string;
  autoExtend?: boolean;
  snapshotId?: string;
  commandCount: number;
  recentCommands: string[];
  bindingId?: string;
  hotReserved?: boolean;
  /** Permanent mark: this sandbox was handed out by the hot pool. */
  claimedFromHotPool?: boolean;
  /** Bytes written on top of the image, as of the last sampling. */
  diskBytes?: number;
  diskCheckedAt?: string;
  /** Set when the sandbox was stopped by the system, e.g. 'disk-limit'. */
  stoppedReason?: string;
  /** When it was claimed — for pooled sandboxes this, not createdAt, is the start. */
  claimedAt?: string;
  /** Server-computed sort key: claimedAt ?? createdAt. */
  activityAt?: string;
  exposedHttpPort?: number;
  subdomain?: string;
  publicUrl?: string;
  internalEndpoint?: string;
  metadata: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface SandboxProfileDto {
  _id: string;
  name: string;
  description: string;
  image: string;
  workdir: string;
  cpus: number;
  memoryMib: number;
  envVars: Record<string, string>;
  initScript: string;
  ports: Record<string, number>;
  ttlSeconds: number;
  networkPolicy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSandboxProfileDto {
  name: string;
  description?: string;
  image?: string;
  workdir?: string;
  cpus?: number;
  memoryMib?: number;
  envVars?: Record<string, string>;
  initScript?: string;
  ports?: Record<string, number>;
  ttlSeconds?: number;
  networkPolicy?: string;
}

export interface UpdateSandboxProfileDto extends Partial<CreateSandboxProfileDto> {}

export interface CreateSandboxDto {
  profileId?: string;
  bindingId?: string;
  image?: string;
  workdir?: string;
  cpus?: number;
  memoryMib?: number;
  envVars?: Record<string, string>;
  initScript?: string;
  ports?: Record<string, number>;
  ttlSeconds?: number;
  networkPolicy?: string;
  autoExtend?: boolean;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  cwd: string;
}

export interface SandboxStatusResult {
  sandboxId: string;
  status: SandboxStatus;
  image: string;
  cpus: number;
  memoryMib: number;
  currentCwd: string;
  commandCount: number;
  remainingSeconds: number;
  expiresAt: string;
  ttlSeconds: number;
  autoExtend: boolean;
  createdAt: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

// MCP
export interface McpToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean';
  required: boolean;
  description: string;
}

export interface AvailableMcpTool {
  name: string;
  description: string;
  writeAccess: boolean;
  parameters: McpToolParameter[];
}

export interface McpProfileDto {
  _id: string;
  name: string;
  description: string;
  allowedTools: string[];
  defaultSandboxProfileId?: string;
  readOnly: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMcpProfileDto {
  name: string;
  description?: string;
  allowedTools: string[];
  defaultSandboxProfileId?: string;
  readOnly?: boolean;
}

export interface UpdateMcpProfileDto {
  name?: string;
  description?: string;
  allowedTools?: string[];
  defaultSandboxProfileId?: string;
  readOnly?: boolean;
}

// Snapshots
export type SnapshotStatus = 'creating' | 'ready' | 'restoring' | 'failed';

export interface SnapshotDto {
  _id: string;
  snapshotId: string;
  sandboxId: string;
  name: string;
  description: string;
  status: SnapshotStatus;
  image: string;
  workdir: string;
  cpus: number;
  memoryMib: number;
  envVars: Record<string, string>;
  ports: Record<string, number>;
  snapshotPath: string;
  sizeBytes: number;
  metadata: Record<string, any>;
  /**
   * Subdomain this snapshot is served under. Absent means one derived from the
   * snapshot id — every snapshot has a stable URL either way.
   */
  slug?: string;
  /** Address the snapshot is served at, derived by the server from its slug. */
  publicUrl?: string;
  /** Restore on visit to the public URL. Absent means enabled (opt-out). */
  autoRestart?: boolean;
  /**
   * Command run after every restore to bring the service back up. A snapshot
   * restores files, not processes, so without it a restored sandbox serves
   * nothing.
   */
  startCommand?: string;
  createdAt: string;
  updatedAt: string;
}

/** How a snapshot is served: its address, whether it wakes, and what it starts. */
export interface UpdateSnapshotDto {
  slug?: string | null;
  autoRestart?: boolean;
  startCommand?: string | null;
}

/**
 * A problem found in a start command by reading it, not by running it. The
 * command is saved regardless — this is what the caller could not have seen,
 * since a detached launch reports success either way.
 */
export interface StartCommandWarning {
  code: 'PGREP_SELF_MATCH' | 'PKILL_SELF_MATCH' | 'SYNTAX_ERROR';
  message: string;
  fix?: string;
}

export interface UpdatedSnapshotDto extends SnapshotDto {
  startCommandWarnings?: StartCommandWarning[];
}

export interface CreateSnapshotDto {
  sandboxId: string;
  name?: string;
  description?: string;
}

export interface RestoreSnapshotDto {
  name?: string;
  ttlSeconds?: number;
  cpus?: number;
  memoryMib?: number;
  linked?: boolean;
  autoExtend?: boolean;
}

export interface ImportSnapshotDto {
  name?: string;
  description?: string;
  workdir?: string;
  image?: string;
}

// File explorer
export interface FileEntryDto {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  sizeBytes: number;
  mtime: string | null;
  target?: string;
}

export interface ListFilesResult {
  path: string;
  entries: FileEntryDto[];
}

// Resource usage
export interface UsageSummary {
  memory: {
    usedMib: number;
    limitMib: number | null;
    hotPoolReservedMib?: number;
  };
  disk: {
    usedBytes: number;
    limitBytes: number | null;
    /** Sum of the writable layers of running sandboxes. */
    sandboxBytes?: number;
    /** Per-sandbox cap, not a total. */
    sandboxLimitBytes?: number | null;
  };
}

// Hot Pool
export interface HotPoolConfig {
  enabled: boolean;
  snapshotId?: string;
  memoryReservePercent?: number;
  memoryMibPerSandbox?: number;
  cpus?: number;
  minSize?: number;
  maxSize?: number;
  targetSize?: number;
  reconcileIntervalMs?: number;
}

export interface HotPoolSandboxView {
  sandboxId: string;
  name: string;
  memoryMib: number;
  cpus: number;
  ageSeconds: number;
}

export interface HotPoolMetrics {
  current: number;
  currentMemoryMib: number;
  target: number;
  targetMemoryMib: number;
  reservedPercent: number | null;
  reservedMib: number;
  totalLimitMib: number | null;
  totalClaims: number;
  lastClaimedAt: string | null;
}

export interface HotPoolClaimView {
  sandboxId: string;
  name: string;
  status: SandboxStatus;
  ttlSeconds: number;
  claimedAt: string | null;
  expiresAt: string | null;
  bindingId: string | null;
}

export interface HotPoolStatus {
  config: HotPoolConfig;
  effective: HotPoolConfig;
  metrics: HotPoolMetrics;
  snapshot: { snapshotId: string; name: string } | null;
  hotSandboxes: HotPoolSandboxView[];
  recentClaims: HotPoolClaimView[];
  lastReconcileAt: string | null;
  lastError: string | null;
}

export interface ClaimHotDto {
  bindingId?: string;
  ttlSeconds?: number;
  autoExtend?: boolean;
}
