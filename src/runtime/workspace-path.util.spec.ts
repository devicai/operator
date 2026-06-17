import {
  WorkspaceConfinementError,
  resolveWithinWorkspace,
  describeRuntimeFsError,
} from './workspace-path.util';

describe('resolveWithinWorkspace', () => {
  const WD = '/workspace';

  it('resolves a relative path against the workspace', () => {
    expect(resolveWithinWorkspace('enriched.md', WD)).toBe(
      '/workspace/enriched.md',
    );
    expect(resolveWithinWorkspace('sub/dir/file.txt', WD)).toBe(
      '/workspace/sub/dir/file.txt',
    );
  });

  it('accepts an absolute path already inside the workspace', () => {
    expect(resolveWithinWorkspace('/workspace/a/b.md', WD)).toBe(
      '/workspace/a/b.md',
    );
  });

  it('normalises the workspace root itself', () => {
    expect(resolveWithinWorkspace('/workspace', WD)).toBe('/workspace');
    expect(resolveWithinWorkspace('.', WD)).toBe('/workspace');
  });

  it('rejects an absolute path outside the workspace', () => {
    expect(() => resolveWithinWorkspace('/tmp/enriched.md', WD)).toThrow(
      WorkspaceConfinementError,
    );
    expect(() => resolveWithinWorkspace('/etc/passwd', WD)).toThrow(
      WorkspaceConfinementError,
    );
  });

  it('rejects .. traversal that escapes the workspace', () => {
    expect(() => resolveWithinWorkspace('../tmp/x', WD)).toThrow(
      WorkspaceConfinementError,
    );
    expect(() =>
      resolveWithinWorkspace('/workspace/../tmp/x', WD),
    ).toThrow(WorkspaceConfinementError);
  });

  it('does not treat a sibling prefix as inside (workspace vs workspace-evil)', () => {
    expect(() =>
      resolveWithinWorkspace('/workspace-evil/x', WD),
    ).toThrow(WorkspaceConfinementError);
  });

  it('rejects empty paths', () => {
    expect(() => resolveWithinWorkspace('', WD)).toThrow(
      WorkspaceConfinementError,
    );
  });

  it('honours a custom workdir', () => {
    expect(resolveWithinWorkspace('out.json', '/app/data')).toBe(
      '/app/data/out.json',
    );
    expect(() => resolveWithinWorkspace('/workspace/x', '/app/data')).toThrow(
      WorkspaceConfinementError,
    );
  });

  it('does not confine when the workdir is the filesystem root', () => {
    expect(resolveWithinWorkspace('/tmp/x', '/')).toBe('/tmp/x');
  });

  it('produces an actionable message naming the workspace and a suggestion', () => {
    try {
      resolveWithinWorkspace('/tmp/enriched.md', WD);
      fail('expected throw');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('/workspace');
      expect(msg).toContain('/tmp/enriched.md');
      expect(msg).toContain('/workspace/enriched.md');
    }
  });
});

describe('describeRuntimeFsError', () => {
  it('translates the dockerode archive 404 (path) on write', () => {
    const err = new Error(
      '(HTTP code 404) no such container - Could not find the file /tmp in container ec4745',
    );
    expect(describeRuntimeFsError(err, { path: '/tmp/x', op: 'write' })).toMatch(
      /parent directory does not exist/i,
    );
  });

  it('translates the dockerode archive 404 (path) on read', () => {
    const err = new Error(
      '(HTTP code 404) no such container - Could not find the file /x in container ec4745',
    );
    expect(describeRuntimeFsError(err, { path: '/x', op: 'read' })).toMatch(
      /was not found in the sandbox/i,
    );
  });

  it('maps a genuine missing container to a retry hint', () => {
    const err = new Error('(HTTP code 404) no such container - No such container: abc');
    expect(describeRuntimeFsError(err, { path: '/x', op: 'write' })).toMatch(
      /no longer available/i,
    );
  });

  it('returns null for unrelated errors', () => {
    expect(
      describeRuntimeFsError(new Error('boom'), { path: '/x', op: 'write' }),
    ).toBeNull();
  });
});
