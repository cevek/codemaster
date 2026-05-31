import type { Request, RequestResult } from '../primitives/contracts.js';
import type { RepoId } from '../core/brands.js';

// The transport seam that makes the process model **optional** (ARCHITECTURE.md §2).
// The orchestrator reaches one workspace's engine through a `ProjectHost`; two
// interchangeable implementations, same contract:
//
//   in-process  → the engine runs inside the orchestrator process; a host call is a direct
//                 in-memory call. One process, one heap — trivial to debug, no IPC. Default
//                 at this stage. Tradeoff: a heavy synchronous call blocks the shared loop.
//   process     → one child process per workspace + an IPC round-trip. Own heap + GC, own
//                 `--max-old-space-size`, OS reclaims all memory on kill, crash-isolation,
//                 cross-workspace parallelism, non-blocking orchestrator. For scale.
//
// The engine is written once, transport-agnostic; the mode is chosen by
// `config.daemon.isolation` and never touches engine code. Only small request/result
// envelopes cross a host boundary — never the AST or the graph.

export interface ProjectHost {
  readonly repoId: RepoId;
  /** Dispatch a batch of requests to the workspace's engine; resolves in input order.
   *  In-process this is a direct call; process-isolated it is one IPC round-trip. */
  request(reqs: readonly Request[]): Promise<readonly RequestResult[]>;
  /** Tear down — drop references (in-process) or kill the child process (process). */
  dispose(): Promise<void>;
}
