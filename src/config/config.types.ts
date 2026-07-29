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
  maintenance?: MaintenanceConfig;
  hotPool?: HotPoolConfig;
  ingress?: IngressConfig;
  snapshots?: SnapshotsConfig;
  uploads?: UploadsConfig;
}

/** Size limits for multipart uploads (snapshot ZIP import, file uploads). */
export interface UploadsConfig {
  /** Max snapshot ZIP size in MiB. Default 512. */
  maxSnapshotZipMb?: number;
  /** Max single-file upload size in MiB. Default 100. */
  maxFileMb?: number;
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
  /**
   * How close to `expiresAt` an action has to land for a sandbox created with
   * `autoExtend: true` to renew itself. Anything arriving inside this window
   * pushes the expiry forward by another `ttlSeconds`; anything earlier is
   * left alone, so a busy sandbox is renewed once per lifetime rather than on
   * every call. Keep it at or above `ttlCheckIntervalMs`, otherwise the reaper
   * can claim the sandbox in the gap between the last action and the window.
   * Default 30.
   */
  autoExtendWindowSeconds?: number;
  /**
   * Per-command wall-clock budget for the persistent shell, in ms. A single
   * shell backs every command for a sandbox (REST exec + WebSocket terminal),
   * and commands are serialized — so a command that never returns (an
   * interactive prompt waiting on stdin, a foreground server, a hung build)
   * would otherwise wedge the shell forever and make every later command hang
   * (surfacing as a gateway 504). When a command exceeds this budget it is
   * aborted and the shell is torn down + transparently reopened, so the next
   * command gets a clean shell instead of queuing behind the stuck one. A
   * per-request override may lower it; 0 disables the timeout. Default 300000
   * (5 min).
   */
  commandTimeoutMs?: number;
  /**
   * Default per-command budget (ms) for the synchronous REST exec endpoint
   * (`POST /sandboxes/:id/command`), used when the request omits an explicit
   * `timeoutSeconds`. Kept BELOW the upstream gateway timeout (Cloudflare cuts
   * an origin request at ~60s) so a stuck command returns a clean exit-124 +
   * shell reset instead of a 504. Long-running work should use the WebSocket
   * terminal (kept on `commandTimeoutMs`, which a keepalive protects from the
   * idle cut). 0 disables. Default 45000 (45s).
   */
  restCommandTimeoutMs?: number;
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
  /** Image admission policy (allowlist + size cap). */
  images?: ImagePolicyConfig;
  /**
   * Allow callers to publish a sandbox port directly on the host via the
   * `ports` map. Disabled by default: user-supplied host ports are ignored,
   * since public exposure goes through the ingress proxy (which never needs a
   * host port). Enable only for direct raw-TCP host publishing. When enabled,
   * host ports are validated (>1024) and always bound to 127.0.0.1.
   */
  allowHostPortPublishing?: boolean;
}

export interface DockerHardeningConfig {
  /** Drop ALL Linux capabilities at container start. Default: true. */
  dropAllCaps?: boolean;
  /** Set --security-opt=no-new-privileges. Default: true. */
  noNewPrivileges?: boolean;
  /** Mount rootfs read-only. Many workloads (apt, npm install) break with this. Default: false. */
  readOnlyRootfs?: boolean;
  /**
   * Seccomp profile for each sandbox. One of:
   *   'default'    — Docker daemon's built-in profile (no SecurityOpt added).
   *   'unconfined' — no syscall filtering (NOT recommended).
   *   <path.json>  — path to a profile file; its JSON content is read and
   *                  passed inline to the daemon.
   * Default: 'default'.
   */
  seccompProfile?: string;
  /**
   * AppArmor profile name applied to each sandbox (e.g. 'docker-default' or a
   * custom loaded profile). Empty string disables explicit assignment. The
   * profile is only applied when the daemon reports AppArmor support; on hosts
   * without AppArmor it is skipped with a warning instead of failing the
   * create. Default: 'docker-default'.
   */
  apparmorProfile?: string;
  /**
   * User the sandbox process runs as, in Docker's `user[:group]` form
   * (e.g. '1000:1000'). Empty string keeps the image's default user (usually
   * root). With sysbox-runc, root is already remapped to an unprivileged host
   * uid, so root is safe; set this only for the plain `runc` fallback or
   * defence-in-depth. Default: '' (image default).
   */
  runAsUser?: string;
  /** Maximum number of processes inside the container. Default: 512. */
  pidsLimit?: number;
}

