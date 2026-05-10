import { Inject, Injectable, Logger } from '@nestjs/common';
import Docker from 'dockerode';
import * as tar from 'tar-stream';
import { PassThrough, Readable } from 'stream';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'fs';
import { basename, dirname } from 'path';
import { CONFIG } from '../config/config.loader';
import { DockerHardeningConfig, ModuleConfig } from '../config/config.types';
import {
  ExecResult,
  ExecStream,
  ExecStreamEvent,
  RuntimeHandle,
  RuntimeProvider,
  RuntimeSandbox,
  RuntimeSandboxConfig,
  RuntimeStatus,
  SandboxAddress,
} from './runtime-provider.interface';

/**
 * Bridge network name for a per-sandbox isolated network. Used only when the
 * public ingress feature is enabled, so each sandbox has its own L2 segment
 * and cannot reach `app`, `mongo`, `redis`, the frontend or other sandboxes.
 */
const isolatedNetworkName = (sandboxName: string): string =>
  `devic-${sandboxName}`;

@Injectable()
export class DockerRuntimeProvider implements RuntimeProvider {
  private readonly logger = new Logger(DockerRuntimeProvider.name);
  private readonly docker: Docker;
  private readonly runtime: string;
  private readonly defaultNetwork: string;
  private readonly hardening: Required<DockerHardeningConfig>;
  private readonly ingressEnabled: boolean;
  private readonly selfContainerId: string | null;

  constructor(@Inject(CONFIG) private readonly config: ModuleConfig) {
    const docker = config.runtime.docker;
    this.docker = new Docker({
      socketPath: docker?.socketPath ?? '/var/run/docker.sock',
    });
    this.runtime = docker?.runtime ?? 'sysbox-runc';
    this.defaultNetwork = docker?.network ?? 'bridge';
    this.hardening = {
      dropAllCaps: docker?.hardening?.dropAllCaps ?? true,
      noNewPrivileges: docker?.hardening?.noNewPrivileges ?? true,
      readOnlyRootfs: docker?.hardening?.readOnlyRootfs ?? false,
      seccompProfile: docker?.hardening?.seccompProfile ?? 'default',
      pidsLimit: docker?.hardening?.pidsLimit ?? 512,
    };
    this.ingressEnabled = Boolean(config.ingress?.enabled);
    this.selfContainerId = detectSelfContainerId(this.logger);
  }

  /**
   * Network the sandbox container will be attached to at create time. With
   * ingress enabled, every allow-all sandbox gets its own bridge network so
   * sandboxes are isolated from each other and from the rest of the stack.
   * Without ingress, behaviour matches the previous default (shared bridge).
   */
  private networkFor(cfg: RuntimeSandboxConfig): string {
    if (cfg.networkPolicy === 'deny-all') return 'none';
    if (this.ingressEnabled) return isolatedNetworkName(cfg.name);
    return this.defaultNetwork;
  }

  async create(cfg: RuntimeSandboxConfig): Promise<RuntimeSandbox> {
    await this.ensureImage(cfg.image);
    await this.removeIfExists(cfg.name);

    const env = Object.entries(cfg.env).map(([k, v]) => `${k}=${v}`);
    const exposed: Record<string, {}> = {};
    const portBindings: Record<string, Array<{ HostPort: string }>> = {};
    if (cfg.ports) {
      for (const [hostPort, guestPort] of Object.entries(cfg.ports)) {
        const key = `${guestPort}/tcp`;
        exposed[key] = {};
        portBindings[key] = [{ HostPort: String(hostPort) }];
      }
    }

    const networkMode = this.networkFor(cfg);
    if (
      this.ingressEnabled &&
      cfg.networkPolicy !== 'deny-all'
    ) {
      await this.ensureIsolatedNetwork(networkMode);
    }

    const securityOpt: string[] = [];
    if (this.hardening.noNewPrivileges) {
      securityOpt.push('no-new-privileges:true');
    }
    if (
      this.hardening.seccompProfile &&
      this.hardening.seccompProfile !== 'default'
    ) {
      securityOpt.push(`seccomp=${this.hardening.seccompProfile}`);
    }

    const container = await this.docker.createContainer({
      name: cfg.name,
      Image: cfg.image,
      Env: env,
      WorkingDir: cfg.workdir,
      Cmd: ['/bin/sh', '-c', 'sleep infinity'],
      Tty: false,
      ExposedPorts: exposed,
      HostConfig: {
        Runtime: this.runtime,
        Memory: cfg.memoryMib * 1024 * 1024,
        NanoCpus: cfg.cpus * 1_000_000_000,
        NetworkMode: networkMode,
        PortBindings: portBindings,
        CapDrop: this.hardening.dropAllCaps ? ['ALL'] : undefined,
        ReadonlyRootfs: this.hardening.readOnlyRootfs,
        SecurityOpt: securityOpt.length ? securityOpt : undefined,
        PidsLimit: this.hardening.pidsLimit,
        AutoRemove: false,
      },
      Labels: {
        'devic-sandbox.managed': 'true',
        'devic-sandbox.name': cfg.name,
      },
    });

    await container.start();

    const sandbox = new DockerSandbox(cfg.name, container);
    // Make sure the workdir exists. Some images ship without /workspace.
    await sandbox.exec(`mkdir -p ${shellEscape(cfg.workdir)}`);
    return sandbox;
  }

