import {
  buildListDirScript,
  parseListDirOutput,
} from './sandbox-ls.util';

const T = '\t';

describe('buildListDirScript', () => {
  it('escapes the target path for the shell', () => {
    const script = buildListDirScript("/workspace/dir with 'quotes'");
    expect(script).toContain("P='/workspace/dir with '\\''quotes'\\'''");
    expect(script).toContain('__MISSING__');
    expect(script).toContain('__NOT_A_DIR__');
    expect(script).toContain('find --version');
  });
});

describe('parseListDirOutput', () => {
  it('detects the sentinels', () => {
    expect(parseListDirOutput('__MISSING__\n')).toEqual({ error: 'missing' });
    expect(parseListDirOutput('__NOT_A_DIR__\n')).toEqual({
      error: 'not_a_dir',
    });
  });

  it('parses GNU find -printf output (fractional epochs, symlink targets)', () => {
    const stdout = [
      `f${T}1048576${T}1699999999.1234567890${T}video.mp4${T}`,
      `d${T}4096${T}1700000000.0000000000${T}src${T}`,
      `l${T}11${T}1700000001.5000000000${T}mylink${T}/workspace/target.txt`,
      `f${T}0${T}1700000002.0000000000${T}.hidden${T}`,
    ].join('\n');

    const result = parseListDirOutput(stdout);
    if ('error' in result) throw new Error('unexpected parse error');

    expect(result.entries.map((e) => e.name)).toEqual([
      'src',
      '.hidden',
      'mylink',
      'video.mp4',
    ]);

    const link = result.entries.find((e) => e.name === 'mylink');
    expect(link?.type).toBe('symlink');
    expect(link?.target).toBe('/workspace/target.txt');

    const video = result.entries.find((e) => e.name === 'video.mp4');
    expect(video?.type).toBe('file');
    expect(video?.sizeBytes).toBe(1048576);
    expect(video?.mtime).toBe(new Date(1699999999.123456789 * 1000).toISOString());
  });

  it('parses the busybox fallback output (integer epochs)', () => {
    const stdout = [
      `d${T}4096${T}1700000000${T}node_modules${T}`,
      `f${T}42${T}1700000005${T}package.json${T}`,
      `l${T}9${T}1700000006${T}current${T}releases/3`,
    ].join('\n');

    const result = parseListDirOutput(stdout);
    if ('error' in result) throw new Error('unexpected parse error');

    expect(result.entries[0]).toMatchObject({
      name: 'node_modules',
      type: 'dir',
    });
    expect(result.entries[1]).toMatchObject({
      name: 'current',
      type: 'symlink',
      target: 'releases/3',
    });
    expect(result.entries[2]).toMatchObject({
      name: 'package.json',
      type: 'file',
      sizeBytes: 42,
      mtime: new Date(1700000005 * 1000).toISOString(),
    });
  });

  it('sorts directories first, then names case-insensitively', () => {
    const stdout = [
      `f${T}1${T}0${T}Zeta.txt${T}`,
      `d${T}1${T}0${T}beta${T}`,
      `f${T}1${T}0${T}alpha.txt${T}`,
      `d${T}1${T}0${T}Alpha${T}`,
    ].join('\n');

    const result = parseListDirOutput(stdout);
    if ('error' in result) throw new Error('unexpected parse error');
    expect(result.entries.map((e) => e.name)).toEqual([
      'Alpha',
      'beta',
      'alpha.txt',
      'Zeta.txt',
    ]);
  });

  it('ignores blank and malformed lines', () => {
    const stdout = `\n\ngarbage-without-tabs\nf${T}5${T}0${T}ok.txt${T}\n`;
    const result = parseListDirOutput(stdout);
    if ('error' in result) throw new Error('unexpected parse error');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe('ok.txt');
  });

  it('returns an empty listing for an empty directory', () => {
    const result = parseListDirOutput('');
    if ('error' in result) throw new Error('unexpected parse error');
    expect(result.entries).toEqual([]);
  });
});
