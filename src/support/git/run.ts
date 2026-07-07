// The one wrapped chokepoint for spawning git (§3.6: every external-tool call is
// wrapped; a failure is an honest `ToolFailure`, never an escaped exception, never a
// guessed result). Everything else in `support/git/` goes through this.

import { execFile, execFileSync } from 'node:child_process';
import type { Result } from '../../core/result.ts';
import { fail, ok } from '../../common/result/construct.ts';

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** The injectable shape of `runGit` — a test seam (§3.6 fault injection via seams, never
 *  by breaking the host) threaded through the freshness path so a forced git failure is
 *  deterministic. Production always uses `runGit`; only tests pass a faulting runner. */
export type GitRunner = (cwd: string, args: readonly string[]) => Promise<Result<string>>;

export function runGit(cwd: string, args: readonly string[]): Promise<Result<string>> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: MAX_BUFFER_BYTES, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error !== null) {
          const detail = stderr.trim().length > 0 ? stderr.trim() : error.message;
          resolve(fail({ tool: 'git', message: `git ${args.join(' ')}: ${detail}` }));
          return;
        }
        resolve(ok(stdout));
      },
    );
  });
}

/** SYNCHRONOUS git through the same one chokepoint — for the rare caller that is itself synchronous
 *  and off the hot path (the TS file-set's `.gitignore` junk scan, run once per structural reindex).
 *  `timeout` bounds it (§1 never-hang; a timeout THROWS like ENOENT/non-zero exit and is caught
 *  here), so it can't spin. Prefer async `runGit` everywhere else. */
export function runGitSync(
  cwd: string,
  args: readonly string[],
  options?: { timeoutMs?: number },
): Result<string> {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      maxBuffer: MAX_BUFFER_BYTES,
      encoding: 'utf8',
      ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    });
    return ok(stdout);
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return fail({ tool: 'git', message: `git ${args.join(' ')}: ${message}` });
  }
}
