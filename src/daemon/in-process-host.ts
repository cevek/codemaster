// `in-process` `ProjectHost` (§2): the engine lives in the orchestrator's process; a
// host call is a direct in-memory call. The default — one heap, trivial to debug. The
// `process` host (child process + IPC round-trip, `process-host.ts`) is the isolation
// alternative, chosen by `config.daemon.isolation`; the seam means engine code is the
// same under both.

import type { ProjectHost } from './host.ts';
import type { WorkspaceEngine } from './engine.ts';

export function createInProcessHost(engine: WorkspaceEngine): ProjectHost {
  return {
    repoId: engine.repoId,
    isolation: 'in-process',
    request: (reqs, batch) => engine.request(reqs, batch),
    status: () => engine.status(),
    produceSql: (reqs) => engine.produceSql(reqs),
    dispose: () => engine.dispose(),
  };
}
