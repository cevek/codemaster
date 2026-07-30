// `EngineSlot` — the orchestrator's per-workspace bookkeeping record (§2/§9): the host it routes to,
// plus everything the read path re-checks before reusing it. Split out of `orchestrator.ts` to keep
// that file (routing + lifecycle + governor) under its line cap.

import type { ProjectHost } from './host.ts';

export interface EngineSlot {
  host: ProjectHost;
  root: string;
  lastUsedMs: number;
  idleEvictionMs: number;
  /** Content fingerprint of the config the engine was spawned from (config-reload). On
   *  request entry the orchestrator re-fingerprints the on-disk config and evicts on
   *  drift, so the next request re-spawns with the fresh plugin set / config options. */
  configFp: string;
  /** Where the config came from at spawn — `tsProjectRefusal` needs it to honor an explicit
   *  opt-in without re-loading the (byte-identical) config on the warm path. */
  configSource: string | undefined;
  /** The §4c verdict taken at spawn (t-810757). `unsupported` slots exist because a
   *  workspace-INDEPENDENT op (`feedback`) may spawn an engine on a root codemaster cannot
   *  inspect; the verdict is re-taken on every workspace-NEEDING request against such a slot, so a
   *  root that gains a tsconfig is not held refused until eviction (§3.5: the read path is the
   *  guarantee). A `verified` verdict is cached exactly as before — no per-request git listing. */
  tsProject: 'verified' | 'unsupported';
}
