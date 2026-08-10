import { SnapshotsService } from './snapshots.service';

/**
 * A snapshot restores files, not processes, so `startCommand` is how it says
 * what to bring back up. It runs after the filesystem is in place — NOT via the
 * container entrypoint — because a tarball restore starts the container and
 * only then unpacks into it, so anything the snapshot changed about the boot
 * path has already been skipped by then.
 */
function makeService() {
  const exec = jest.fn(async (_script: string) => ({
    code: 0,
    stdout: 'started',
    stderr: '',
  }));
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = Object.create(SnapshotsService.prototype) as SnapshotsService;
  Object.assign(service as any, { logger });

  const run = (snapshot: Record<string, any>) =>
    (service as any).runStartCommand({ exec } as any, snapshot, 'sbx1');

  return { run, exec, logger };
}

describe('runStartCommand', () => {
  it('does nothing when the snapshot has no start command', async () => {
    const { run, exec } = makeService();
    await run({ snapshotId: 'snap1' });
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(['', '   '])('treats %p as no command', async (startCommand) => {
    const { run, exec } = makeService();
    await run({ snapshotId: 'snap1', startCommand });
    expect(exec).not.toHaveBeenCalled();
  });

  // A start command is a server: it never returns. Waiting on it would turn
  // every restore into a hang, so it is detached and the exec only launches it.
  it('launches the command detached, without waiting for it', async () => {
    const { run, exec } = makeService();
    await run({ snapshotId: 'snap1', startCommand: 'npm start' });

    const script = exec.mock.calls[0][0] as unknown as string;
    expect(script).toContain('nohup');
    expect(script).toMatch(/&\s*\)/); // backgrounded inside a subshell
    expect(script).toContain('</dev/null'); // detached from the exec channel
    expect(script).toContain('/tmp/.devic-start.log'); // output kept, readable later
  });

  // The command is arbitrary user text; it must survive quoting intact.
  it.each([
    "cd /workspace && npm start",
    "sh -c 'echo hi'",
    'python3 -m http.server 8000 --directory "/workspace/my site"',
    "printf '%s\\n' done",
  ])('passes %p through without mangling it', async (startCommand) => {
    const { run, exec } = makeService();
    await run({ snapshotId: 'snap1', startCommand });

    const script = exec.mock.calls[0][0] as unknown as string;
    // Single-quoted for the shell, with embedded quotes escaped the POSIX way.
    const quoted = `'${startCommand.replace(/'/g, `'\\''`)}'`;
    expect(script).toContain(quoted);
  });

  it('trims before deciding there is something to run', async () => {
    const { run, exec } = makeService();
    await run({ snapshotId: 'snap1', startCommand: '  npm start  ' });
    expect(exec.mock.calls[0][0]).toContain("'npm start'");
  });

  // A sandbox whose service fails to start is still a working sandbox: the
  // restore must not fail, and the waiting page is where the user finds out.
  it('does not throw when the command cannot be launched', async () => {
    const { run, exec, logger } = makeService();
    exec.mockRejectedValueOnce(new Error('exec channel closed'));

    await expect(
      run({ snapshotId: 'snap1', startCommand: 'npm start' }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('does not throw when the launcher exits non-zero', async () => {
    const { run, exec, logger } = makeService();
    exec.mockResolvedValueOnce({ code: 127, stdout: '', stderr: 'not found' });

    await expect(
      run({ snapshotId: 'snap1', startCommand: 'nope' }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('127'));
  });
});
