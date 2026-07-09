import { loadConfig } from './config.loader';

export interface UploadLimits {
  /** Max size (MiB) accepted for a snapshot ZIP import. */
  maxSnapshotZipMb: number;
  /** Max size (MiB) accepted for a single file upload into a sandbox. */
  maxFileMb: number;
}

let cached: UploadLimits | null = null;

/**
 * Upload size limits, resolved from the optional `uploads:` config block.
 * Read lazily (and cached) because multer's per-route `limits` are evaluated
 * at decorator time, before Nest's DI container exists; falls back to the
 * defaults when no config file is reachable (e.g. unit tests).
 */
export function uploadLimits(): UploadLimits {
  if (!cached) {
    let uploads: { maxSnapshotZipMb?: number; maxFileMb?: number } = {};
    try {
      uploads = loadConfig().uploads ?? {};
    } catch {
      uploads = {};
    }
    cached = {
      maxSnapshotZipMb: uploads.maxSnapshotZipMb ?? 512,
      maxFileMb: uploads.maxFileMb ?? 100,
    };
  }
  return cached;
}
