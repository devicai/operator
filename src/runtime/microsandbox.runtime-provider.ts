import { Injectable, Logger } from '@nestjs/common';
import { Sandbox as MsbSandbox, Patch } from 'microsandbox';
import type { SandboxConfig, ExecHandle, ExecEvent } from 'microsandbox';
import {
  ExecResult,
  ExecStream,
  ExecStreamEvent,
  RuntimeHandle,
  RuntimeProvider,
  RuntimeSandbox,
  RuntimeSandboxConfig,
  RuntimeStatus,
} from './runtime-provider.interface';

@Injectable()
export class MicrosandboxRuntimeProvider implements RuntimeProvider {
  private readonly logger = new Logger(MicrosandboxRuntimeProvider.name);

  async create(cfg: RuntimeSandboxConfig): Promise<RuntimeSandbox> {
    const msbConfig: SandboxConfig = {
      name: cfg.name,
      image: cfg.image,
      workdir: cfg.workdir,
      cpus: cfg.cpus,
      memoryMib: cfg.memoryMib,
      env: cfg.env,
      patches: [Patch.mkdir(cfg.workdir)],
      network: {
        policy: (cfg.networkPolicy ?? 'allow-all') as any,
        tls: { interceptedPorts: [] },
      },
      quietLogs: true,
      replace: true,
    };

    if (cfg.ports && Object.keys(cfg.ports).length > 0) {
      msbConfig.ports = {};
      for (const [k, v] of Object.entries(cfg.ports)) {
        msbConfig.ports[k] = v;
      }
    }

    const instance = await MsbSandbox.create(msbConfig);
    return new MicrosandboxSandbox(cfg.name, instance);
  }

  async get(name: string): Promise<RuntimeHandle | null> {
    try {
      const handle: any = await MsbSandbox.get(name);
      const status = mapStatus(handle.status);
      return {
        status,
        connect: async () => {
          const inst = await handle.connect();
          return new MicrosandboxSandbox(name, inst);
        },
        start: async () => {
          const inst = await handle.start();
          return new MicrosandboxSandbox(name, inst);
        },
      };
    } catch (err) {
      // microsandbox SDK throws when the sandbox does not exist; treat as null.
      this.logger.debug(
        `microsandbox.get(${name}) returned no handle: ${(err as Error).message}`,
      );
      return null;
    }
  }

  async remove(name: string): Promise<void> {
    try {
      await MsbSandbox.remove(name);
    } catch (err) {
      this.logger.warn(
        `microsandbox.remove(${name}) failed: ${(err as Error).message}`,
      );
    }
  }
}

function mapStatus(raw: unknown): RuntimeStatus {
  if (raw === 'running') return 'running';
  if (raw === 'stopped' || raw === 'detached') return 'stopped';
  return 'unknown';
}

class MicrosandboxSandbox implements RuntimeSandbox {
  constructor(
    readonly name: string,
    private readonly inst: MsbSandbox,
  ) {}

  async exec(command: string): Promise<ExecResult> {
    const result = await this.inst.shell(command);
    return {
      code: result.code,
      stdout: result.stdout(),
      stderr: result.stderr(),
    };
  }

  async execStream(command: string): Promise<ExecStream> {
    const handle: ExecHandle = await this.inst.shellStream(command);
    let stopped = false;

    async function* iterate(): AsyncGenerator<ExecStreamEvent> {
      while (!stopped) {
        const event: ExecEvent | null = await handle.recv();
        if (event === null) return;
        if (event.eventType === 'stdout' && event.data) {
          yield { type: 'stdout', data: Buffer.from(event.data) };
        } else if (event.eventType === 'stderr' && event.data) {
          yield { type: 'stderr', data: Buffer.from(event.data) };
        }
      }
    }

    return {
      events: iterate(),
      stop: async () => {
        stopped = true;
      },
    };
  }

  async readFile(path: string): Promise<Buffer> {
    const data = await this.inst.fs().read(path);
    return Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  }

  async writeFile(path: string, content: Buffer): Promise<void> {
    await this.inst.fs().write(path, content);
  }

  async copyToHost(guestPath: string, hostPath: string): Promise<void> {
    await this.inst.fs().copyToHost(guestPath, hostPath);
  }

  async copyFromHost(hostPath: string, guestPath: string): Promise<void> {
    await this.inst.fs().copyFromHost(hostPath, guestPath);
  }

  async detach(): Promise<void> {
    await this.inst.detach();
  }
}
