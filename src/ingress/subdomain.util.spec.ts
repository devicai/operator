import {
  isValidDnsLabel,
  subdomainForSnapshot,
  toDnsLabel,
} from './subdomain.util';

describe('subdomain.util', () => {
  describe('toDnsLabel', () => {
    it.each([
      ['AbC123def456', 'abc123def456'],
      ['-pUsem7mCwab', 's-pusem7mcwab'],
      ['_abc123', 's-abc123'],
      ['foo_bar-baz', 'foo-bar-baz'],
      ['trailing-', 'trailing-x'],
      ['trailing_', 'trailing-x'],
    ])('turns %s into %s', (id, expected) => {
      expect(toDnsLabel(id)).toBe(expected);
      expect(isValidDnsLabel(toDnsLabel(id))).toBe(true);
    });

    // Why `slug` carries a unique index: nanoid distinguishes case and DNS does
    // not, so distinct snapshots can want the same hostname.
    it('is lossy — distinct ids can collapse onto the same label', () => {
      expect(toDnsLabel('AbCd')).toBe(toDnsLabel('aBcD'));
      expect(toDnsLabel('a_b')).toBe(toDnsLabel('a-b'));
    });
  });

  describe('isValidDnsLabel', () => {
    it.each(['a', 'my-app', 'app123', 'a'.repeat(63)])('accepts %s', (label) => {
      expect(isValidDnsLabel(label)).toBe(true);
    });

    it.each([
      ['', 'empty'],
      ['-lead', 'leading hyphen'],
      ['trail-', 'trailing hyphen'],
      ['UPPER', 'uppercase'],
      ['under_score', 'underscore'],
      ['has space', 'space'],
      ['a.b', 'dot (that is two labels)'],
      ['a'.repeat(64), 'over 63 chars'],
    ])('rejects %s (%s)', (label) => {
      expect(isValidDnsLabel(label)).toBe(false);
    });
  });

  describe('subdomainForSnapshot', () => {
    it('prefers the slug', () => {
      expect(
        subdomainForSnapshot({ slug: 'my-app', snapshotId: 'AbC123' }),
      ).toBe('my-app');
    });

    it('lowercases the slug, because hostnames are case-insensitive', () => {
      expect(subdomainForSnapshot({ slug: 'My-App', snapshotId: 'x' })).toBe(
        'my-app',
      );
    });

    it.each([undefined, null, '', '   '])(
      'derives from the id when the slug is %p',
      (slug) => {
        expect(subdomainForSnapshot({ slug, snapshotId: 'Snap_XY' })).toBe(
          'snap-xy',
        );
      },
    );
  });
});
