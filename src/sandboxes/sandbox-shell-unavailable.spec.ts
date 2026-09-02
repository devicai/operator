import { SandboxesService } from './sandboxes.service';
import { SandboxStatus } from '../schemas/sandbox.schema';
import { ShellUnavailableError } from '../runtime/runtime-provider.interface';

/**
 * Two very different failures used to arrive at the caller as the same
 * answer — exit 124, "the shell was reset, retry":
 *
 *   1. The shell opened, ran, and died mid-command (a concurrent timeout tore
 *      the shared session down). Transient. Retrying works.
 *   2. The container refuses to start ANY process — what a container left
 *      behind by an OCI runtime restart does. Permanent. Retrying is a loop.
 *
 * These tests pin the second one to its own, terminal answer.
 */
function makeService(openShell: () => Promise<any>) {
  const sandboxRepo = { updateById: jest.fn().mockResolvedValue(undefined) };
  const logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  const doc = {
    _id: { toString: () => 'oid-1' },
    sandboxId: 'sbx-1',
    name: 'sandbox-sbx-1',
    status: SandboxStatus.RUNNING,
    workdir: '/workspace',
    currentCwd: '/workspace',
    recentCommands: [],
  } as any;

  const service = Object.create(SandboxesService.prototype) as SandboxesService;
  Object.assign(service as any, {
    sandboxRepo,
    logger,
    config: { defaults: {} },
    findById: jest.fn().mockResolvedValue(doc),
    maybeAutoExtend: jest.fn().mockResolvedValue(undefined),
    getSandboxInstance: jest.fn().mockResolvedValue({ openShell }),
  });
  return { service, sandboxRepo, logger, doc };
}

describe('runCommand when the shell cannot be opened', () => {
  const runtimeError =
    'OCI runtime exec failed: unsafe procfs detected: operation not permitted';

  it('reports a terminal 126 naming the runtime error, not a retryable 124', async () => {
    const { service, logger } = makeService(() =>
      Promise.reject(new ShellUnavailableError(runtimeError)),
    );

    const result = await service.runCommand('sbx-1', { command: 'echo hi' } as any, {});

    expect(result.code).toBe(126);
    expect(result.stderr).toContain('will not recover');
    expect(result.stderr).toContain('unsafe procfs detected');
    // A caller must not read this as "try again in a moment".
    expect(result.stderr).not.toMatch(/retry/i);
    // And an operator must be able to find it: this is a host-level fault.
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('unsafe procfs detected'),
    );
  });

  it('does not count a failed open as a command run', async () => {
    const { service, sandboxRepo } = makeService(() =>
      Promise.reject(new ShellUnavailableError(runtimeError)),
    );

    await service.runCommand('sbx-1', { command: 'echo hi' } as any, {});

    expect(sandboxRepo.updateById).not.toHaveBeenCalled();
  });

  it('still reports a mid-command reset as retryable', async () => {
    const shell = {
      run: jest.fn().mockRejectedValue(new Error('Shell session is closed')),
    };
    const { service } = makeService(() => Promise.resolve(shell));

    const result = await service.runCommand('sbx-1', { command: 'echo hi' } as any, {});

    expect(result.code).toBe(124);
    expect(result.stderr).toMatch(/retry the command/);
  });

  it('propagates unrelated open failures instead of swallowing them', async () => {
    const { service } = makeService(() =>
      Promise.reject(new Error('docker socket closed')),
    );

    await expect(
      service.runCommand('sbx-1', { command: 'echo hi' } as any, {}),
    ).rejects.toThrow('docker socket closed');
  });
});

describe('probeHealth', () => {
  function makeProbeService(exec: jest.Mock) {
    const service = Object.create(
      SandboxesService.prototype,
    ) as SandboxesService;
    Object.assign(service as any, {
      logger: { warn: jest.fn(), error: jest.fn() },
      getSandboxInstance: jest.fn().mockResolvedValue({ exec }),
    });
    return service;
  }

  const doc = { sandboxId: 'sbx-1', name: 'sandbox-sbx-1' } as any;

  it('is healthy only when the token actually comes back', async () => {
    const exec = jest.fn(async (cmd: string) => ({
      code: 0,
      stdout: `${cmd.replace('echo ', '')}\n`,
      stderr: '',
    }));
    const service = makeProbeService(exec);

    await expect(service.probeHealth(doc)).resolves.toEqual({ healthy: true });
  });

  it('is unhealthy when the container answers with the runtime error', async () => {
    const exec = jest.fn().mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: 'OCI runtime exec failed: unsafe procfs detected',
    });
    const service = makeProbeService(exec);

    const result = await service.probeHealth(doc);

    expect(result.healthy).toBe(false);
    expect(result.reason).toContain('unsafe procfs detected');
  });

  it('is unhealthy — never throwing — when the sandbox is unreachable', async () => {
    const service = makeProbeService(
      jest.fn().mockRejectedValue(new Error('no such container')),
    );

    await expect(service.probeHealth(doc)).resolves.toMatchObject({
      healthy: false,
      reason: 'no such container',
    });
  });

  it('gives up on a wedged container instead of hanging the caller', async () => {
    const service = makeProbeService(jest.fn(() => new Promise(() => undefined)));

    const result = await service.probeHealth(doc, 20);

    expect(result.healthy).toBe(false);
    expect(result.reason).toMatch(/timed out after 20ms/);
  });
});
