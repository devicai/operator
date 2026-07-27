import { LogLevel } from '@nestjs/common';

/**
 * Mirrors main.ts. Kept as a standalone copy because importing main.ts would
 * execute bootstrap() and stand up the whole application.
 */
const LOG_LEVELS: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];

function resolveLogLevels(level?: string): LogLevel[] {
  const index = level ? LOG_LEVELS.indexOf(level as LogLevel) : -1;
  if (index === -1) return LOG_LEVELS.slice(LOG_LEVELS.indexOf('log'));
  return LOG_LEVELS.slice(index);
}

describe('resolveLogLevels', () => {
  it('treats the configured level as a threshold, not a single channel', () => {
    // Regression: `debug` used to resolve to ['debug','error','warn'], which
    // dropped every logger.log() — boot banner, sandbox expiry, hot pool.
    expect(resolveLogLevels('debug')).toEqual([
      'debug',
      'log',
      'warn',
      'error',
      'fatal',
    ]);
  });

  it('keeps quieter levels out when a severe threshold is set', () => {
    expect(resolveLogLevels('warn')).toEqual(['warn', 'error', 'fatal']);
    expect(resolveLogLevels('error')).toEqual(['error', 'fatal']);
  });

  it('includes everything at verbose', () => {
    expect(resolveLogLevels('verbose')).toEqual(LOG_LEVELS);
  });

  it('defaults to log and above when unset or unrecognised', () => {
    const expected: LogLevel[] = ['log', 'warn', 'error', 'fatal'];
    expect(resolveLogLevels(undefined)).toEqual(expected);
    expect(resolveLogLevels('')).toEqual(expected);
    expect(resolveLogLevels('chatty')).toEqual(expected);
  });

  it('keeps errors for every level except the one that deliberately excludes them', () => {
    // `fatal` is the only threshold above `error`; asking for it is asking to
    // see nothing else. Every other setting — including a typo — keeps errors.
    const keepsErrors = LOG_LEVELS.filter((l) => l !== 'fatal');
    for (const level of [...keepsErrors, 'nonsense', undefined]) {
      expect(resolveLogLevels(level as string)).toContain('error');
    }
    expect(resolveLogLevels('fatal')).toEqual(['fatal']);
  });
});
