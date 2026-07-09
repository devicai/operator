import { createWriteStream, mkdtempSync, rmSync, createReadStream } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as zlib from 'zlib';
import { pipeline } from 'stream/promises';
import * as tar from 'tar-stream';
import * as yazl from 'yazl';
import * as yauzl from 'yauzl';
import {
  tarballToZipStream,
  zipToTarGz,
  isUnsafeZipEntryName,
} from './snapshot-zip.util';

/** Bytes that are NOT valid UTF-8 — proves the pipeline is lossless. */
const BINARY_PAYLOAD = Buffer.from([
  0x4f, 0x67, 0x67, 0x53, 0x00, 0xff, 0xfe, 0x80, 0x81, 0x00, 0x9c,
]);

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'snapshot-zip-spec-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Build a `.tar.gz` fixture the way `tar czf … -C workdir .` lays it out. */
async function writeTarGzFixture(path: string): Promise<void> {
  const pack = tar.pack();
  pack.entry({ name: './sub', type: 'directory' });
  pack.entry({ name: './hello.txt', type: 'file' }, 'hola devic\n');
  pack.entry({ name: './sub/audio.ogg', type: 'file' }, BINARY_PAYLOAD);
  pack.entry(
    { name: './link', type: 'symlink', linkname: 'hello.txt' },
    () => {},
  );
  pack.finalize();
  await pipeline(pack, zlib.createGzip(), createWriteStream(path));
}

function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c) => chunks.push(c as Buffer));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function readZip(buffer: Buffer): Promise<Map<string, Buffer | null>> {
  return new Promise((resolve, reject) => {
    const out = new Map<string, Buffer | null>();
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) return reject(err);
      zf.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith('/')) {
          out.set(entry.fileName, null);
          return zf.readEntry();
        }
        zf.openReadStream(entry, (openErr, rs) => {
          if (openErr || !rs) return reject(openErr);
          collect(rs)
            .then((buf) => {
              out.set(entry.fileName, buf);
              zf.readEntry();
            })
            .catch(reject);
        });
      });
      zf.on('end', () => resolve(out));
      zf.on('error', reject);
      zf.readEntry();
    });
  });
}

async function readTarGz(path: string): Promise<Map<string, Buffer | null>> {
  const out = new Map<string, Buffer | null>();
  const extract = tar.extract();
  extract.on('entry', (header, stream, next) => {
    if (header.type === 'directory') {
      out.set(header.name, null);
      stream.resume();
      return next();
    }
    collect(stream).then((buf) => {
      out.set(header.name, buf);
      next();
    });
  });
  await pipeline(createReadStream(path), zlib.createGunzip(), extract);
  return out;
}

describe('tarballToZipStream', () => {
  it('converts a workdir tarball into a ZIP with lossless file bytes', async () => {
    const tarball = join(workDir, 'snap.tar.gz');
    await writeTarGzFixture(tarball);

    const { outputStream, done } = tarballToZipStream(tarball, 'gzip');
    const [zipBuffer, stats] = await Promise.all([
      collect(outputStream),
      done,
    ]);

    expect(stats.files).toBe(2);
    expect(stats.skipped).toBe(1); // the symlink

    const entries = await readZip(zipBuffer);
    expect(entries.get('hello.txt')?.toString('utf-8')).toBe('hola devic\n');
    expect(entries.get('sub/audio.ogg')?.equals(BINARY_PAYLOAD)).toBe(true);
    expect(entries.has('sub/')).toBe(true);
    expect([...entries.keys()].some((n) => n.includes('link'))).toBe(false);
  });

  it('rejects and destroys the output on a corrupt tarball', async () => {
    const bogus = join(workDir, 'bogus.tar.gz');
    await pipeline(
      (async function* () {
        yield Buffer.from('this is not a tarball at all');
      })(),
      createWriteStream(bogus),
    );

    const { outputStream, done } = tarballToZipStream(bogus, 'gzip');
    outputStream.on('error', () => {});
    await expect(done).rejects.toBeTruthy();
  });
});

describe('zipToTarGz', () => {
  it('repacks a ZIP into a workdir-layout tar.gz', async () => {
    const zipPath = join(workDir, 'input.zip');
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from('readme body'), 'README.md', {
      mtime: new Date(0),
    });
    zip.addBuffer(BINARY_PAYLOAD, 'assets/blob.bin', { mtime: new Date(0) });
    zip.addEmptyDirectory('empty-dir');
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(zipPath));

    const dest = join(workDir, 'out.tar.gz');
    const { files } = await zipToTarGz(zipPath, dest);
    expect(files).toBe(2);

    const entries = await readTarGz(dest);
    expect(entries.get('README.md')?.toString('utf-8')).toBe('readme body');
    expect(entries.get('assets/blob.bin')?.equals(BINARY_PAYLOAD)).toBe(true);
    expect(entries.has('empty-dir/')).toBe(true);
  });

  it('fails on files that are not ZIP archives', async () => {
    const notZip = join(workDir, 'not.zip');
    await pipeline(
      (async function* () {
        yield Buffer.from('plain text');
      })(),
      createWriteStream(notZip),
    );
    await expect(
      zipToTarGz(notZip, join(workDir, 'out.tar.gz')),
    ).rejects.toBeTruthy();
  });
});

describe('isUnsafeZipEntryName', () => {
  it.each([
    ['../evil.txt', true],
    ['a/../../evil.txt', true],
    ['/absolute.txt', true],
    ['C:\\windows\\evil', true],
    ['back\\slash.txt', true],
    ['', true],
    ['normal.txt', false],
    ['nested/dir/file.bin', false],
    ['dir.with..dots/file', false],
  ])('%s → %s', (name, unsafe) => {
    expect(isUnsafeZipEntryName(name)).toBe(unsafe);
  });
});
