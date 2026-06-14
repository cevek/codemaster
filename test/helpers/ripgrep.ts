// The ripgrep cross-check oracle (§16). NOT a parity oracle — `find_usages` and grep are
// different sets by design (grep hits comments/strings/same-named unrelated symbols and
// misses aliased `import {X as Y}`…`<Y/>`); rg is here only to make that DISTINCTNESS
// concrete. Honest-skip when rg is absent: a box without ripgrep skips the cross-check,
// never silently passes and never hard-fails (the find_usages-side assertions stand alone).

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

export interface RgSite {
  /** Repo-relative, POSIX-style path. */
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  col: number;
}

function rgAvailable(): boolean {
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Word-boundary matches of `word` under `root` — one entry per match. Returns `undefined`
 *  when rg is not installed (the cross-check is then honest-skipped by the caller). */
export function rgSites(root: string, word: string): RgSite[] | undefined {
  if (!rgAvailable()) return undefined;
  let out: string;
  try {
    out = execFileSync('rg', ['-w', '--vimgrep', word, root], { encoding: 'utf8' });
  } catch (e) {
    // rg exits 1 with no output on zero matches — an empty set, not a failure.
    if ((e as { status?: number }).status === 1) return [];
    throw e;
  }
  const sites: RgSite[] = [];
  for (const raw of out.split('\n')) {
    if (raw.length === 0) continue;
    // --vimgrep emits `<abs-file>:<line>:<col>:<text>`, one line per match.
    const m = /^(.*?):(\d+):(\d+):/.exec(raw);
    if (m === null) continue;
    const [, file, line, col] = m;
    if (file === undefined || line === undefined || col === undefined) continue;
    sites.push({ file: path.relative(root, file).split('\\').join('/'), line: +line, col: +col });
  }
  return sites;
}
