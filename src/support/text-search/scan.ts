// Textual-occurrence scanner (spec-text-overlay §2) — the seam behind `find_usages
// text:true`. NOT a general text-search op: it only finds word-boundary, case-sensitive
// occurrences of an already-resolved symbol NAME, so the op can join them with semantic
// refs and flag the textual half `unresolved`. Pure-JS v1; a ripgrep impl can drop in
// behind `TextScanner` if profiling asks. All fs reads are wrapped (§3.6): a single
// unreadable file is skipped (best-effort), never blanks the scan.
//
// Boundary: `\b` word-boundary per the spec's literal "word-boundary" (word chars are
// [A-Za-z0-9_]) — so it matches `Foo` inside `$Foo` (the `$` is a non-word char). That
// edge is rare and the dedup against semantic refs removes the real ones; identifier-aware
// boundaries (treating `$` as part of the identifier) are a deferred wishlist item.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Result } from '../../core/result.ts';
import { ok } from '../../common/result/construct.ts';
import { computeLineStarts, offsetToLoc } from '../../common/span/offset.ts';
import { brandGitPath } from '../fs/canonicalize.ts';

/** A textual occurrence — a proof-carrying span over the live file. `file` is branded
 *  through the same chokepoint the semantic side uses, so span overlap (the anti-join)
 *  compares like-for-like (§19: two spellings of one file would silently break dedup). */
interface TextHit {
  file: RepoRelPath;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  text: string;
}

export interface TextScanner {
  /** Scan `files` (repo-relative, forward-slash, under `root`) for each name in `names`,
   *  bucketed by name. Files are read ONCE and matched against every name (O(tree), not
   *  O(tree·names)). Skips binaries and files over the size cap. A whole-scan failure
   *  returns a `ToolFailure`; per-file read errors are skipped. */
  scan(
    root: string,
    files: readonly string[],
    names: readonly string[],
  ): Result<Map<string, TextHit[]>>;
}

const MAX_FILE_BYTES = 1_000_000;

export function createJsScanner(): TextScanner {
  return { scan: scanJs };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scanJs(
  root: string,
  files: readonly string[],
  names: readonly string[],
): Result<Map<string, TextHit[]>> {
  const buckets = new Map<string, TextHit[]>();
  // One word-boundary, case-sensitive matcher per name (the spec's "the name", literal).
  const matchers = names.map((name) => {
    buckets.set(name, []);
    return { name, re: new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g') };
  });
  if (matchers.length === 0) return ok(buckets);

  for (const rel of files) {
    const content = readUtf8(path.join(root, rel));
    if (content === undefined) continue; // unreadable / binary / oversized → skipped
    const lineStarts = computeLineStarts(content);
    for (const { name, re } of matchers) {
      re.lastIndex = 0;
      const hits = buckets.get(name);
      if (hits === undefined) continue;
      for (let m = re.exec(content); m !== null; m = re.exec(content)) {
        const start = offsetToLoc(lineStarts, content.length, m.index);
        const end = offsetToLoc(lineStarts, content.length, m.index + name.length);
        if (start === undefined || end === undefined) continue;
        hits.push({
          file: brandGitPath(rel),
          line: start.line,
          col: start.col,
          endLine: end.line,
          endCol: end.col,
          text: name,
        });
      }
    }
  }
  return ok(buckets);
}

/** Read a file as UTF-8, or `undefined` when it can't contribute text hits: unreadable
 *  (skipped, not fatal — §3.6), over the size cap, or binary (a NUL byte). */
function readUtf8(abs: string): string | undefined {
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch {
    return undefined;
  }
  if (buf.length > MAX_FILE_BYTES || buf.includes(0)) return undefined;
  return buf.toString('utf8');
}
