import { createReadStream, createWriteStream } from 'fs';
import * as zlib from 'zlib';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import * as tar from 'tar-stream';
import * as yazl from 'yazl';
import * as yauzl from 'yauzl';
import { posix } from 'path';

type Codec = 'zstd' | 'gzip';

export interface TarToZipResult {
  /** ZIP bytes, ready to pipe to the HTTP response. */
  outputStream: Readable;
  /**
   * Resolves when the whole tarball has been consumed (the ZIP central
   * directory may still be flushing to outputStream). Rejects on a corrupt or
   * unreadable tarball, in which case outputStream is destroyed too.
   */
  done: Promise<{ files: number; skipped: number }>;
}

/** Strip the `./` prefix tar entries carry when captured with `-C dir .`. */
function normalizeTarEntryName(name: string): string {
  return name.replace(/^(\.\/)+/, '').replace(/^\.$/, '');
}

/**
 * Convert an on-disk snapshot tarball (`.tar.gz` / `.tar.zst`) into a ZIP
 * stream, entry by entry, so memory stays flat regardless of archive size.
 * ZIP has no portable representation for symlinks/devices/FIFOs — those
 * entries are skipped and counted in the result.
 */
export function tarballToZipStream(
  tarballPath: string,
  codec: Codec,
): TarToZipResult {
  const zip = new yazl.ZipFile();
  const extract = tar.extract();
  let files = 0;
  let skipped = 0;

  const done = new Promise<{ files: number; skipped: number }>(
    (resolve, reject) => {
      extract.on('entry', (header, stream, next) => {
        const name = normalizeTarEntryName(header.name);
        if (!name) {
          stream.resume();
          return next();
        }
        if (header.type === 'directory') {
          zip.addEmptyDirectory(name.replace(/\/+$/, ''));
          stream.resume();
          return next();
        }
        if (header.type === 'file') {
          files++;
          zip.addReadStream(stream, name, {
            mtime: header.mtime ?? new Date(0),
            mode: header.mode,
          });
          // tar-stream only surfaces the next entry once this one is fully
          // consumed; yazl drains queued read streams in the same FIFO order,
          // so waiting for 'end' here keeps the pipeline flowing deadlock-free.
          stream.on('end', () => next());
          return;
        }
        skipped++;
        stream.resume();
        return next();
      });

      const decompress =
        codec === 'zstd'
          ? (zlib as any).createZstdDecompress()
          : zlib.createGunzip();

      pipeline(createReadStream(tarballPath), decompress, extract)
        .then(() => {
          zip.end();
          resolve({ files, skipped });
        })
        .catch((err) => {
          (zip.outputStream as unknown as Readable).destroy(err as Error);
          reject(err);
        });
    },
  );

  return { outputStream: zip.outputStream as unknown as Readable, done };
}

/**
 * True when a ZIP entry name could escape the extraction root (zip-slip):
 * absolute paths, `..` segments, backslash separators or drive letters.
 * yauzl already rejects most of these when decoding strings; this is the
 * explicit second barrier.
 */
export function isUnsafeZipEntryName(name: string): boolean {
  if (!name) return true;
  if (name.includes('\\')) return true;
  if (posix.isAbsolute(name)) return true;
  if (/^[a-zA-Z]:/.test(name)) return true;
  const normalized = posix.normalize(name);
  return normalized === '..' || normalized.startsWith('../');
}

/**
 * Repack an uploaded ZIP into the `.tar.gz` layout snapshot restore expects
 * (entries relative to the workdir root). Streaming end to end: each ZIP
 * entry is inflated straight into the tar packer. Rejects on zip-slip.
 */
export async function zipToTarGz(
  zipPath: string,
  destTarGzPath: string,
): Promise<{ files: number }> {
  const pack = tar.pack();
  const gzip = zlib.createGzip({ level: 6 });
  const pipelineDone = pipeline(pack, gzip, createWriteStream(destTarGzPath));

  const zipfile: yauzl.ZipFile = await new Promise((res, rej) =>
    yauzl.open(zipPath, { lazyEntries: true }, (err, zf) =>
      err ? rej(err) : res(zf),
    ),
  );

  let files = 0;
  const walk = new Promise<void>((resolve, reject) => {
    let failed = false;
    const fail = (err: Error) => {
      if (failed) return;
      failed = true;
      try {
        zipfile.close();
      } catch {}
      pack.destroy(err);
      reject(err);
    };

    zipfile.on('entry', (entry: yauzl.Entry) => {
      const name = entry.fileName;
      if (isUnsafeZipEntryName(name)) {
        return fail(new Error(`unsafe path in ZIP entry: ${name}`));
      }
      const mtime = entry.getLastModDate();

      if (name.endsWith('/')) {
        pack.entry({ name, type: 'directory', mtime, mode: 0o755 }, (err) =>
          err ? fail(err) : zipfile.readEntry(),
        );
        return;
      }

      zipfile.openReadStream(entry, (err, readStream) => {
        if (err || !readStream) {
          return fail(err ?? new Error(`cannot read ZIP entry: ${name}`));
        }
        files++;
        const sink = pack.entry(
          { name, size: entry.uncompressedSize, mtime, mode: 0o644 },
          (entryErr) => {
            if (entryErr) return fail(entryErr);
            zipfile.readEntry();
          },
        );
        readStream.on('error', fail);
        readStream.pipe(sink);
      });
    });

    zipfile.on('end', () => {
      pack.finalize();
      resolve();
    });
    zipfile.on('error', fail);
    zipfile.readEntry();
  });

  await walk;
  await pipelineDone;
  return { files };
}
