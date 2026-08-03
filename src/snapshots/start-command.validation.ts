import { execFile } from 'child_process';

/**
 * Static checks on a snapshot's start command.
 *
 * A start command fails silently by construction: the restore path launches it
 * detached (`nohup ... &`), so the shell reports success whether or not the
 * command went on to start anything. Nothing surfaces until someone visits the
 * URL and gets a 502 minutes later. These checks are what can be said about a
 * command without running it, so the caller that writes it hears about the
 * problem while it still has the context to fix it.
 */

export type StartCommandWarningCode =
  | 'PGREP_SELF_MATCH'
  | 'PKILL_SELF_MATCH'
  | 'SYNTAX_ERROR';

export interface StartCommandWarning {
  code: StartCommandWarningCode;
  message: string;
  /** What to do instead. Present whenever there is a concrete alternative. */
  fix?: string;
}

/**
 * A `pgrep`/`pkill` call and its arguments, up to whatever ends the command —
 * a separator, a redirection, or the end of a subshell. Stopping at `>` keeps
 * `>/dev/null` from being read as the pattern, which is the shape these guards
 * are almost always written in.
 */
const PROCESS_MATCH_RE = /\bp(grep|kill)\b([^;&|\n()<>]*)/g;

const SYNTAX_CHECK_TIMEOUT_MS = 2000;

/** Split on whitespace, keeping quoted runs together and unquoting them. */
function tokenize(argv: string): string[] {
  const tokens = argv.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return tokens.map((t) =>
    (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))
      ? t.slice(1, -1)
      : t,
  );
}

/**
 * The pattern a `pgrep -f` / `pkill -f` call searches for, or null when the
 * call does not match on the full command line.
 *
 * Both tools take the pattern last, after the flags — which is what makes this
 * readable without a table of which flags consume a value: find `-f` among the
 * short flags, then take the final non-flag token.
 */
function fullCommandLinePattern(argv: string): string | null {
  const tokens = tokenize(argv);
  const flags = tokens.filter((t) => t.startsWith('-'));
  const matchesFullLine = flags.some(
    (f) => !f.startsWith('--') && f.slice(1).includes('f'),
  );
  if (!matchesFullLine) return null;

  const last = tokens[tokens.length - 1];
  return !last || last.startsWith('-') ? null : last;
}

/**
 * Warnings that need nothing but the text of the command.
 */
export function validateStartCommand(command: string): StartCommandWarning[] {
  const warnings: StartCommandWarning[] = [];
  const trimmed = command?.trim();
  if (!trimmed) return warnings;

  for (const match of trimmed.matchAll(PROCESS_MATCH_RE)) {
    const tool = match[1] === 'grep' ? 'pgrep' : 'pkill';
    const pattern = fullCommandLinePattern(match[2]);
    if (!pattern) continue;

    // `-f` matches against a process's whole command line — including the one
    // of the shell evaluating this very check, whose command line is the start
    // command itself. So the pattern finds itself, and it is written right
    // there in the text: no need to guess, just run it against the command.
    // A pattern built at runtime (`pgrep -f "$PAT"`) won't match, and is the
    // one case where such a guard does work.
    let selfMatches: boolean;
    try {
      selfMatches = new RegExp(pattern).test(trimmed);
    } catch {
      // An invalid regex is pgrep's problem to report, not ours.
      continue;
    }
    if (!selfMatches) continue;

    warnings.push(
      tool === 'pgrep'
        ? {
            code: 'PGREP_SELF_MATCH',
            message:
              `pgrep -f ${JSON.stringify(pattern)} matches this start command ` +
              'itself. The pattern is written in the command line of the shell ' +
              'that runs it, so the search always finds a process and the guard ' +
              'never lets anything start — silently, with an empty log.',
            fix:
              'Drop the guard: a restore always begins from a freshly created ' +
              'container, so nothing is running yet. If you do need it to be ' +
              'idempotent, test the port instead of the process list, e.g. ' +
              '(exec 3<>/dev/tcp/127.0.0.1/3000) 2>/dev/null || <start it>',
          }
        : {
            code: 'PKILL_SELF_MATCH',
            message:
              `pkill -f ${JSON.stringify(pattern)} matches this start command ` +
              'itself, so it kills the shell running it. Nothing after that ' +
              'point in the command will run.',
            fix:
              'Drop it: a restore starts from a fresh container, so there is no ' +
              'previous process to clean up.',
          },
    );
  }

  return warnings;
}

/**
 * Parse the command with the shell that will run it, without executing it.
 * `sh -n` reads and parses, then stops — it is the real parser, so unbalanced
 * quotes or a missing `fi` are reported exactly, with no false positives that
 * a hand-written scanner would produce.
 *
 * Returns no warning when the shell is unavailable: an environment without
 * `sh` cannot run the command either, and that is a louder failure elsewhere.
 */
export function checkStartCommandSyntax(
  command: string,
): Promise<StartCommandWarning[]> {
  const trimmed = command?.trim();
  if (!trimmed) return Promise.resolve([]);

  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-n', '-c', trimmed],
      { timeout: SYNTAX_CHECK_TIMEOUT_MS },
      (err, _stdout, stderr) => {
        if (!err) return resolve([]);
        const detail = (stderr || '').trim().split('\n')[0];
        // No diagnostic means the shell itself failed to run (missing, timed
        // out, killed) rather than the command failing to parse.
        if (!detail) return resolve([]);
        resolve([
          {
            code: 'SYNTAX_ERROR',
            message: `The shell cannot parse this command: ${detail}`,
            fix: 'Check for unbalanced quotes or an unclosed if/for/while block.',
          },
        ]);
      },
    );
  });
}

/** Every static check, in the order a reader should hear about them. */
export async function inspectStartCommand(
  command: string,
): Promise<StartCommandWarning[]> {
  const syntax = await checkStartCommandSyntax(command);
  // Syntax first: a command that does not parse never reaches its guards, so
  // reporting those alongside would be noise.
  return syntax.length ? syntax : validateStartCommand(command);
}