  async get(name: string): Promise<RuntimeHandle | null> {
    const container = this.docker.getContainer(name);
    let info: Docker.ContainerInspectInfo;
    try {
      info = await container.inspect();
    } catch (err: any) {
      if (err.statusCode === 404) return null;
      this.logger.error(`docker inspect ${name} failed: ${err.message}`);
      throw err;
    }

    const status = mapStatus(info.State.Status);
    return {
      status,
      connect: async () => new DockerSandbox(name, container),
      start: async () => {
        if (info.State.Status !== 'running') {
          await container.start().catch((err: any) => {
            // Already started is fine.
            if (err.statusCode !== 304) throw err;
          });
        }
        return new DockerSandbox(name, container);
      },
    };
  }

  async remove(name: string): Promise<void> {
    try {
      const container = this.docker.getContainer(name);
      await container.remove({ force: true, v: true });
    } catch (err: any) {
      if (err.statusCode !== 404) {
        this.logger.warn(`docker remove ${name} failed: ${err.message}`);
      }
    }
    if (this.ingressEnabled) {
      await this.removeIsolatedNetwork(isolatedNetworkName(name));
    }
  }

  async attachLocal(name: string): Promise<void> {
    if (!this.ingressEnabled || !this.selfContainerId) return;
    const networkName = isolatedNetworkName(name);
    try {
      const network = this.docker.getNetwork(networkName);
      await network.connect({ Container: this.selfContainerId });
      this.logger.debug(
        `Connected self container ${this.selfContainerId} to ${networkName}`,
      );
    } catch (err: any) {
      // Status 403 from Docker means already connected — treat as no-op.
      if (err.statusCode === 403) return;
      if (err.statusCode === 404) {
        this.logger.warn(
          `Cannot attach to ${networkName}: network does not exist`,
        );
        return;
      }
      this.logger.warn(
        `attachLocal(${name}) failed: ${(err as Error).message}`,
      );
    }
  }

  async detachLocal(name: string): Promise<void> {
    if (!this.ingressEnabled || !this.selfContainerId) return;
    const networkName = isolatedNetworkName(name);
    try {
      const network = this.docker.getNetwork(networkName);
      await network.disconnect({
        Container: this.selfContainerId,
        Force: true,
      });
    } catch (err: any) {
      if (err.statusCode === 404) return;
      // 403 = not connected; 500 with "is not connected" body — both benign.
      if (err.statusCode === 403) return;
      this.logger.debug(
        `detachLocal(${name}) ignored: ${(err as Error).message}`,
      );
    }
  }

  private async ensureIsolatedNetwork(networkName: string): Promise<void> {
    try {
      await this.docker.getNetwork(networkName).inspect();
      return;
    } catch (err: any) {
      if (err.statusCode !== 404) throw err;
    }
    try {
      await this.docker.createNetwork({
        Name: networkName,
        Driver: 'bridge',
        CheckDuplicate: true,
        Internal: false,
        Labels: {
          'devic-sandbox.managed': 'true',
        },
      });
    } catch (err: any) {
      // Race: another concurrent create() raced us. Tolerate.
      if (err.statusCode === 409) return;
      throw err;
    }
  }

  private async removeIsolatedNetwork(networkName: string): Promise<void> {
    try {
      const network = this.docker.getNetwork(networkName);
      // Make sure no peers (e.g. self container) are still attached, otherwise
      // the network will refuse to be removed.
      if (this.selfContainerId) {
        try {
          await network.disconnect({
            Container: this.selfContainerId,
            Force: true,
          });
        } catch {
          // Either already disconnected (403) or network gone (404). Ignored.
        }
      }
      await network.remove();
    } catch (err: any) {
      if (err.statusCode === 404) return;
      this.logger.debug(
        `removeIsolatedNetwork(${networkName}) ignored: ${(err as Error).message}`,
      );
    }
  }

