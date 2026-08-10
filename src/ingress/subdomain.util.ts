/**
 * How a sandbox's public hostname label is decided.
 *
 * The rule that matters: a sandbox restored from a snapshot is published under
 * the SNAPSHOT's label, not its own id. `restoreInternal` mints a fresh
 * `sandboxId` on every restore, so publishing by sandbox id hands out a URL
 * that changes every session — useless for a service someone wants to link to,
 * and impossible to reactivate on visit because there is nothing stable to look
 * the snapshot up by.
 *
 * Pure module (no Docker, no Mongo, no Redis) so the label rules are unit
 * testable on their own.
 */

/**
 * A valid DNS label per RFC 1123: lowercase alphanumerics and hyphens, not at
 * either end. Length is checked separately (the DTO caps it at 63) so this
 * pattern stays readable.
 */
export const DNS_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Longest label DNS accepts. */
export const MAX_DNS_LABEL_LENGTH = 63;

export function isValidDnsLabel(label: string): boolean {
  return (
    typeof label === 'string' &&
    label.length > 0 &&
    label.length <= MAX_DNS_LABEL_LENGTH &&
    DNS_LABEL_PATTERN.test(label)
  );
}

/**
 * Turn an id into a valid DNS label. nanoid's URL-safe alphabet includes `-`
 * and `_`, but RFC 952/1123 forbid labels that start or end with a hyphen, and
 * most resolvers (libc getaddrinfo, browsers) refuse such hostnames even if the
 * authoritative DNS would return an answer.
 *
 * - Lowercases the id.
 * - Replaces `_` with `-` (underscore is invalid in hostnames at all).
 * - Prefixes `s` if the result would otherwise start with `-`.
 * - Suffixes `x` if it would otherwise end with `-`.
 *
 * Note this is lossy: nanoid is case-sensitive and DNS is not, so two distinct
 * ids can map to the same label. That is why an explicit `slug` carries a
 * unique index — it is the routing key, and a silent collision would send one
 * snapshot's traffic to another.
 */
export function toDnsLabel(id: string): string {
  let label = id.toLowerCase().replace(/_/g, '-');
  if (label.startsWith('-')) label = `s${label}`;
  if (label.endsWith('-')) label = `${label}x`;
  return label;
}

/**
 * The label a snapshot is served under: its slug when set, otherwise one
 * derived from its id. Every snapshot therefore has a stable URL with no
 * configuration at all; the slug only makes it memorable.
 */
export function subdomainForSnapshot(snapshot: {
  slug?: string | null;
  snapshotId: string;
}): string {
  const slug = snapshot.slug?.trim();
  if (slug) return slug.toLowerCase();
  return toDnsLabel(snapshot.snapshotId);
}
