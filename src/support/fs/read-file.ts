// Read a file's UTF-8 text, wrapped → `ToolFailure` (§3.6). The plain read primitive the
// shape-based ops (codemod) use to load a file before transforming it.

import { readFileSync } from 'node:fs';
import type { Result } from '../../core/result.ts';
import { ok, failFromThrown } from '../../common/result/construct.ts';

export function readTextFile(absPath: string): Result<string> {
  try {
    return ok(readFileSync(absPath, 'utf8'));
  } catch (thrown) {
    return failFromThrown('fs', thrown);
  }
}
