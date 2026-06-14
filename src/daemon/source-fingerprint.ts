// Codemaster's OWN source fingerprint — the self-staleness signal (§3.6 applied to the
// tool itself: the daemon must not silently serve behavior older than its source). Split
// out of the orchestrator to keep that file under the line cap; pure, one responsibility.

import { fileURLToPath } from 'node:url';
import { walkFiles } from '../support/fs/walk.ts';
import { rollupFingerprint } from '../common/fingerprint/rollup.ts';

/** A size+mtime rollup over `src/**` (this module sits in `src/daemon/`). Reuses the §3.5
 *  rollup + the `support/fs` walker — no second fingerprinter. Returns `'unknown'` if the
 *  source tree can't be located/walked (a global/`npx` install where `src/` isn't beside the
 *  running code — a known forward-risk, §19); `'unknown'` disables the staleness signal
 *  rather than firing a false positive. */
/** The staleness verdict: source moved since spawn. `'unknown'` on EITHER side disables the
 *  signal — an unlocatable source tree at spawn (global/npx) OR a transient walk failure on
 *  a later read (EMFILE/ENOENT mid-walk) must never fire a false "behind source", the exact
 *  lie this signal exists to prevent. Only two real, differing fingerprints report stale. */
function isSourceStale(spawn: string, current: string): boolean {
  return spawn !== 'unknown' && current !== 'unknown' && current !== spawn;
}

export interface SourceStaleTracker {
  stale(): boolean;
}

/** Pins the spawn fingerprint once, then answers `stale()` from a short-TTL cache — the
 *  source only moves on a dev rebuild, so re-walking `src/` on EVERY op would block the
 *  orchestrator loop (§2/§8) for a signal that changes seconds apart at most. `nowMs` is the
 *  injected clock (no `Date.now` — §16). */
export function createSourceStaleTracker(
  nowMs: () => number,
  fingerprint: () => string = defaultSourceFingerprint,
  ttlMs = 1500,
): SourceStaleTracker {
  const spawn = fingerprint();
  let lastCheckMs = -Infinity;
  let verdict = false;
  return {
    stale() {
      const now = nowMs();
      if (now - lastCheckMs >= ttlMs) {
        lastCheckMs = now;
        verdict = isSourceStale(spawn, fingerprint());
      }
      return verdict;
    },
  };
}

/** A size+mtime rollup over codemaster's OWN `src/**` `.ts` sources (this module sits in
 *  `src/daemon/`). Reuses the §3.5 rollup + the `support/fs` walker — no second
 *  fingerprinter. Only `.ts`/`.tsx` count, so editing a doc/asset under `src/` doesn't
 *  falsely read as a behavior change. Returns `'unknown'` if the source tree can't be
 *  located/walked (a global/`npx` install — a known forward-risk, §19); `'unknown'`
 *  disables the staleness signal rather than firing a false positive. */
export function defaultSourceFingerprint(): string {
  try {
    const srcDir = fileURLToPath(new URL('..', import.meta.url));
    const walked = walkFiles(srcDir);
    if (!walked.ok) return 'unknown';
    return rollupFingerprint(walked.data.filter((f) => /\.tsx?$/.test(f.path)));
  } catch {
    return 'unknown';
  }
}