  async getAddress(
    name: string,
    internalPort: number,
  ): Promise<SandboxAddress | null> {
    const container = this.docker.getContainer(name);
    let info: Docker.ContainerInspectInfo;
    try {
      info = await container.inspect();
    } catch (err: any) {
      if (err.statusCode === 404) return null;
      throw err;
    }
    if (info.State.Status !== 'running') return null;

    // Prefer the IP on the configured network, fall back to the first attached
    // network. The proxy reaches the container directly on its bridge IP, so
    // no host port-publishing is required for the ingress feature to work.
    const networks = info.NetworkSettings?.Networks ?? {};
    const preferredName = this.ingressEnabled
      ? isolatedNetworkName(name)
      : this.defaultNetwork;
    const preferred = networks[preferredName];
    const ip =
      preferred?.IPAddress ||
      Object.values(networks)
        .map((n) => n?.IPAddress)
        .find(Boolean);
    if (!ip) return null;
    return { host: ip, port: internalPort };
  }

  private async removeIfExists(name: string): Promise<void> {
    try {
      const c = this.docker.getContainer(name);
      await c.inspect();
      await c.remove({ force: true, v: true });
    } catch (err: any) {
      if (err.statusCode === 404) return;
      this.logger.warn(
        `failed to clean up pre-existing container ${name}: ${err.message}`,
      );
    }
  }

  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch (err: any) {
      if (err.statusCode !== 404) throw err;
    }
    this.logger.log(`Pulling image ${image}...`);
    const stream = (await this.docker.pull(image)) as NodeJS.ReadableStream;
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }
}

