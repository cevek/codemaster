// Per-repo debug log wiring (§13): ~/.codemaster/<repoKey>/debug.log, routed by repoId.
// Split out of the orchestrator to keep that file under the line cap; one responsibility.

import * as path from 'node:path';
import type { RepoId } from '../core/brands.ts';
import type { DebugSystemHandle } from '../support/debug/system.ts';
import { fnv1a64Hex } from '../common/hash/fnv.ts';
import { createRotatingFileSink } from '../support/debug/file-sink.ts';

/** The repo's log DIRECTORY — `<stateDir>/<basename>-<hash>/`. Exported because the process-mode
 *  child's relayed stderr is a second log that must sit beside `debug.log` (one grep target for the
 *  agent) while owning its OWN file: a rotating sink keeps its byte count in memory, so two
 *  processes appending to one path rotate against each other and each `rename` destroys what the
 *  other just rotated out — the fatal dump is exactly what would be lost. Deriving the directory
 *  twice is how two spellings of one location drift apart, hence the shared helper. */
export function repoLogDir(stateDir: string, repoId: RepoId, root: string): string {
  return path.join(stateDir, `${path.basename(root)}-${fnv1a64Hex(repoId).slice(0, 8)}`);
}

/** Attach the rotating per-repo debug-log sink (routed by `repoId`), under
 *  `<stateDir>/<basename>-<hash>/debug.log`, capped at `logMaxMB` when set. */
export function attachRepoLogSink(
  debug: DebugSystemHandle,
  stateDir: string,
  repoId: RepoId,
  root: string,
  logMaxMB: number | undefined,
): void {
  const logMaxBytes = logMaxMB !== undefined ? logMaxMB * 1024 * 1024 : undefined;
  debug.addRoutedSink(
    repoId,
    createRotatingFileSink(path.join(repoLogDir(stateDir, repoId, root), 'debug.log'), logMaxBytes),
  );
}
