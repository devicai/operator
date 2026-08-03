/**
 * Abstraction over the underlying sandbox runtime.
 *
 * Two implementations exist:
 *   - MicrosandboxRuntimeProvider — wraps the microsandbox SDK (libkrun microVMs, requires KVM).
 *   - DockerRuntimeProvider       — wraps the Docker daemon (uses sysbox-runc / runc, no KVM).
 *
 * Higher-level services (sandboxes, snapshots, ttl, terminal) depend ONLY on this interface.
 */

export interface RuntimeSandboxConfig {
  name: string;
  image: string;
  workdir: string;
  cpus: number;
  memoryMib: number;
  env: Record<string, string>;
  /** hostPort -> guestPort */
  ports?: Record<string, number>;
  networkPolicy?: 'allow-all' | 'deny-all';
  /**
   * Image that `diff()` must treat as the starting point, when that is NOT the
   * image the container was created from.
   *
   * Only set when restoring from a snapshot's derived image. There, `image` is
   * `devic-snapshot:<id>` (base + snapshot content) while the snapshot's
   * tarball is, and must stay, a diff against the ORIGINAL base image. Without
   * this the next capture would diff against the snapshot image, produce a
   * tarball holding only what changed since, and restoring that tarball onto
   * the base image would silently drop everything the snapshot already had.
   *
   * Persisted as a container label so it survives a process restart — the
   * capture that needs it may happen days after the create that set it.
   */
  baselineImage?: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * A single filesystem change of a sandbox relative to the image it was created
 * from. Mirrors `docker diff`:
 *   - `'A'` added (path did not exist in the base image),
 *   - `'C'` changed (path existed and was modified),
 *   - `'D'` deleted (path existed in the base image and was removed).
 *
 * Used by full-filesystem snapshots so everything installed outside the workdir
 * (apt/npm-g/pip packages, /usr/local/bin binaries, /etc configs) is captured,
 * not just /workspace.
 */
export interface FsChange {
  path: string;
  kind: 'A' | 'C' | 'D';
}

export interface ExecStreamEvent {
  type: 'stdout' | 'stderr';
  data: Buffer;
}

export interface ExecStream {
  events: AsyncIterable<ExecStreamEvent>;
  /** Stop the stream and release resources. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Persistent shell session bound to a single sandbox. Commands sent through
 * the same session share environment, working directory, shell options, and
 * any other in-shell state (functions, aliases) — so `export FOO=bar` in one
 * call is visible to the next, and `cd subdir` actually moves the cwd.
 *
 * Implementations serialize concurrent calls per session; callers may queue
 * commands freely without external locking.
 */
export interface ShellSession {
  /** Run a command to completion and return aggregated stdout/stderr. */
  run(command: string, opts?: ShellRunOptions): Promise<ShellRunResult>;
  /**
   * Run a command, streaming stdout/stderr as it arrives. `done` resolves with
   * the final exit code and resulting cwd once the command finishes; the
   * `events` iterable terminates at the same point.
   */
  runStream(command: string, opts?: ShellRunOptions): Promise<ShellRunStream>;
  /** Tear the session down. Idempotent. */
  close(): Promise<void>;
  /** True once the underlying shell process has exited (e.g. user `exit`). */
  readonly closed: boolean;
}

export interface ShellRunOptions {
  /**
   * Change directory before running the command. The shell `cd` is real and
   * persists for subsequent calls in this session. Defaults to the session's
   * current cwd.
   */
  cwd?: string;
  /**
   * Environment overrides scoped to this single command (exported inline
   * before running). Use plain `export X=Y` inside a command if you want the
   * value to persist across calls.
   */
  env?: Record<string, string>;
  /**
   * Per-command wall-clock budget in ms. When the command does not finish in
   * time it is aborted with a {@link ShellCommandTimeoutError} and the session
   * is torn down (so the shared shell is not left wedged). Falls back to the
   * session default when omitted; 0 disables the timeout for this command.
   */
  timeoutMs?: number;
}

/**
 * Raised by a {@link ShellSession} when a command exceeds its time budget. The
 * session aborts the command and tears itself down; callers should surface a
 * timeout to the user rather than retry on the same (now-closed) session.
 */
export class ShellCommandTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`command exceeded its ${timeoutMs}ms time budget and was aborted`);
    this.name = 'ShellCommandTimeoutError';
  }
}

