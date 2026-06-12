// Basic `git log` — recent commits, optionally scoped to a path. Phase 5 ops
// (`recent_changes`, `why_this_line`) build on this; Phase 0 ships the wrapped
// primitive.

import type { Result } from '../../core/result.ts';
import { fail, ok } from '../../common/result/construct.ts';
import { isOk } from '../../common/result/narrow.ts';
import { runGit } from './run.ts';

export interface GitLogEntry {
  hash: string;
  authorName: string;
  /** ISO-8601 author date. */
  date: string;
  subject: string;
}

const FIELD_SEP = '\u001f'; // unit separator — never appears in subjects in practice

export async function gitLog(
  root: string,
  options: { path?: string; maxCount?: number },
): Promise<Result<readonly GitLogEntry[]>> {
  const args = [
    'log',
    `--max-count=${options.maxCount ?? 20}`,
    `--pretty=format:%H${FIELD_SEP}%an${FIELD_SEP}%aI${FIELD_SEP}%s`,
  ];
  if (options.path !== undefined) args.push('--', options.path);
  const result = await runGit(root, args);
  if (!isOk(result)) return fail(result.failure);

  const entries: GitLogEntry[] = [];
  for (const line of result.data.split('\n')) {
    if (line.length === 0) continue;
    const [hash, authorName, date, ...rest] = line.split(FIELD_SEP);
    if (hash === undefined || authorName === undefined || date === undefined) continue;
    entries.push({ hash, authorName, date, subject: rest.join(FIELD_SEP) });
  }
  return ok(entries);
}
