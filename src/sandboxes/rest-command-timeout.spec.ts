import { SandboxesService } from './sandboxes.service';
import { SandboxStatus } from '../schemas/sandbox.schema';

/**
 * The synchronous REST exec endpoint caps every command, because a command that
 * never returns would wedge the shared shell and surface as a gateway 504.
 *
 * The cap has two hard edges, and the default has to live between them:
 *
 *   - ABOVE what ordinary work takes. The default used to be 45s, and a plain
 *     `npm i -g <some-cli>` measures ~33s — so routine installs died on a
 *     timeout that had no reason to be that tight, losing the shell (and its
 *     cwd) with them.
 *   - BELOW the upstream gateway cut, or the caller gets a 524/504 with no
 *     exit code instead of a clean exit-124. Cloudflare cuts the origin request
 *     at 125s (measured against sandbox.devic.ai on 2026-09-08).
 *
 * These tests pin the default between those two edges, and pin the precedence
 * of the per-request override that lets a caller ask for something else.
 */
function makeService(config: any = { defaults: {} }) {
  const run = jest.fn().mockResolvedValue({
    code: 0,
    stdout: 'ok',
    stderr: '',
    cwd: '/workspace',
  });

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
    sandboxRepo: { updateById: jest.fn().mockResolvedValue(undefined) },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    config,
    findById: jest.fn().mockResolvedValue(doc),
    maybeAutoExtend: jest.fn().mockResolvedValue(undefined),
    getSandboxInstance: jest
      .fn()
      .mockResolvedValue({ openShell: () => Promise.resolve({ run }) }),
  });
  return { service, run };
}

/** The `timeoutMs` the service handed to the shell for that command. */
const budgetOf = (run: jest.Mock) => run.mock.calls[0][1].timeoutMs;

describe('REST per-command timeout budget', () => {
  it('defaults to 110s when the config says nothing', async () => {
    const { service, run } = makeService();

    await service.runCommand('sbx-1', { command: 'echo hi' } as any, {});

    expect(budgetOf(run)).toBe(110000);
  });

  it('leaves room for an ordinary `npm i -g` and stays under the gateway cut', async () => {
    const { service, run } = makeService();

    await service.runCommand(
      'sbx-1',
      { command: 'npm i -g @enerlence/suntropy-cli' } as any,
      {},
    );

    // A ~33s install must not be anywhere near the edge...
    expect(budgetOf(run)).toBeGreaterThan(60000);
    // ...and the answer must still come back as an exit code, not a 524.
    expect(budgetOf(run)).toBeLessThan(125000);
  });

  it('honours a configured budget over the default', async () => {
    const { service, run } = makeService({
      defaults: { restCommandTimeoutMs: 30000 },
    });

    await service.runCommand('sbx-1', { command: 'echo hi' } as any, {});

    expect(budgetOf(run)).toBe(30000);
  });

  it('lets a per-request timeoutSeconds win over the configured budget', async () => {
    const { service, run } = makeService({
      defaults: { restCommandTimeoutMs: 30000 },
    });

    await service.runCommand(
      'sbx-1',
      { command: 'echo hi', timeoutSeconds: 90 } as any,
      {},
    );

    expect(budgetOf(run)).toBe(90000);
  });

  it('treats timeoutSeconds: 0 as "no timeout", not as "fall back to the default"', async () => {
    const { service, run } = makeService();

    await service.runCommand(
      'sbx-1',
      { command: 'echo hi', timeoutSeconds: 0 } as any,
      {},
    );

    expect(budgetOf(run)).toBe(0);
  });
});
