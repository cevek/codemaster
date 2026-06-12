// `FileFingerprint` — the currency every plugin's `freshness()` deals in
// (ARCHITECTURE.md §5-L0.5, §8). Captured from `stat` by `support/fs`; compared with
// the §19 racy-clean semantics in ./compare.ts.

import type { RepoRelPath } from '../../core/brands.ts';

export interface FileFingerprint {
  path: RepoRelPath;
  /** Byte size from stat. */
  size: number;
  /** Modification time in milliseconds (as reported — resolution varies by FS). */
  mtimeMs: number;
  /** Content hash, present only when it has been computed (e.g. on an mtime tie). */
  contentHash?: string;
  /** Clock time (ms) when this fingerprint was recorded. Powers the §19 racy-clean
   *  rule: a record taken within the FS mtime-resolution window of the file's own
   *  mtime cannot prove a later same-tick edit didn't happen. */
  recordedAtMs?: number;
}
