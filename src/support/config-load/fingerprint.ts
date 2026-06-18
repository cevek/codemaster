// The config-change fingerprint (config-reload) — a cheap, content-exact signal of
// "has `codemaster.config.*` changed since the engine was configured from it?". The
// orchestrator takes it on every request entry (the read-path is the correctness
// guarantee — §3.5 — never the watcher) and evicts the engine on drift so the next
// request lazily re-spawns with the fresh plugin set / config-derived options.
//
// Content-hash (not stat) on purpose: a single tiny file, so hashing every entry is
// bounded and sub-ms — and it never misses a same-tick edit (the §19 racy-clean window
// that a size+mtime stat has), which also makes the change deterministic for tests.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { resolveConfigBasename } from './resolve.ts';

/** No config file present — the repo runs on defaults (§10). A real fingerprint, so a
 *  config ADDED where none existed (`'none'` → `basename@hash`) reads as drift. */
export const NO_CONFIG_FINGERPRINT = 'none';

/** Read failed (a config deleted mid-resolve, an unreadable file) — drift is NOT proven,
 *  so the orchestrator must not evict on it (`configChanged` treats `'unknown'` as
 *  inconclusive). The next request re-reads and self-corrects; never a crash, never a
 *  false eviction storm. Mirrors the source-staleness signal's `'unknown'` (§3.6). */
const UNKNOWN_CONFIG_FINGERPRINT = 'unknown';

/** `basename@sha1(content)` — the one format both the loader (over the exact bytes it
 *  evaluated) and the request-entry check (over current disk bytes) must produce, so
 *  identical bytes ⇒ identical string. SHA-1 is change detection, not security. */
export function fingerprintConfigContent(basename: string, content: Buffer): string {
  return `${basename}@${createHash('sha1').update(content).digest('hex')}`;
}

/** Current on-disk config fingerprint at `canonRoot`. `'none'` (no config), `'unknown'`
 *  (resolve/read failed — inconclusive), or `basename@hash`. */
export function configFingerprint(canonRoot: string): string {
  let basename: string | undefined;
  try {
    basename = resolveConfigBasename(canonRoot);
  } catch {
    return UNKNOWN_CONFIG_FINGERPRINT;
  }
  if (basename === undefined) return NO_CONFIG_FINGERPRINT;
  try {
    return fingerprintConfigContent(basename, readFileSync(path.join(canonRoot, basename)));
  } catch {
    return UNKNOWN_CONFIG_FINGERPRINT;
  }
}

/** Did the config provably change between `prev` (stored at spawn — the bytes the engine
 *  was configured from) and `next` (current)? Drift only when BOTH are real and differ;
 *  an `'unknown'` on either side is inconclusive (never a false evict — §1 never-crash). */
export function configChanged(prev: string, next: string): boolean {
  return (
    prev !== UNKNOWN_CONFIG_FINGERPRINT && next !== UNKNOWN_CONFIG_FINGERPRINT && prev !== next
  );
}