export interface ShellRunResult {
  code: number;
  /** cwd of the session after the command (reflects internal `cd`s). */
  cwd: string;
  stdout: string;
  stderr: string;
}

export interface ShellRunStream {
  events: AsyncIterable<ExecStreamEvent>;
  done: Promise<{ code: number; cwd: string }>;
}

export type RuntimeStatus = 'running' | 'stopped' | 'unknown';

/**
 * Active connection to a sandbox. Exec / fs operations go through this object.
 */
export interface RuntimeSandbox {
  readonly name: string;

  /** One-shot command. Resolves with full stdout/stderr/exitCode. */
  exec(command: string): Promise<ExecResult>;

  /**
   * List the sandbox filesystem changes relative to its base image (added /
   * changed / deleted paths). Backs full-filesystem snapshots. Runtimes that
   * cannot compute a diff throw an error.
   *
   * The Docker implementation adapts to the OCI runtime: under `runc` it uses
   * `docker diff` directly; under `sysbox-runc` (where `docker diff` is blind to
   * sysbox's internally-mounted /usr,/etc,/lib,/var) it computes the diff from
   * inside the container against a baseline manifest of the image. See
   * DockerSandbox.diff() / sysbox-diff.util.
   */
  diff(): Promise<FsChange[]>;

  /** Streaming command for interactive use (terminal gateway). */
  execStream(command: string): Promise<ExecStream>;

  /**
   * Open a persistent shell session whose env vars, cwd, shell functions and
   * other shell state survive across calls. Same session may back both the
   * agent-facing exec API and the interactive terminal, so they observe a
   * consistent view of the sandbox.
   */
  openShell(initialCwd?: string): Promise<ShellSession>;

  /** Read a file from the sandbox filesystem. */
  readFile(path: string): Promise<Buffer>;

  /** Write a file to the sandbox filesystem (creates parents if needed). */
  writeFile(path: string, content: Buffer): Promise<void>;

  /** Copy a single file out of the sandbox to the host filesystem. */
  copyToHost(guestPath: string, hostPath: string): Promise<void>;

  /** Copy a single file from the host filesystem into the sandbox. */
  copyFromHost(hostPath: string, guestPath: string): Promise<void>;

  /** Stop the sandbox without removing its filesystem state. */
  detach(): Promise<void>;
}

export interface RuntimeHandle {
  status: RuntimeStatus;
  /** Reattach to a running sandbox. */
  connect(): Promise<RuntimeSandbox>;
  /** Start a stopped sandbox. */
  start(): Promise<RuntimeSandbox>;
}

/**
 * Network endpoint at which the calling process can reach a sandbox over TCP.
 * Returned by `RuntimeProvider.getAddress` and used by the public ingress proxy.
 */
export interface SandboxAddress {
  /** Host or IP reachable from the Operator process. */
  host: string;
  /** TCP port reachable at `host`. */
  port: number;
}

export interface RuntimeProvider {
  /** Create + start a new sandbox. The returned object is already running. */
  create(config: RuntimeSandboxConfig): Promise<RuntimeSandbox>;

  /** Look up an existing sandbox by name. Returns null if it does not exist. */
  get(name: string): Promise<RuntimeHandle | null>;

  /** Permanently delete a sandbox and reclaim its resources. Idempotent. */
  remove(name: string): Promise<void>;

  /**
   * Resolve a TCP endpoint reachable from this process for the given sandbox
   * and an internal port (the port a service inside the sandbox listens on).
   * Returns null if the sandbox does not exist or the port is not reachable.
   */
  getAddress(
    name: string,
    internalPort: number,
  ): Promise<SandboxAddress | null>;

  /**
   * Optional: ensure the calling process can reach this sandbox over the
   * network. For Docker with per-sandbox networks, this connects the local
   * (self) container to the sandbox's dedicated bridge so the proxy can
   * route to the bridge IP. No-op for runtimes where reachability is given
   * (e.g. microsandbox host-port forwarding) or when the calling process
   * lives on the host directly.
   */
  attachLocal?(name: string): Promise<void>;

