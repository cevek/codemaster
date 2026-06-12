// Append text to a file, creating parent dirs — wrapped so a write failure (read-only
// dir, permission, ENOSPC) returns a `ToolFailure` instead of throwing (§3.6). The
// `feedback` op's only side effect goes through here.

import { appendFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type { Result } from '../../core/result.ts';
import { fail, ok } from '../../common/result/construct.ts';

/** Append `content` to `absPath`, creating its directory if needed. Returns `ok(true)` on
 *  success, or a `ToolFailure` (tool `'fs'`) — never throws. */
export function appendTextFile(absPath: string, content: string): Result<true> {
  try {
    mkdirSync(path.dirname(absPath), { recursive: true });
    appendFileSync(absPath, content, 'utf8');
    return ok(true);
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return fail({ tool: 'fs', message: `could not append to ${absPath}: ${message}` });
  }
}
