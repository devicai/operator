import { posix } from 'path';

/**
 * Raised when a caller asks to write to a path that resolves outside the
 * sandbox workspace. Pure error (no HTTP semantics) so this util stays
 * framework-agnostic and unit-testable; the service layer maps it to a 400.
 */
export class WorkspaceConfinementError extends Error {
  constructor(
    readonly requestedPath: string,
    readonly workdir: string,
    readonly op: 'write' | 'create directory' | 'upload' = 'write',
  ) {
    const suggestion = posix.join(
      workdir,
      posix.basename((requestedPath ?? '').trim()) || 'file',
    );
    super(
      `Cannot ${op} '${requestedPath}': sandbox file operations are restricted ` +
        `to the workspace directory '${workdir}'. Use a path inside the ` +
        `workspace, e.g. '${suggestion}' (relative paths are resolved against ` +
        `the workspace).`,
    );
    this.name = 'WorkspaceConfinementError';
  }
}

/**
 * Normalize a sandbox workdir into an absolute, slash-trimmed POSIX path.
 * Falls back to `/workspace` (the sandbox default) when empty.
 */
function normalizeWorkdir(workdir: string): string {
  const raw = (workdir ?? '').trim() || '/workspace';
  const abs = posix.isAbsolute(raw) ? raw : `/${raw}`;
  const norm = posix.normalize(abs);
  return norm === '/' ? '/' : norm.replace(/\/+$/, '');
}

/**
 * Resolve a caller-supplied path against the sandbox workspace and assert it
 * stays inside it.
 *
 * - Relative paths resolve against `workdir` (so `notes.md` → `<workdir>/notes.md`).
 * - Absolute paths are honoured as-is, then checked.
 * - `..` traversal that escapes the workspace (e.g. `../etc/passwd`,
 *   `/workspace/../tmp/x`) is rejected.
 *
 * Returns the normalized absolute path on success; throws
 * {@link WorkspaceConfinementError} when the target is outside the workspace.
 */
export function resolveWithinWorkspace(
  inputPath: string,
  workdir: string,
  op: 'write' | 'create directory' | 'upload' = 'write',
): string {
  const base = normalizeWorkdir(workdir);
  const raw = (inputPath ?? '').trim();
  if (!raw) throw new WorkspaceConfinementError(inputPath, base, op);

  // posix.resolve(base, raw): when `raw` is absolute it wins (and is
  // normalized); when relative it resolves against the workspace.
  const resolved = posix.resolve(base, raw);

  // A workdir of '/' means the whole filesystem is the workspace — nothing to
  // confine.
  if (base === '/') return resolved;

  if (resolved !== base && !resolved.startsWith(`${base}/`)) {
    throw new WorkspaceConfinementError(inputPath, base, op);
  }
  return resolved;
}

/**
 * Translate the leaky, low-level errors that the container runtime (dockerode /
 * microsandbox) surfaces into a single human/agent-actionable sentence. Returns
 * null when the error is not a recognised filesystem error so the caller can
 * rethrow the original.
 *
 * Why this exists: dockerode hardcodes `404 → 'no such container'` as the reason
 * phrase for *every* 404 on the `/archive` (get/putArchive) endpoint, so a
 * simple "path not found" copy surfaces as the contradictory
 * `(HTTP code 404) no such container - Could not find the file /tmp in container <id>`.
 * Forwarding that verbatim is what confused both the agent and the operator.
 */
export function describeRuntimeFsError(
  err: unknown,
  ctx: { path: string; op: 'read' | 'write' },
): string | null {
  const msg = (err as Error)?.message ?? '';
  const statusCode = (err as { statusCode?: number })?.statusCode;

  // dockerode archive 404 carries the real cause in the body even though the
  // reason phrase says "no such container". Check the path message FIRST.
  if (/Could not find the file/i.test(msg)) {
    return ctx.op === 'read'
      ? `File or directory '${ctx.path}' was not found in the sandbox.`
      : `Could not write '${ctx.path}': its parent directory does not exist ` +
          `in the sandbox.`;
  }

  // Genuine "container is gone" (expired/recycled/removed).
  if (/no such container/i.test(msg)) {
    return (
      `The sandbox is no longer available (it may have expired or been ` +
      `recycled). Create a new sandbox and retry.`
    );
  }

  if (statusCode === 404) {
    return ctx.op === 'read'
      ? `File or directory '${ctx.path}' was not found in the sandbox.`
      : `Could not write '${ctx.path}' in the sandbox.`;
  }

  return null;
}