  /**
   * Optional: tear down whatever `attachLocal` set up. Idempotent.
   */
  detachLocal?(name: string): Promise<void>;

  /**
   * Optional: reclaim per-sandbox network resources that were leaked by
   * sandboxes which no longer exist. With the ingress feature each allow-all
   * sandbox gets its own bridge network, and each bridge consumes one subnet
   * from the daemon's address pool. When a sandbox container is gone but its
   * network was not torn down (a failed `remove`, a crashed container, an
   * out-of-band deletion), the network lingers and keeps holding its subnet;
   * once the pool is exhausted no new sandbox can be created.
   *
   * This sweeps managed networks that have no sandbox container attached and
   * removes them. It is safe to call opportunistically — networks of running or
   * stopped (restartable) sandboxes still have their container attached and are
   * left untouched, and freshly-created networks are protected by a grace
   * window so an in-flight `create` is never swept. Returns the number of
   * networks reclaimed. No-op for runtimes without per-sandbox networks.
   */
  sweepOrphanedNetworks?(): Promise<number>;

  /**
   * Optional: every sandbox this runtime currently holds, running or not.
   *
   * Used to reconcile the runtime against the database. A sandbox container
   * outlives its document whenever a teardown is missed — the process
   * restarted mid-expiry, a `remove` failed, a container was created
   * out-of-band — and nothing else would ever notice: a document in a
   * terminal state is never revisited, so its container would sit there
   * holding its writable layer forever.
   */
  listManaged?(options?: {
    /**
     * Also report each sandbox's writable-layer size. Costs the runtime extra
     * work, so callers that only need the inventory should leave it off.
     */
    withSize?: boolean;
  }): Promise<ManagedSandboxInfo[]>;

  // ---------------------------------------------------------------------------
  // Snapshot image cache (all optional — a runtime without them simply has no
  // image cache and every restore replays the tarball, as it always did).
  // ---------------------------------------------------------------------------

  /**
   * Seal a container's current filesystem as an image tagged `ref`.
   *
   * Note this captures MORE than `diff()` reports: under sysbox-runc a commit
   * takes the whole writable layer, including the internally-mounted /usr,
   * /etc and /var that `docker diff` cannot see. Callers must therefore commit
   * only containers whose content they fully intend to publish.
   */
  commitImage?(
    containerName: string,
    ref: string,
    labels?: Record<string, string>,
  ): Promise<CommittedImageInfo>;

  imageExists?(ref: string): Promise<boolean>;

  /** Remove an image. Idempotent; resolves false when it was in use. */
  removeImage?(ref: string): Promise<boolean>;

  /** Every cached snapshot image, for accounting and eviction. */
  listSnapshotImages?(repository: string): Promise<CachedImageInfo[]>;
}

export interface CommittedImageInfo {
  ref: string;
  /** Bytes not shared with any other image, i.e. what this image really costs. */
  uniqueSizeBytes: number;
  /** Total layers. Bounded by the runtime — see DockerRuntimeProvider.MAX_LAYERS. */
  layers: number;
}

export interface CachedImageInfo {
  /** Addressable reference: the tag when it has one, the image id otherwise. */
  ref: string;
  /** The snapshot this image belongs to (the tag IS the snapshotId). */
  tag: string;
  uniqueSizeBytes: number;
  createdAtMs: number;
  /** True when a container still references it, which blocks removal. */
  inUse: boolean;
  /**
   * True when a newer commit for the same snapshot took the tag over, leaving
   * this one untagged. It is a dead previous version — never the image a
   * restore would resolve — so it is garbage regardless of the cache cap, and
   * removing it must NOT touch the snapshot's bookkeeping: the tag now points
   * at a live image.
   */
  superseded?: boolean;
}

export interface ManagedSandboxInfo {
  /** Container name, which matches the sandbox document's `name`. */
  name: string;
  /** Epoch millis the container was created, or 0 when unknown. */
  createdAtMs: number;
  /** Runtime-level state, e.g. 'running' / 'exited'. */
  status: string;
  /**
   * Bytes written on top of the image. Only present when `withSize` was
   * requested. Excludes the image layers, which are shared between sandboxes.
   */
  sizeRwBytes?: number;
}

export const RUNTIME_PROVIDER = Symbol('RUNTIME_PROVIDER');
