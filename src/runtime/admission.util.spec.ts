import {
  DEFAULT_IMAGE_ALLOWLIST,
  isImageAllowed,
  sanitizeHostPorts,
  stripImageTag,
} from './admission.util';

describe('stripImageTag', () => {
  it('strips a tag', () => {
    expect(stripImageTag('node:24')).toBe('node');
  });
  it('strips a digest', () => {
    expect(stripImageTag('debian@sha256:abc')).toBe('debian');
  });
  it('keeps a registry port and strips the tag', () => {
    expect(stripImageTag('registry.local:5000/team/app:1.2')).toBe(
      'registry.local:5000/team/app',
    );
  });
  it('leaves an untagged ref untouched', () => {
    expect(stripImageTag('ghcr.io/org/img')).toBe('ghcr.io/org/img');
  });
});

describe('isImageAllowed', () => {
  it('allows anything when the allowlist is empty', () => {
    expect(isImageAllowed('anything/at:all', [])).toBe(true);
    expect(isImageAllowed('anything/at:all', undefined)).toBe(true);
  });

  it('allows official images by bare name (tags ignored)', () => {
    expect(isImageAllowed('node:24', DEFAULT_IMAGE_ALLOWLIST)).toBe(true);
    expect(
      isImageAllowed('debian:bookworm-slim', DEFAULT_IMAGE_ALLOWLIST),
    ).toBe(true);
    expect(isImageAllowed('python', DEFAULT_IMAGE_ALLOWLIST)).toBe(true);
  });

  it('rejects an unlisted third-party image', () => {
    expect(
      isImageAllowed('eviluser/cryptominer:latest', DEFAULT_IMAGE_ALLOWLIST),
    ).toBe(false);
  });

  it('matches registry prefixes via trailing *', () => {
    expect(isImageAllowed('ghcr.io/org/app:1.0', ['ghcr.io/*'])).toBe(true);
    expect(isImageAllowed('gcr.io/p/i', ['ghcr.io/*'])).toBe(false);
  });

  it('matches a directory prefix via trailing /', () => {
    expect(isImageAllowed('team/app:1', ['team/'])).toBe(true);
    expect(isImageAllowed('team', ['team/'])).toBe(true);
    expect(isImageAllowed('teamster/app', ['team/'])).toBe(false);
  });

  it('matches an exact entry ignoring tags on both sides', () => {
    expect(isImageAllowed('node:20', ['node:18'])).toBe(true);
  });
});

describe('sanitizeHostPorts', () => {
  it('drops every host port when publishing is disabled', () => {
    const r = sanitizeHostPorts({ '8080': 80, '5000': 5000 }, { allow: false });
    expect(r.ports).toEqual({});
    expect(r.rejected.sort()).toEqual(['5000', '8080']);
  });

  it('keeps non-privileged ports when publishing is enabled', () => {
    const r = sanitizeHostPorts({ '8080': 80 }, { allow: true });
    expect(r.ports).toEqual({ '8080': 80 });
    expect(r.rejected).toEqual([]);
  });

  it('rejects privileged and out-of-range ports even when enabled', () => {
    const r = sanitizeHostPorts(
      { '80': 80, '22': 22, '70000': 1, '8443': 8443 },
      { allow: true },
    );
    expect(r.ports).toEqual({ '8443': 8443 });
    expect(r.rejected.sort()).toEqual(['22', '70000', '80']);
  });

  it('handles an undefined map', () => {
    expect(sanitizeHostPorts(undefined, { allow: false })).toEqual({
      ports: {},
      rejected: [],
    });
  });
});
