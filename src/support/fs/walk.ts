// Plain recursive file walk with the default ignore set (§10): `.git`, `node_modules`,
// `dist`, `build`, `.next`, editor temp files, and files over 1 MB. This is the
// *non-git fallback*; in a git repo the engine prefers `support/git/ls-files.ts`,
// which is exactly `.gitignore`-aware (nested + `!` negation) because git itself
// evaluates the rules — reimplementing gitignore semantics here would be a second,
// subtly-wrong oracle.

import { readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { Result } from '../../core/result.ts';
import type { RepoRelPath } from '../../core/brands.ts';
import { partial, ok } from '../../common/result/construct.ts';
import { toPosix } from './canonicalize.ts';
import { DEFAULT_IGNORED_DIRS, DEFAULT_IGNORED_FILES } from './ignored-paths.ts';

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

export interface WalkOptions {
  maxFileBytes?: number;
}

export interface WalkedFile {
  path: RepoRelPath;
  size: number;
  mtimeMs: number;
}

/** Walk `canonRoot` and return every tracked-looking file with its stat. Unreadable
 *  subtrees don't sink the walk — the result degrades to `partial`, never a guess. */
export function walkFiles(canonRoot: string, options?: WalkOptions): Result<WalkedFile[]> {
  const maxBytes = options?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const files: WalkedFile[] = [];
  const errors: string[] = [];

  const visit = (absDir: string, relDir: string): void => {
    let names: string[];
    try {
      names = readdirSync(absDir);
    } catch (thrown) {
      errors.push(`${relDir || '.'}: ${describe(thrown)}`);
      return;
    }
    for (const name of names.sort()) {
      const rel = relDir === '' ? name : `${relDir}/${name}`;
      const abs = path.join(absDir, name);
      let stats;
      try {
        stats = statSync(abs);
      } catch (thrown) {
        errors.push(`${rel}: ${describe(thrown)}`);
        continue;
      }
      if (stats.isDirectory()) {
        if (!DEFAULT_IGNORED_DIRS.has(name)) visit(abs, rel);
      } else if (stats.isFile()) {
        if (DEFAULT_IGNORED_FILES.test(name)) continue;
        if (stats.size > maxBytes) continue;
        files.push({ path: toPosix(rel) as RepoRelPath, size: stats.size, mtimeMs: stats.mtimeMs });
      }
    }
  };

  visit(canonRoot, '');
  if (errors.length > 0) {
    return partial(files, { tool: 'fs', message: `walk skipped: ${errors.join('; ')}` });
  }
  return ok(files);
}

function describe(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