function mapStatus(s: string): RuntimeStatus {
  if (s === 'running') return 'running';
  if (s === 'created' || s === 'exited' || s === 'paused' || s === 'dead') {
    return 'stopped';
  }
  return 'unknown';
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Best-effort detection of the container the devic-sandbox process itself is
 * running in. Used to attach `app` to a sandbox's isolated bridge so the
 * embedded ingress proxy can route to it.
 *
 * Resolution order:
 *   1. `DEVIC_SANDBOX_SELF_CONTAINER` env var (operator override).
 *   2. `/etc/hostname` when its first 12 chars match a Docker short ID.
 *
 * Returns null when neither is available — the proxy then falls back to
 * relying on host-routable bridge IPs (works on bare-metal dev setups).
 */
function detectSelfContainerId(logger: Logger): string | null {
  const envId = process.env.DEVIC_SANDBOX_SELF_CONTAINER;
  if (envId && envId.trim()) return envId.trim();
  try {
    const hostname = readFileSync('/etc/hostname', 'utf-8').trim();
    if (/^[0-9a-f]{12,64}$/i.test(hostname)) return hostname;
  } catch {
    // /etc/hostname unreadable (unusual but harmless on dev hosts).
  }
  logger.debug(
    'Could not detect self container ID; per-sandbox network attach will be skipped',
  );
  return null;
}

class DockerSandbox implements RuntimeSandbox {
  constructor(
    readonly name: string,
    private readonly container: Docker.Container,
  ) {}

  async exec(command: string): Promise<ExecResult> {
    const exec = await this.container.exec({
      Cmd: ['/bin/sh', '-c', command],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });

    const stream = await exec.start({ hijack: true, stdin: false });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    stdoutStream.on('data', (c: Buffer) => stdoutChunks.push(c));
    stderrStream.on('data', (c: Buffer) => stderrChunks.push(c));

    this.container.modem.demuxStream(stream, stdoutStream, stderrStream);

    await new Promise<void>((resolve, reject) => {
      const done = () => resolve();
      stream.once('end', done);
      stream.once('close', done);
      stream.once('error', reject);
    });

    const inspect = await exec.inspect();
    return {
      code: inspect.ExitCode ?? 0,
      stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
      stderr: Buffer.concat(stderrChunks).toString('utf-8'),
    };
  }

  async execStream(command: string): Promise<ExecStream> {
    const exec = await this.container.exec({
      Cmd: ['/bin/sh', '-c', command],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const raw = await exec.start({ hijack: true, stdin: false });

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    this.container.modem.demuxStream(raw, stdoutStream, stderrStream);

    let stopped = false;
    const queue: ExecStreamEvent[] = [];
    let resolveNext: ((v: IteratorResult<ExecStreamEvent>) => void) | null = null;
    let ended = false;

    const push = (evt: ExecStreamEvent) => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: evt, done: false });
      } else {
        queue.push(evt);
      }
    };

    const finish = () => {
      ended = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: undefined as any, done: true });
      }
    };

    stdoutStream.on('data', (c: Buffer) =>
      push({ type: 'stdout', data: Buffer.from(c) }),
    );
    stderrStream.on('data', (c: Buffer) =>
      push({ type: 'stderr', data: Buffer.from(c) }),
    );
    raw.on('end', finish);
    raw.on('close', finish);
    raw.on('error', finish);

    const events: AsyncIterable<ExecStreamEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<ExecStreamEvent>> {
            if (stopped) return Promise.resolve({ value: undefined as any, done: true });
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift()!, done: false });
            }
            if (ended) return Promise.resolve({ value: undefined as any, done: true });
            return new Promise((resolve) => {
              resolveNext = resolve;
            });
          },
        };
      },
    };

    return {
      events,
      stop: async () => {
        stopped = true;
        finish();
        try {
          (raw as any).destroy?.();
        } catch {}
      },
    };
  }

  async readFile(path: string): Promise<Buffer> {
    const stream = await this.container.getArchive({ path });
    return await extractFirstFile(stream as any as NodeJS.ReadableStream);
  }

  async writeFile(filePath: string, content: Buffer): Promise<void> {
    const dir = dirname(filePath) || '/';
    const name = basename(filePath);
    await this.exec(`mkdir -p ${shellEscape(dir)}`);

    const pack = tar.pack();
    pack.entry({ name, size: content.length, mode: 0o644 }, content);
    pack.finalize();

    await this.container.putArchive(pack as any, { path: dir });
  }

  async copyToHost(guestPath: string, hostPath: string): Promise<void> {
    const stream = await this.container.getArchive({ path: guestPath });
    const dir = dirname(hostPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    await extractFirstFileToDisk(stream as any as NodeJS.ReadableStream, hostPath);
  }

  async copyFromHost(hostPath: string, guestPath: string): Promise<void> {
    const dir = dirname(guestPath) || '/';
    const name = basename(guestPath);
    await this.exec(`mkdir -p ${shellEscape(dir)}`);

    const stat = statSync(hostPath);
    const pack = tar.pack();
    const entry = pack.entry({
      name,
      size: stat.size,
      mode: stat.mode & 0o777,
    });
    const readStream = createReadStream(hostPath);

    await new Promise<void>((resolve, reject) => {
      entry.on('finish', () => {
        pack.finalize();
        resolve();
      });
      entry.on('error', reject);
      readStream.on('error', reject);
      readStream.pipe(entry);
    });

    await this.container.putArchive(pack as any, { path: dir });
  }

  async detach(): Promise<void> {
    try {
      await this.container.stop({ t: 10 });
    } catch (err: any) {
      if (err.statusCode === 304 || err.statusCode === 404) return;
      throw err;
    }
  }
}

async function extractFirstFile(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const extract = tar.extract();
  const chunks: Buffer[] = [];
  let resolveResult: (b: Buffer) => void;
  let rejectResult: (e: Error) => void;
  const done = new Promise<Buffer>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  extract.on('entry', (header, fileStream, next) => {
    if (header.type !== 'file') {
      fileStream.resume();
      fileStream.on('end', next);
      return;
    }
    fileStream.on('data', (c: Buffer) => chunks.push(c));
    fileStream.on('end', () => {
      resolveResult(Buffer.concat(chunks));
      next();
    });
  });
  extract.on('finish', () => {
    if (chunks.length === 0) resolveResult(Buffer.alloc(0));
  });
  extract.on('error', (e) => rejectResult(e));

  (stream as Readable).pipe(extract);
  return done;
}

async function extractFirstFileToDisk(
  stream: NodeJS.ReadableStream,
  destPath: string,
): Promise<void> {
  const extract = tar.extract();
  let writeFinished: Promise<void> | null = null;

  return new Promise<void>((resolve, reject) => {
    extract.on('entry', (header, fileStream, next) => {
      if (header.type !== 'file') {
        fileStream.resume();
        fileStream.on('end', next);
        return;
      }
      const out = createWriteStream(destPath);
      writeFinished = new Promise((res, rej) => {
        out.on('finish', () => res());
        out.on('error', rej);
      });
      fileStream.pipe(out);
      fileStream.on('end', next);
    });
    extract.on('finish', async () => {
      if (writeFinished) await writeFinished;
      resolve();
    });
    extract.on('error', reject);
    (stream as Readable).pipe(extract);
  });
}

