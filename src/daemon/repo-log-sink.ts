// Per-repo debug log wiring (§13): ~/.codemaster/<repoKey>/debug.log, routed by repoId.
// Split out of the orchestrator to keep that file under the line cap; one responsibility.

import * as path from 'node:path';
import type { RepoId } from '../core/brands.ts';
import type { DebugSystemHandle } from '../support/debug/system.ts';
import { fnv1a64Hex } from '../common/hash/fnv.ts';
import { createRotatingFileSink } from '../support/debug/file-sink.ts';

/** Attach the rotating per-repo debug-log sink (routed by `repoId`), under
 *  `<stateDir>/<basename>-<hash>/debug.log`, capped at `logMaxMB` when set. */
export function attachRepoLogSink(
  debug: DebugSystemHandle,
  stateDir: string,
  repoId: RepoId,
  root: string,
  logMaxMB: number | undefined,
): void {
  const repoKey = `${path.basename(root)}-${fnv1a64Hex(repoId).slice(0, 8)}`;
  const logMaxBytes = logMaxMB !== undefined ? logMaxMB * 1024 * 1024 : undefined;
  debug.addRoutedSink(
    repoId,
    createRotatingFileSink(path.join(stateDir, repoKey, 'debug.log'), logMaxBytes),
  );
}
