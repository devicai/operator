export interface ModuleConfig {
  server: ServerConfig;
  database: DatabaseConfig;
  redis: RedisConfig;
  defaults: SandboxDefaultsConfig;
  runtime: RuntimeConfig;
  mcp: McpConfig;
  extensions: ExtensionsConfig;
  auth: AuthConfig;
  webhooks?: WebhooksConfig;
  logging: LoggingConfig;
  resourceLimits?: ResourceLimitsConfig;
}

export interface ServerConfig {
  port: number;
  basePath: string;
  cors?: {
    enabled: boolean;
    origins: string[];
  };
}

export interface DatabaseConfig {
  provider: 'mongodb';
  uri?: string;
}

export interface RedisConfig {
  url: string;
}

/**
 * Default values applied when a CreateSandboxDto / restore omits them.
 * Shared by all runtime backends.
 */
export interface SandboxDefaultsConfig {
  defaultImage: string;
  defaultCpus: number;
  defaultMemoryMib: number;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
  ttlCheckIntervalMs: number;
}

export type RuntimeType = 'microsandbox' | 'docker';

export interface RuntimeConfig {
  type: RuntimeType;
  docker?: DockerRuntimeConfig;
}

export interface DockerRuntimeConfig {
  /** Path to the Docker daemon socket. Defaults to /var/run/docker.sock. */
  socketPath?: string;
  /** OCI runtime to launch each sandbox container with. */
  runtime?: 'sysbox-runc' | 'runc';
  /** Docker network to attach sandboxes to when networkPolicy=allow-all. */
  network?: string;
  hardening?: DockerHardeningConfig;
}

export interface DockerHardeningConfig {
  /** Drop ALL Linux capabilities at container start. Default: true. */
  dropAllCaps?: boolean;
  /** Set --security-opt=no-new-privileges. Default: true. */
  noNewPrivileges?: boolean;
  /** Mount rootfs read-only. Many workloads (apt, npm install) break with this. Default: false. */
  readOnlyRootfs?: boolean;
  /** Seccomp profile path or 'default' for Docker's default profile. Default: 'default'. */
  seccompProfile?: string;
  /** Maximum number of processes inside the container. Default: 512. */
  pidsLimit?: number;
}

export interface McpConfig {
  enabled: boolean;
  path?: string;
}

export interface ExtensionsConfig {
  properties: ExtensionProperty[];
}

export interface ExtensionProperty {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date';
  required: boolean;
  index: boolean;
  entities: string[] | '*';
  source: 'header';
  headerName: string;
}

export interface AuthConfig {
  enabled: boolean;
  strategy: 'api-key' | 'jwt' | 'none';
  apiKeys?: Array<{
    name: string;
    key: string;
  }>;
}

export interface WebhooksConfig {
  events: Record<string, string>;
  headers?: Record<string, string>;
  retries?: number;
  timeoutMs?: number;
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  format: 'json' | 'pretty';
}

export interface ResourceLimitsConfig {
  /** Maximum total RAM (MiB) allocated across all running sandboxes. 0/undefined disables the limit. */
  maxTotalMemoryMib?: number;
  /** Maximum total disk usage (bytes) for stored snapshots. 0/undefined disables the limit. */
  maxTotalDiskBytes?: number;
}
