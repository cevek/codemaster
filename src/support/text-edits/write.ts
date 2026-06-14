// Atomic file write for the apply path: write the full new content to a sibling temp
// file, then `rename` it over the target. A `rename` within one directory is atomic on
// every supported filesystem, so a reader of the target never sees a half-written file —
// and if anything fails before the rename, the original is byte-for-byte untouched (we
// never opened it). Wrapped → `ToolFailure` (§3.6); an exception never escapes.

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Result } from '../../core/result.ts';
import { fail, ok, messageOfThrown } from '../../common/result/construct.ts';

// Monotonic per-process suffix — keeps concurrent writes within one process from
// colliding on the temp name without reaching for a clock or randomness.
let tempCounter = 0;

/** Write `content` to `absPath` atomically (temp-then-rename), creating parent dirs.
 *  Returns `ok(true)` on success or a `ToolFailure` (tool `'fs'`) — never throws. On
 *  failure the target file is left exactly as it was. */
export function writeFileAtomic(absPath: string, content: string): Result<true> {
  const dir = path.dirname(absPath);
  const temp = path.join(dir, `.${path.basename(absPath)}.${process.pid}.${tempCounter++}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(temp, content, 'utf8');
    renameSync(temp, absPath);
    return ok(true);
  } catch (thrown) {
    // Best-effort cleanup of the temp file; the target itself was never touched.
    try {
      rmSync(temp, { force: true });
    } catch {
      /* the temp may not exist — nothing to clean. */
    }
    return fail({ tool: 'fs', message: `could not write ${absPath}: ${messageOfThrown(thrown)}` });
  }
}
