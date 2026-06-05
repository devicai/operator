/**
 * Pure admission helpers shared by the sandbox service and the Docker runtime
 * provider: which images may be launched and which host-port publishings are
 * accepted. Side-effect free so it can be unit-tested without Docker.
 */

/**
 * Default image allowlist applied when `runtime.docker.images.allowlist` is not
 * set in config. Covers the common Docker Official Images (referenced by bare
 * name, i.e. `docker.io/library/*`) plus the major public registries. Operators
 * tighten this to their own registry, or widen it, via config.
 */
export const DEFAULT_IMAGE_ALLOWLIST: string[] = [
  // Docker Official Images (bare names → docker.io/library/*)
  'node',
  'python',
  'debian',
  'ubuntu',
  'alpine',
  'busybox',
  'bash',
  'golang',
  'rust',
  'ruby',
  'php',
  'openjdk',
  'eclipse-temurin',
  'gcc',
  // Common public registries (prefix matches)
  'docker.io/library/*',
  'mcr.microsoft.com/*',
  'ghcr.io/*',
  'gcr.io/*',
  'public.ecr.aws/*',
  'registry.k8s.io/*',
  'quay.io/*',
];

/**
 * Strip the `:tag` and/or `@sha256:...` digest from an image reference, leaving
 * the repository path. A `:` is only a tag separator when it appears after the
 * last `/` (otherwise it is a registry port, e.g. `host:5000/repo`).
 */
export function stripImageTag(image: string): string {
  let s = image.trim();
  const at = s.indexOf('@');
  if (at !== -1) s = s.slice(0, at);
  const lastSlash = s.lastIndexOf('/');
  const lastColon = s.lastIndexOf(':');
  if (lastColon > lastSlash) s = s.slice(0, lastColon);
  return s;
}

/**
 * Whether `image` is permitted by `allowlist`. An empty/undefined allowlist
 * allows everything (back-compat). An entry matches when:
 *   - it ends in `*`  → prefix match on the repo path, or
 *   - it ends in `/`  → the repo equals the prefix without the slash, or starts with it, or
 *   - otherwise       → exact repo match (tags ignored on both sides).
 */
export function isImageAllowed(image: string, allowlist?: string[]): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  const repo = stripImageTag(image);
  if (!repo) return false;
  for (const raw of allowlist) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.endsWith('*')) {
      if (repo.startsWith(entry.slice(0, -1))) return true;
    } else if (entry.endsWith('/')) {
      const prefix = entry.slice(0, -1);
      if (repo === prefix || repo.startsWith(entry)) return true;
    } else if (repo === stripImageTag(entry)) {
      return true;
    }
  }
  return false;
}

export interface SanitizedPorts {
  /** Host→guest port mappings that passed the policy. */
  ports: Record<string, number>;
  /** Host ports that were dropped (publishing disabled or out of range). */
  rejected: string[];
}

/**
 * Apply the host-port-publishing policy to a user-supplied `ports` map.
 *
 * When `allow` is false (the default) every entry is rejected: public exposure
 * goes through the ingress proxy, which never needs a host port. When `allow`
 * is true, only privileged-safe ports (>1024, ≤65535) are kept; the caller is
 * responsible for binding them to loopback.
 */
export function sanitizeHostPorts(
  ports: Record<string, number> | undefined,
  opts: { allow: boolean },
): SanitizedPorts {
  const kept: Record<string, number> = {};
  const rejected: string[] = [];
  for (const [host, guest] of Object.entries(ports ?? {})) {
    if (!opts.allow) {
      rejected.push(host);
      continue;
    }
    const hp = Number(host);
    if (!Number.isInteger(hp) || hp <= 1024 || hp > 65535) {
      rejected.push(host);
      continue;
    }
    kept[host] = guest;
  }
  return { ports: kept, rejected };
}
