// Fingerprint comparison with the §19 racy-clean rule (the same one git's index
// implements): equal size + equal mtime normally proves "unchanged" — EXCEPT when the
// fingerprint was recorded within the filesystem's mtime-resolution window of the
// file's own mtime. In that window a later same-tick edit keeps the same stamp, so
// equality proves nothing; the comparison answers `'tie'` and the caller must hash
// content to decide. Silently answering 'same' there would be the silent-stale lie.

import type { FileFingerprint } from './fingerprint.ts';

export type FingerprintComparison = 'same' | 'changed' | 'tie';

/** Conservative default window: 2000 ms covers FAT (2 s), HFS+ (1 s) and network
 *  mounts with second-level mtime resolution. */
const DEFAULT_MTIME_RESOLUTION_MS = 2000;

export function compareFingerprints(
  recorded: FileFingerprint,
  current: FileFingerprint,
  mtimeResolutionMs: number = DEFAULT_MTIME_RESOLUTION_MS,
): FingerprintComparison {
  // Content hashes, when both sides carry them, are the strongest evidence.
  if (recorded.contentHash !== undefined && current.contentHash !== undefined) {
    return recorded.contentHash === current.contentHash ? 'same' : 'changed';
  }
  if (recorded.size !== current.size) return 'changed';
  if (recorded.mtimeMs !== current.mtimeMs) return 'changed';
  // Same size, same mtime. Racy-clean check: was the record taken so close to the
  // file's mtime that a same-tick edit could hide behind the same stamp?
  const { recordedAtMs } = recorded;
  if (recordedAtMs !== undefined && recordedAtMs - recorded.mtimeMs < mtimeResolutionMs) {
    return 'tie';
  }
  return 'same';
}