export interface ImagePolicyConfig {
  /**
   * Allowed image references. An entry matches when the requested image equals
   * it, or — when the entry ends in `/` or `*` — when the image starts with the
   * entry's prefix. Tags are ignored for matching. An empty list allows any
   * image (back-compat); a populated list rejects anything outside it.
   */
  allowlist?: string[];
  /**
   * Maximum on-disk size (bytes) of a pulled image. Images larger than this are
   * removed after pull and the create is rejected. 0 disables the check.
   */
  maxSizeBytes?: number;
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

/**
 * Snapshot behaviour. A snapshot can capture the whole filesystem diff vs the
 * base image (`full` — installed packages, /usr/local/bin, /etc all survive a
 * restore) or just the working directory (`workdir` — lighter, legacy). Full
 * snapshots stay small by storing only the *diff* (compressed) and skipping
 * regenerable caches.
 */
export interface SnapshotsConfig {
  /** Scope used when a create request omits it. Default: 'full'. */
  defaultScope?: 'full' | 'workdir';
  /**
   * Compression for full snapshots. The value also decides WHERE it runs:
   *   - 'gzip' (and 'auto'): streamed inside the sandbox (`tar | gzip`) — CPU is
   *     charged to the tenant's quota, no uncompressed staging, restore needs
   *     only the universal gzip. Recommended default for a shared host.
   *   - 'zstd': sandbox emits a plain tar and the HOST compresses with Node's
   *     zlib (smaller artifacts, but unmetered host CPU + transient staging;
   *     restore also decompresses host-side so the base image needn't have
   *     zstd). Falls back to gzip if this Node build lacks zstd support.
   * Default: 'auto'.
   */
  compression?: 'auto' | 'zstd' | 'gzip';
  /**
   * How aggressively to drop regenerable content from a full snapshot to save
   * disk. 'conservative' (default) excludes package-manager caches; 'none'
   * captures the diff verbatim; 'aggressive' additionally drops logs, residual
   * tmp and man/doc.
   */
  cleanup?: 'conservative' | 'none' | 'aggressive';
  /**
   * Extra absolute path prefixes (or glob-ish suffixes like `**​/__pycache__`)
   * to exclude from full snapshots, merged on top of the `cleanup` preset.
   */
  excludePaths?: string[];
}

export interface ResourceLimitsConfig {
  /** Maximum total RAM (MiB) allocated across all running sandboxes. 0/undefined disables the limit. */
  maxTotalMemoryMib?: number;
  /** Maximum total disk usage (bytes) for stored snapshots. 0/undefined disables the limit. */
  maxTotalDiskBytes?: number;
  /**
   * Maximum disk (bytes) a single sandbox may write before it is stopped.
   * 0/undefined disables the limit.
   *
   * This is a *reactive* cap, not a kernel quota: usage is sampled on an
   * interval, so a sandbox can overshoot between two samples. A hard cap needs
   * `--storage-opt size=`, which Docker only honors on overlay2 over XFS
   * mounted with `pquota` — on ext4 the daemon rejects it outright. Without
   * this, one runaway sandbox can fill the host and take every other service
   * down with it.
   */
  maxSandboxDiskBytes?: number;
  /**
   * Disk (bytes) at which a sandbox is flagged as heavy without being touched.
   * Surfaces in the API and the UI so an operator sees the growth coming.
   * 0/undefined disables the warning.
   */
  warnSandboxDiskBytes?: number;
}

/**
 * Cadence of the background jobs that keep the runtime and the database in
 * agreement. Every value is a trade-off between reclaiming resources promptly
 * and the load each pass puts on the daemon, so an operator running a busy
 * host — or a laptop — needs to be able to tune them without a rebuild.
 */
export interface MaintenanceConfig {
  /**
   * How often the runtime is reconciled against the database, reclaiming
   * containers whose sandbox is gone or in a terminal state.
   * Default 300000 (5 min). Lists the whole daemon, so keep it well above the
   * TTL sweep interval.
   */
  containerSweepIntervalMs?: number;
  /**
   * A container younger than this is never reclaimed, so a create still in
   * flight is safe even before its document exists. Default 600000 (10 min).
   * Must comfortably exceed the slowest create on this host.
   */
  containerSweepGraceMs?: number;
  /** How often per-sandbox disk usage is sampled. Default 60000 (1 min). */
  sandboxDiskCheckIntervalMs?: number;
  /**
   * Grace window shielding a just-created per-sandbox network from the network
   * sweeper, which would otherwise reclaim it mid-create. Default 60000.
   * Only relevant when ingress is enabled.
   */
  networkSweepGraceMs?: number;
  /**
   * Floor applied to every interval above. Guards against a typo (or a zero)
   * turning a periodic job into a busy loop against the Docker daemon.
   * Default 5000.
   */
  minIntervalMs?: number;
}

/**
 * Hot Pool keeps a fleet of pre-warmed sandboxes (restored from a configured
 * snapshot) ready to be claimed instantly, avoiding the cold-start penalty
 * of creating + restoring a sandbox on demand.
 *
 * The pool reserves a slice of the total memory budget (resourceLimits.maxTotalMemoryMib)
 * proportional to `memoryReservePercent`. As long as the pool isn't full,
 * new on-demand sandboxes can't grow into the reserved portion.
 */
export interface HotPoolConfig {
  /** Master switch. */
  enabled: boolean;
  /** Snapshot ID used as the source for every hot sandbox. */
  snapshotId?: string;
  /**
   * Percentage (0–100) of `resourceLimits.maxTotalMemoryMib` reserved for
   * the hot pool. Required when `maxTotalMemoryMib` is set; otherwise the
   * pool falls back to a fixed `targetSize`.
   */
  memoryReservePercent?: number;
  /** Memory (MiB) of each individual hot sandbox. */
  memoryMibPerSandbox?: number;
  /** CPUs of each hot sandbox. */
  cpus?: number;
  /** Lower bound for pool size (irrespective of memory budget). */
  minSize?: number;
  /** Hard cap on pool size. */
  maxSize?: number;
  /**
   * Optional fixed pool size. Overrides percentage-based sizing when set.
   * Useful when no `maxTotalMemoryMib` cap is configured.
   */
  targetSize?: number;
  /** Reconcile cadence in milliseconds. */
  reconcileIntervalMs?: number;
}

/**
 * Public ingress: expose each running sandbox at <sandboxId>.<wildcardDomain>.
 * The module runs an embedded HTTP reverse proxy that resolves the Host header
 * to a sandbox upstream and forwards the request. TLS is expected to be
 * terminated upstream (Cloudflare / CDN / external LB).
 */
export interface IngressConfig {
  /** Master switch. When false, sandboxes are never published. */
  enabled: boolean;
  /**
   * Domain under which sandboxes are exposed. Public URLs become
   * `<sandboxId>.<wildcardDomain>` (e.g. `abc123.sandbox.devic.ai`).
   * The operator is responsible for the wildcard DNS record + TLS at the edge.
   */
  wildcardDomain: string;
  /**
   * Public scheme used to render `publicUrl` for callers. Defaults to `https`
   * since TLS termination is expected upstream.
   */
  publicScheme?: 'http' | 'https';
  /** Port the embedded reverse proxy listens on. Default 8080. */
  proxyPort?: number;
  /** Bind address for the proxy listener. Default '0.0.0.0'. */
  proxyHost?: string;
  /**
   * Default port inside the sandbox to forward HTTP traffic to. Each sandbox
   * may override this via its own `exposedHttpPort`. Default 80.
   */
  defaultUpstreamPort?: number;
  /**
   * Per-request upstream timeout (ms). Default 30000.
   */
  upstreamTimeoutMs?: number;
  /**
   * Max upstream cache TTL (s) for the subdomain → endpoint mapping in Redis.
   * Refreshed each time a sandbox publishes. Default: derived from sandbox
   * `expiresAt`, capped at 24h.
   */
  registryMaxTtlSeconds?: number;
}
