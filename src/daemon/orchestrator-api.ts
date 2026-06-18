// The orchestrator surface the MCP facade depends on (spec-daemon-singleton §2). Extracted so
// `serveMcp` is agnostic to WHERE the orchestrator lives: the in-process `Orchestrator` (the CLI
// one-shot + the `--in-process` escape hatch + the daemon process itself) and the bridge's
// `RemoteOrchestrator` (forwards over the socket to the daemon) both satisfy it. Exactly the
// methods the facade calls — no more — so a remote impl stays a thin forwarder.

import type { BatchOptions, OpRequest, OpResult } from '../ops/contracts.ts';
import type { StatusView } from '../format/render/render-status.ts';

/** Lightweight daemon-process facts for the `codemaster daemon status` management verb
 *  (spec-daemon-cli). Deliberately NOT routed through `status`: that warms an engine for
 *  `cwd` as a side effect, whereas this is a pure read of the daemon's own state. */
export interface DaemonInfo {
  pid: number;
  uptimeMs: number;
  engines: number;
  engineRoots: readonly string[];
}

export interface OrchestratorApi {
  /** Dispatch op requests against the workspace(s) resolved from `cwd`/`root`. */
  request(
    cwd: string,
    root: string | undefined,
    reqs: readonly OpRequest[],
    batch?: BatchOptions,
  ): Promise<{ ok: true; results: readonly OpResult[] } | { ok: false; message: string }>;
  /** First-contact manifest for the workspace resolved from `cwd`/`root`. */
  status(cwd: string, root?: string): Promise<StatusView>;
  /** Whether codemaster's own source moved since spawn (§3.6) — drives the reconnect banner.
   *  Synchronous: the remote impl returns the value cached from the last reply envelope. */
  sourceStale(): boolean;
  /** Release this orchestrator's hold. In-process: dispose engines. Remote: close the socket
   *  connection only — the shared daemon keeps running for other bridges. */
  dispose(): Promise<void>;
}

/** The orchestrator the daemon process serves. The daemon hosts the in-process `Orchestrator`,
 *  which can report `daemonInfo()` synchronously; the bridge's `RemoteOrchestrator` has no real
 *  daemon-process facts of its own (it would have to fake them — a latent lie), so `daemonInfo`
 *  lives HERE, not on the shared `OrchestratorApi`. */
export interface ServingOrchestrator extends OrchestratorApi {
  daemonInfo(): DaemonInfo;
}
