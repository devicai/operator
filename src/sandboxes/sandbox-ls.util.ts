import { sh } from '../snapshots/snapshot-fs.util';

export interface SandboxFileEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  sizeBytes: number;
  /** ISO timestamp of the last modification, when the image's tools expose it. */
  mtime: string | null;
  /** Symlink target, for `type === 'symlink'`. */
  target?: string;
}

export type ListDirParseResult =
  | { entries: SandboxFileEntry[] }
  | { error: 'missing' | 'not_a_dir' };

const TAB = '\t';

/**
 * Shell script that emits one `type\tsize\tmtime-epoch\tname\tlink-target`
 * line per direct child of the directory. GNU `find -printf` does it in one
 * call; busybox images (alpine) fall back to a glob + `stat` loop producing
 * the same format. Sentinel first lines flag a missing path or a non-directory
 * so the caller can return a 400 instead of showing an empty folder.
 */
export function buildListDirScript(dirPath: string): string {
  const p = sh(dirPath);
  return [
    `P=${p}`,
    `if [ ! -e "$P" ]; then echo __MISSING__; exit 0; fi`,
    `if [ ! -d "$P" ]; then echo __NOT_A_DIR__; exit 0; fi`,
    `if find --version 2>/dev/null | grep -q GNU; then`,
    `find "$P" -mindepth 1 -maxdepth 1 -printf '%y${TAB}%s${TAB}%T@${TAB}%f${TAB}%l\\n'`,
    `else`,
    `for f in "$P"/* "$P"/.[!.]* "$P"/..?*; do`,
    `{ [ -e "$f" ] || [ -L "$f" ]; } || continue`,
    `t=f; if [ -L "$f" ]; then t=l; elif [ -d "$f" ]; then t=d; fi`,
    `sz=$(stat -c %s "$f" 2>/dev/null || echo 0)`,
    `mt=$(stat -c %Y "$f" 2>/dev/null || echo 0)`,
    `tgt=; if [ "$t" = l ]; then tgt=$(readlink "$f" 2>/dev/null); fi`,
    `printf '%s${TAB}%s${TAB}%s${TAB}%s${TAB}%s\\n' "$t" "$sz" "$mt" "\${f##*/}" "$tgt"`,
    `done`,
    `fi`,
  ].join('\n');
}

function typeFor(flag: string): SandboxFileEntry['type'] {
  switch (flag) {
    case 'f':
      return 'file';
    case 'd':
      return 'dir';
    case 'l':
      return 'symlink';
    default:
      return 'other';
  }
}

/**
 * Parse the script output into structured entries, directories first, then
 * case-insensitive alphabetical. Entries whose names embed tabs or newlines
 * fall off the parse (they'd corrupt the line format) — acceptable for a
 * file-browser listing.
 */
export function parseListDirOutput(stdout: string): ListDirParseResult {
  const trimmed = stdout.trimStart();
  if (trimmed.startsWith('__MISSING__')) return { error: 'missing' };
  if (trimmed.startsWith('__NOT_A_DIR__')) return { error: 'not_a_dir' };

  const entries: SandboxFileEntry[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(TAB);
    if (parts.length < 4) continue;
    const [flag, size, epoch, name, target] = parts;
    if (!name) continue;
    const epochSeconds = parseFloat(epoch);
    entries.push({
      name,
      type: typeFor(flag),
      sizeBytes: parseInt(size, 10) || 0,
      mtime: Number.isFinite(epochSeconds)
        ? new Date(epochSeconds * 1000).toISOString()
        : null,
      ...(target ? { target } : {}),
    });
  }

  entries.sort((a, b) => {
    const aDir = a.type === 'dir' ? 0 : 1;
    const bDir = b.type === 'dir' ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  return { entries };
}
