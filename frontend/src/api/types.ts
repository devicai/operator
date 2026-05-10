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
  snapshotId?: string;
  commandCount: number;
  recentCommands: string[];
  bindingId?: string;
  hotReserved?: boolean;
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
  createdAt: string;
  updatedAt: string;
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

export interface HotPoolStatus {
  config: HotPoolConfig;
  effective: HotPoolConfig;
  metrics: HotPoolMetrics;
  snapshot: { snapshotId: string; name: string } | null;
  hotSandboxes: HotPoolSandboxView[];
  lastReconcileAt: string | null;
  lastError: string | null;
}

export interface ClaimHotDto {
  bindingId?: string;
  ttlSeconds?: number;
}
