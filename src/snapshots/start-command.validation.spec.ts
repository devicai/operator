import {
  validateStartCommand,
  checkStartCommandSyntax,
  inspectStartCommand,
} from './start-command.validation';

describe('validateStartCommand', () => {
  it('says nothing about a command with no process guard', () => {
    expect(
      validateStartCommand(
        'cd /workspace && nohup node src/server.js >server.log 2>&1 &',
      ),
    ).toEqual([]);
  });

  it('says nothing about an empty command', () => {
    expect(validateStartCommand('')).toEqual([]);
    expect(validateStartCommand('   ')).toEqual([]);
  });

  // The case this check exists for: a snapshot came up with an empty log and
  // nothing listening, because its guard found the shell that was running it.
  it('flags a guard whose pattern is the process it starts', () => {
    const warnings = validateStartCommand(
      'if ! pgrep -f "node src/server.js" >/dev/null; then ' +
        'nohup env PORT=3001 node src/server.js >server.log 2>&1 & fi',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('PGREP_SELF_MATCH');
    expect(warnings[0].message).toContain('node src/server.js');
    expect(warnings[0].fix).toContain('/dev/tcp/');
  });

  // The obvious repair for the case above, and it does not work: the command
  // being started is spelled out later in the same line, so the pattern still
  // has something to find.
  it('flags the character-class workaround, which does not help here', () => {
    const warnings = validateStartCommand(
      'if ! pgrep -f "[n]ode src/server.js" >/dev/null; then ' +
        'nohup node src/server.js & fi',
    );
    expect(warnings.map((w) => w.code)).toEqual(['PGREP_SELF_MATCH']);
  });

  // Even a pattern naming an unrelated process matches, because the pattern is
  // spelled out inside the pgrep call that searches for it.
  it('flags a guard for a process the command does not start', () => {
    expect(
      validateStartCommand('pgrep -f "postgres" >/dev/null || echo waiting'),
    ).toHaveLength(1);
  });

  it('reads the pattern through combined flags and quoting styles', () => {
    expect(validateStartCommand("pgrep -af 'my-daemon' && echo up")).toHaveLength(1);
    expect(validateStartCommand('pgrep -u root -f my-daemon')).toHaveLength(1);
  });

  it('leaves a runtime-built pattern alone, the one case the guard works', () => {
    expect(validateStartCommand('PAT=node; pgrep -f "$PAT" || start')).toEqual([]);
  });

  it('leaves pgrep without -f alone: it matches on the executable name', () => {
    expect(validateStartCommand('pgrep node || nohup node app.js &')).toEqual([]);
  });

  it('flags pkill -f separately: it kills the shell running the command', () => {
    const warnings = validateStartCommand('pkill -f "node app.js"; nohup node app.js &');
    expect(warnings.map((w) => w.code)).toEqual(['PKILL_SELF_MATCH']);
    expect(warnings[0].message).toContain('kills the shell');
  });

  it('accepts a port test, which is what the guard should have been', () => {
    expect(
      validateStartCommand(
        '(exec 3<>/dev/tcp/127.0.0.1/3000) 2>/dev/null || nohup node app.js &',
      ),
    ).toEqual([]);
  });

  it('reports one warning per guard', () => {
    expect(
      validateStartCommand(
        'pgrep -f "node a.js" || nohup node a.js &; pgrep -f "node b.js" || nohup node b.js &',
      ),
    ).toHaveLength(2);
  });

  it('ignores a pattern that is not a valid regex rather than guessing', () => {
    expect(validateStartCommand('pgrep -f "node [" || true')).toEqual([]);
  });
});

describe('checkStartCommandSyntax', () => {
  it('accepts a command the shell can parse', async () => {
    await expect(
      checkStartCommandSyntax('if true; then nohup node app.js & fi'),
    ).resolves.toEqual([]);
  });

  it('reports an unclosed block', async () => {
    const warnings = await checkStartCommandSyntax('if true; then nohup node app.js &');
    expect(warnings.map((w) => w.code)).toEqual(['SYNTAX_ERROR']);
    expect(warnings[0].message).toContain('cannot parse');
  });

  it('reports an unbalanced quote', async () => {
    const warnings = await checkStartCommandSyntax(`echo 'unterminated`);
    expect(warnings.map((w) => w.code)).toEqual(['SYNTAX_ERROR']);
  });

  it('says nothing about an empty command', async () => {
    await expect(checkStartCommandSyntax('')).resolves.toEqual([]);
  });

  // Parsing must not run anything: -n stops after reading.
  it('does not execute the command it checks', async () => {
    const marker = `/tmp/devic-syntax-check-${process.pid}`;
    await checkStartCommandSyntax(`touch ${marker}`);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    expect(require('fs').existsSync(marker)).toBe(false);
  });
});

describe('inspectStartCommand', () => {
  it('reports a broken guard in a command that parses', async () => {
    await expect(
      inspectStartCommand('pgrep -f "node app.js" || nohup node app.js &'),
    ).resolves.toHaveLength(1);
  });

  // A command that does not parse never reaches its guards, so listing those
  // too would send the reader after the wrong problem.
  it('reports only the syntax error when the command does not parse', async () => {
    const warnings = await inspectStartCommand(
      'if ! pgrep -f "node app.js"; then nohup node app.js &',
    );
    expect(warnings.map((w) => w.code)).toEqual(['SYNTAX_ERROR']);
  });

  it('says nothing about a sound command', async () => {
    await expect(
      inspectStartCommand('cd /workspace && nohup node server.js >log 2>&1 &'),
    ).resolves.toEqual([]);
  });
});
