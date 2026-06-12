// `stat` → `FileFingerprint`, plus the hash-on-tie escalation (§19 racy-clean): when
// `compareFingerprints` answers `'tie'`, content alone decides — so this module also
// hashes file content on demand. Wrapped: a missing file is an answer, not a crash.

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { RepoRelPath } from '../../core/brands.ts';
import type { FileFingerprint } from '../../common/fingerprint/fingerprint.ts';

export type StatOutcome =
  | { state: 'present'; fingerprint: FileFingerprint }
  | { state: 'absent' }
  | { state: 'error'; message: string };

export function statFingerprint(canonRoot: string, rel: RepoRelPath, nowMs: number): StatOutcome {
  try {
    const stats = statSync(path.join(canonRoot, rel));
    if (!stats.isFile()) return { state: 'absent' };
    return {
      state: 'present',
      fingerprint: { path: rel, size: stats.size, mtimeMs: stats.mtimeMs, recordedAtMs: nowMs },
    };
  } catch (thrown) {
    if (isNotFound(thrown)) return { state: 'absent' };
    return { state: 'error', message: describe(thrown) };
  }
}

/** SHA-1 of file content — the tie-breaker. SHA-1 is fine here: change detection,
 *  not security. */
export function hashFileContent(
  canonRoot: string,
  rel: RepoRelPath,
): { ok: true; hash: string } | { ok: false; message: string } {
  try {
    const content = readFileSync(path.join(canonRoot, rel));
    return { ok: true, hash: createHash('sha1').update(content).digest('hex') };
  } catch (thrown) {
    return { ok: false, message: describe(thrown) };
  }
}

function isNotFound(thrown: unknown): boolean {
  return (
    typeof thrown === 'object' &&
    thrown !== null &&
    'code' in thrown &&
    ((thrown as { code?: string }).code === 'ENOENT' ||
      (thrown as { code?: string }).code === 'ENOTDIR')
  );
}

function describe(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
