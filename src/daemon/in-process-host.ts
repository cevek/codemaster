// `in-process` `ProjectHost` (§2): the engine lives in the orchestrator's process; a
// host call is a direct in-memory call. The default at this stage — one heap, trivial
// to debug. The `process` host (child process + IPC round-trip) lands when scale
// demands it; the seam means engine code will not change when it does.

import type { ProjectHost } from './host.ts';
import type { WorkspaceEngine } from './engine.ts';

export function createInProcessHost(engine: WorkspaceEngine): ProjectHost & {
  /** In-process only: direct access for `status` (no serialization boundary). */
  engine: WorkspaceEngine;
} {
  return {
    repoId: engine.repoId,
    engine,
    request: (reqs, batch) => engine.request(reqs, batch),
    dispose: () => engine.dispose(),
  };
}
