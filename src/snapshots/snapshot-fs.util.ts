/**
 * Pure helpers for full-filesystem snapshots.
 *
 * A "full" snapshot captures the container's filesystem *diff* against its base
 * image (everything `docker diff` reports — installed packages, /usr/local/bin
 * binaries, /etc configs — not just the workdir). To keep the artifact small we
 * archive only the changed paths and skip regenerable caches.
 *
 * This module is intentionally side-effect free (no Docker, no fs): it only
 * decides which paths to keep and builds the shell snippets the service runs
 * inside the sandbox. That keeps it unit-testable.
 */

export type CleanupPreset = 'conservative' | 'none' | 'aggressive';

/** Pseudo / runtime filesystems and our own temp files — never snapshot these. */
const ALWAYS_EXCLUDE_PREFIXES = [
  '/proc',
  '/sys',
  '/dev',
  '/tmp',
  '/run',
  '/var/run',
  '/var/lock',
];

/**
 * Package-manager and tooling caches that any build can recreate. Note `/home`
 * is deliberately NOT here (users may keep real files there); only concrete
 * cache directories are listed.
 */
const CONSERVATIVE_EXCLUDE_PREFIXES = [
  '/var/lib/apt/lists',
  '/var/cache/apt',
  '/var/cache/debconf',
  '/root/.npm',
  '/root/.cache',
  '/usr/local/share/.cache',
];

/** Logs / docs / locale — safe to drop when squeezing disk hardest. */
const AGGRESSIVE_EXTRA_PREFIXES = [
  '/var/log',
  '/usr/share/man',
  '/usr/share/doc',
  '/usr/share/locale',
];

/** Path *segments* (any component equal to this) that are pure cache. */
const SEGMENT_EXCLUDES = ['__pycache__'];

/** Multi-segment cache directories matched anywhere in the path. */
const SUBPATH_EXCLUDES = ['node_modules/.cache'];

export interface ExcludeConfig {
  cleanup: CleanupPreset;
  /** Extra absolute prefixes or segment/subpath patterns from config. */
  extra?: string[];
}

/**
 * Build the predicate that decides whether a path is excluded from a full
 * snapshot. Used both to filter the `docker diff` list and the delete manifest.
 */
export function buildExcludeMatcher(cfg: ExcludeConfig): (path: string) => boolean {
  const prefixes = [...ALWAYS_EXCLUDE_PREFIXES];
  if (cfg.cleanup !== 'none') prefixes.push(...CONSERVATIVE_EXCLUDE_PREFIXES);
  if (cfg.cleanup === 'aggressive') prefixes.push(...AGGRESSIVE_EXTRA_PREFIXES);

  const segments = [...SEGMENT_EXCLUDES];
  const subpaths = [...SUBPATH_EXCLUDES];
  for (const e of cfg.extra ?? []) {
    if (e.startsWith('/')) prefixes.push(e.replace(/\/+$/, ''));
    else if (e.includes('/')) subpaths.push(e);
    else segments.push(e);
  }

  return (raw: string): boolean => {
    const p = raw.startsWith('/') ? raw : `/${raw}`;
    for (const pre of prefixes) {
      if (p === pre || p.startsWith(`${pre}/`)) return true;
    }
    const comps = p.split('/');
    if (comps.some((c) => c.startsWith('.devic-runtime-'))) return true;
    for (const seg of segments) {
      if (comps.includes(seg)) return true;
    }
    for (const sub of subpaths) {
      if (p.includes(`/${sub}/`) || p.endsWith(`/${sub}`)) return true;
    }
    return false;
  };
}

/**
 * Concrete directories a commit-based save deletes before sealing the layer.
 *
 * The tarball path filters these out while building its file list; a commit has
 * no list to filter, so the only way to keep them out of the image is to remove
 * them from the container first. Measured: a file created and deleted within
 * the same session leaves a 16.4 kB layer, i.e. the delete genuinely reclaims
 * the bytes rather than stacking a marker on top of them.
 *
 * Deliberately narrower than `buildExcludeMatcher`:
 *
 * - The pseudo-filesystems (/proc, /sys, /dev, /run) are excluded from archives
 *   but must never be deleted from a live container. They are absent here.
 * - /tmp is left alone too: it is excluded from snapshots, but a running
 *   process may well be using it, and this runs while the sandbox is still up.
 * - The segment and sub-path patterns (`__pycache__`, `node_modules/.cache`)
 *   would need a full filesystem walk to resolve, which is the cost this whole
 *   path exists to avoid. They stay in the image until consolidation, which
 *   rebuilds through the matcher, sweeps them out.
 *
 * Only ever called for a sandbox that is about to be torn down.
 */
export function cleanupPrefixes(cfg: ExcludeConfig): string[] {
  if (cfg.cleanup === 'none') return [];
  const prefixes = [...CONSERVATIVE_EXCLUDE_PREFIXES];
  if (cfg.cleanup === 'aggressive') prefixes.push(...AGGRESSIVE_EXTRA_PREFIXES);
  for (const e of cfg.extra ?? []) {
    if (e.startsWith('/')) prefixes.push(e.replace(/\/+$/, ''));
  }
  // A path that is not a concrete child of root would widen the rm below into
  // something nobody asked for.
  return prefixes.filter((p) => /^\/[^/]/.test(p) && !p.split('/').includes('..'));
}

export interface FullCapturePartition {
  /** Changed/added paths to archive, made relative to `/` (no leading slash). */
  present: string[];
  /** Deleted paths (absolute) to `rm -rf` on restore. */
  deletes: string[];
  excludedCount: number;
}

/**
 * Split a `docker diff` result into the paths to archive vs the paths that were
 * deleted vs the ones we drop, applying the exclude matcher to both kept and
 * deleted sets (no point recording a delete under an excluded cache).
 */
export function partitionChanges(
  changes: Array<{ path: string; kind: 'A' | 'C' | 'D' }>,
  isExcluded: (p: string) => boolean,
): FullCapturePartition {
  const present: string[] = [];
  const deletes: string[] = [];
  let excludedCount = 0;
  for (const c of changes) {
    if (isExcluded(c.path)) {
      excludedCount++;
      continue;
    }
    if (c.kind === 'D') deletes.push(c.path);
    else present.push(c.path.replace(/^\/+/, '')); // relative to /
  }
  return { present, deletes, excludedCount };
}

/** Shell-quote a single argument for POSIX sh. */
export function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Whether a delete path is safe to `rm -rf` on restore. Rejects anything that
 * is not a concrete absolute path (no root, no relative, no traversal).
 */
export function isSafeDeletePath(p: string): boolean {
  return (
    typeof p === 'string' &&
    p.startsWith('/') &&
    p !== '/' &&
    !p.split('/').includes('..')
  );
}
