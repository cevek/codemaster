// Basic `git blame` for a line range — the wrapped primitive Phase 5's
// `why_this_line` composes. Porcelain format, parsed to (line → commit, author,
// summary).

import type { Result } from '../../core/result.ts';
import { fail, ok } from '../../common/result/construct.ts';
import { isOk } from '../../common/result/narrow.ts';
import { runGit } from './run.ts';

export interface BlameLine {
  /** 1-based line number in the current file. */
  line: number;
  hash: string;
  authorName: string;
  summary: string;
}

export async function gitBlame(
  root: string,
  path: string,
  startLine: number,
  endLine: number,
): Promise<Result<readonly BlameLine[]>> {
  const result = await runGit(root, [
    'blame',
    '--porcelain',
    '-L',
    `${startLine},${endLine}`,
    '--',
    path,
  ]);
  if (!isOk(result)) return fail(result.failure);

  const lines: BlameLine[] = [];
  const meta = new Map<string, { authorName: string; summary: string }>();
  let current: { hash: string; line: number } | undefined;
  for (const raw of result.data.split('\n')) {
    const header = raw.match(/^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/);
    if (header !== null) {
      const [, hash, finalLine] = header;
      if (hash !== undefined && finalLine !== undefined) {
        current = { hash, line: Number(finalLine) };
        if (!meta.has(hash)) meta.set(hash, { authorName: '', summary: '' });
      }
      continue;
    }
    if (current === undefined) continue;
    const entry = meta.get(current.hash);
    if (entry !== undefined && raw.startsWith('author ')) entry.authorName = raw.slice(7);
    if (entry !== undefined && raw.startsWith('summary ')) entry.summary = raw.slice(8);
    if (raw.startsWith('\t')) {
      // The content line closes one blame record.
      const m = meta.get(current.hash);
      lines.push({
        line: current.line,
        hash: current.hash,
        authorName: m?.authorName ?? '',
        summary: m?.summary ?? '',
      });
      current = undefined;
    }
  }
  return ok(lines);
}
