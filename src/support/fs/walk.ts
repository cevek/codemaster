// Plain recursive file walk with the default ignore set (§10): `.git`, `node_modules`,
// `dist`, `build`, `.next`, editor temp files, and files over 1 MB. This is the
// *non-git fallback*; in a git repo the engine prefers `support/git/ls-files.ts`,
// which is exactly `.gitignore`-aware (nested + `!` negation) because git itself
// evaluates the rules — reimplementing gitignore semantics here would be a second,
// subtly-wrong oracle.
//
// **Never-hang (§1) — the walk is bounded three ways.** It uses `lstatSync` and NEVER
// follows a symlink (dir OR file): a dir with ≥2 symlinks to an ancestor otherwise
// explodes into ~K^32 virtual paths — an eternal 100% CPU sync spin that kills the event
// loop (the t-895142 incident). A symlink's real content is indexed at its physical
// location; here it is skipped, counted, and disclosed — never silently dropped (§3.4).
// A depth bound and a hard entry-count cap defend against a pathological acyclic tree, and
// an optional wall-clock deadline (caller-supplied `now`, never `Date.now` here — §16)
// stops the sync walk on overrun with an honest `timeout` (§1: an honest "couldn't" beats
// a freeze). Any incomplete walk returns `partial`, never a guess dressed as complete.

import { lstatSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import type { Result } from '../../core/result.ts';
import type { RepoRelPath } from '../../core/brands.ts';
import { partial, ok } from '../../common/result/construct.ts';
import { toPosix } from './canonicalize.ts';
import { DEFAULT_IGNORED_DIRS, DEFAULT_IGNORED_FILES } from './ignored-paths.ts';

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_ENTRIES = 500_000;

export interface WalkOptions {
  maxFileBytes?: number;
  /** Deepest directory level to descend into. Beyond it, subtrees are skipped + disclosed. */
  maxDepth?: number;
  /** Hard cap on directory entries visited — the size bound against a huge acyclic tree. */
  maxEntries?: number;
  /** Injected clock reader for the wall-clock deadline (§16 — the walk never calls
   *  `Date.now` itself). Supplied together with `deadlineMs`; omit both to run unbounded
   *  in time (the depth/entry/symlink bounds still hold). */
  now?: () => number;
  /** Absolute epoch ms; once `now()` reaches it the walk stops with an honest `timeout`. */
  deadlineMs?: number;
}

export interface WalkedFile {
  path: RepoRelPath;
  size: number;
  mtimeMs: number;
}

/** The injectable shape of `walkFiles` — a test seam (mirrors `GitRunner` beside `runGit`) so a
 *  consumer can count / fault the walk without a real filesystem. Production uses `walkFiles`. */
export type WalkRunner = (root: string, options?: WalkOptions) => Result<WalkedFile[]>;

/** Walk `canonRoot` and return every tracked-looking file with its stat. An incomplete
 *  walk — unreadable subtree, an un-followed symlink, a depth/entry/time bound hit — never
 *  sinks the result: it degrades to `partial` with an honest reason, never a guess. */
export function walkFiles(canonRoot: string, options?: WalkOptions): Result<WalkedFile[]> {
  const maxBytes = options?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options?.now;
  const deadlineMs = options?.deadlineMs;

  const files: WalkedFile[] = [];
  const errors: string[] = [];
  let entries = 0;
  let skippedSymlinks = 0;
  let skippedDepth = 0;
  /** Set when a hard bound aborts the whole walk. Checked at every recursion level so the
   *  stack unwinds immediately instead of spinning the remaining tree. */
  let hardStop: 'capped' | 'timeout' | undefined;

  const visit = (absDir: string, relDir: string, depth: number): void => {
    if (hardStop !== undefined) return;
    let names: string[];
    try {
      names = readdirSync(absDir);
    } catch (thrown) {
      errors.push(`${relDir || '.'}: ${describe(thrown)}`);
      return;
    }
    for (const name of names.sort()) {
      if (hardStop !== undefined) return;
      // Size/time bounds first — the §1 never-hang guarantee, checked per entry.
      if (++entries > maxEntries) {
        hardStop = 'capped';
        return;
      }
      if (now !== undefined && deadlineMs !== undefined && now() >= deadlineMs) {
        hardStop = 'timeout';
        return;
      }
      // Ignored dir names (`node_modules`/`.claude`/…) skip WITHOUT an lstat and without a
      // skipped-symlink count — keeps the §10 exclusion honest and cheap (a symlinked ignored
      // dir is skipped for its name, never mislabelled as an un-followed source symlink).
      if (DEFAULT_IGNORED_DIRS.has(name)) continue;
      const rel = relDir === '' ? name : `${relDir}/${name}`;
      const abs = path.join(absDir, name);
      let stats;
      try {
        stats = lstatSync(abs);
      } catch (thrown) {
        errors.push(`${rel}: ${describe(thrown)}`);
        continue;
      }
      // Never follow a symlink (dir OR file) — the cycle-safety guarantee (§1). Counted +
      // disclosed below, never a silent drop (§3.4).
      if (stats.isSymbolicLink()) {
        skippedSymlinks++;
        continue;
      }
      if (stats.isDirectory()) {
        if (depth + 1 > maxDepth) {
          skippedDepth++;
          continue;
        }
        visit(abs, rel, depth + 1);
      } else if (stats.isFile()) {
        if (DEFAULT_IGNORED_FILES.test(name)) continue;
        if (stats.size > maxBytes) continue;
        files.push({ path: toPosix(rel) as RepoRelPath, size: stats.size, mtimeMs: stats.mtimeMs });
      }
    }
  };

  visit(canonRoot, '', 0);

  // A wall-clock overrun is the §1 timeout — an honest "couldn't verify in budget, fall back".
  if (hardStop === 'timeout') {
    return partial(files, {
      tool: 'timeout',
      message: `walk exceeded time budget after ${entries} entries`,
    });
  }
  // The entry cap and any un-followed symlink / too-deep / unreadable subtree are all
  // honest incompleteness — disclosed as `partial`, never a complete-looking answer (§3.4).
  const notes: string[] = [];
  if (hardStop === 'capped') notes.push(`entry cap ${maxEntries} reached`);
  if (skippedSymlinks > 0) notes.push(`${skippedSymlinks} symlink(s) not followed`);
  if (skippedDepth > 0) notes.push(`${skippedDepth} dir(s) beyond depth ${maxDepth}`);
  if (errors.length > 0) notes.push(`unreadable: ${errors.join('; ')}`);
  if (notes.length > 0) {
    return partial(files, { tool: 'fs', message: `walk incomplete: ${notes.join('; ')}` });
  }
  return ok(files);
}

function describe(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
