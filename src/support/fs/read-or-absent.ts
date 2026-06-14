// Read `<root>/<rel>` as UTF-8, distinguishing three honest outcomes the non-TS plugins
// need in their per-file parse (§3.6): `text` (read it), `absent` (ENOENT — vanished
// between listing and reading, a watcher race, NOT an error), and `error` (a real IO
// failure — EACCES / EISDIR / fd exhaustion). Conflating `error` with `absent` would let
// an unreadable file read as "empty", a stale answer dressed as complete. Never throws.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

export type ReadOutcome =
  | { kind: 'text'; text: string }
  | { kind: 'absent' }
  | { kind: 'error'; message: string };

export function readTextOrAbsent(root: string, rel: string): ReadOutcome {
  try {
    return { kind: 'text', text: readFileSync(path.join(root, rel), 'utf8') };
  } catch (thrown) {
    if ((thrown as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'error', message: thrown instanceof Error ? thrown.message : String(thrown) };
  }
}
