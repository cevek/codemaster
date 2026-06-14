// The ripgrep cross-check oracle (§16). NOT a parity oracle — `find_usages` and grep are
// different sets by design (grep hits comments/strings/same-named unrelated symbols and
// misses aliased `import {X as Y}`…`<Y/>`); rg is here only to make that DISTINCTNESS
// concrete. Honest-skip when rg is absent: a box without ripgrep skips the cross-check,
// never silently passes and never hard-fails (the find_usages-side assertions stand alone).
//
// EXCEPT in the CI gate. A skip is only honest for local dev; in CI a missing `rg` would
// silently no-op the entire semantic-≠-grep half of the harness to green. So when
// CODEMASTER_REQUIRE_RG is set (the CI workflow sets it), a missing `rg` is a hard,
// loud failure instead of a skip — the distinctness assertions can never silently vanish.

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

/** Is the CI fail-loud flag set? Any non-empty, non-`0` value counts as on (it errs toward
 *  fail-loud, so even `CODEMASTER_REQUIRE_RG=false` arms the gate). Exported so the parser is
 *  pinned by a hermetic unit test independent of whether `rg` is on the box. */
export function requireRg(): boolean {
  const v = process.env.CODEMASTER_REQUIRE_RG;
  return v !== undefined && v !== '' && v !== '0';
}

export type RgDecision = 'run' | 'skip' | 'throw';

/** Pure policy (the testable core): given whether `rg` is on the box and whether the CI
 *  fail-loud flag is set, decide what `rgSites` does. `rg` present → always run. `rg` absent
 *  → honest `skip` locally, but `throw` under the flag so the oracle can't silently no-op. */
export function rgDecision(available: boolean, requireFlag: boolean): RgDecision {
  if (available) return 'run';
  return requireFlag ? 'throw' : 'skip';
}

/** Word-boundary matches of `word` under `root` — one entry per match. Returns `undefined`
 *  when rg is not installed (the cross-check is then honest-skipped by the caller) — unless
 *  CODEMASTER_REQUIRE_RG is set, in which case a missing `rg` throws (CI fail-loud). */
export function rgSites(root: string, word: string): RgSite[] | undefined {
  const decision = rgDecision(rgAvailable(), requireRg());
  if (decision === 'throw') {
    throw new Error(
      'CODEMASTER_REQUIRE_RG is set but ripgrep (rg) is not installed — the find_usages ' +
        'distinctness oracle cannot run and must not silently skip in the gate. Install ' +
        'ripgrep, or unset CODEMASTER_REQUIRE_RG to allow the honest local skip.',
    );
  }
  if (decision === 'skip') return undefined;
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
