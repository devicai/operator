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
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
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

export type RuntimeStatus = 'running' | 'stopped' | 'unknown';

/**
 * Active connection to a sandbox. Exec / fs operations go through this object.
 */
export interface RuntimeSandbox {
  readonly name: string;

  /** One-shot command. Resolves with full stdout/stderr/exitCode. */
  exec(command: string): Promise<ExecResult>;

  /** Streaming command for interactive use (terminal gateway). */
  execStream(command: string): Promise<ExecStream>;

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
  /** Host or IP reachable from the devic-sandbox process. */
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
}

export const RUNTIME_PROVIDER = Symbol('RUNTIME_PROVIDER');
