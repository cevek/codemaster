import type { BatchOptions, OpRequest, OpResult } from '../ops/contracts.ts';
import type { RepoId } from '../core/brands.ts';
import type { FreshnessNote } from '../core/result.ts';
import type { WorkspaceStatusView } from '../format/render/render-status.ts';

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
// `config.daemon.isolation` and never touches engine code. Only small op request/result
// envelopes cross a host boundary — never plugin internals.

export interface ProjectHost {
  readonly repoId: RepoId;
  /** Which transport backs this host — surfaced by `status` so an agent sees the real mode
   *  of the resolved workspace, never a hard-coded guess. */
  readonly isolation: 'in-process' | 'process';
  /** Dispatch a batch of op requests to the workspace's engine; resolves in input order.
   *  In-process this is a direct call; process-isolated it is one IPC round-trip.
   *  `batch` carries sql-mode options (§5) when present. */
  request(reqs: readonly OpRequest[], batch?: BatchOptions): Promise<readonly OpResult[]>;
  /** The per-repo status manifest (§11). In-process a direct engine read; process-isolated
   *  one IPC round-trip. Reached through the seam so the orchestrator never casts to the
   *  engine (which a process host doesn't hold). */
  status(): Promise<WorkspaceStatusView>;
  /** Cross-root sql (§2): produce these requests as sql-producers (uncapped, one freshness
   *  capture) with no SELECT — the orchestrator joins across engines. A process host that
   *  cannot marshal producers answers honestly; it never fabricates a join input. */
  produceSql(
    reqs: readonly OpRequest[],
  ): Promise<{ results: readonly OpResult[]; freshness: FreshnessNote | undefined }>;
  /** Tear down — drop references (in-process) or kill the child process (process). */
  dispose(): Promise<void>;
}
