// Does `<root>/<rel>` exist on disk? A cheap `statSync` probe (no file read) the non-TS
// plugins use in `reindex` to tell a modify from a delete in the changed set. Failure
// (ENOENT or any stat error) means "absent" — never throws (§3.6).

import { statSync } from 'node:fs';
import * as path from 'node:path';

export function fileExists(root: string, rel: string): boolean {
  try {
    statSync(path.join(root, rel));
    return true;
  } catch {
    return false;
  }
}
