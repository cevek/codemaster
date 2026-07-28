// The leaf contract of the target-resolution family: what a resolve RETURNS, and the candidate
// budget it spends. A leaf so the dispatcher (`resolve-target.ts`) and the §6 handle path
// (`rebind-symbol-id.ts`) can both depend on it without depending on each other — imports flow one
// way only (CONTRIBUTING: no cycles).

import type { HandleRebind } from '../../core/ids.ts';

/** The exact-name candidate budget for a bare `{name}` resolve. Generous because a barrel-heavy
 *  repo produces dozens of same-named re-export specifiers that collapse to a handful of real
 *  declarations — a tight budget spends itself on aliases and drops the declaration the agent
 *  meant. Still bounded (§1); when it bites, the ambiguity message says so (`≥`, lower bound). */
export const NAME_CANDIDATE_LIMIT = 50;

export type ResolvedTarget =
  | {
      ok: true;
      abs: string;
      offset: number;
      rebind?: HandleRebind;
      /** The name→declaration search that produced this position was TRUNCATED by the LS's own page
       *  cap, so it is a resolution of the candidates we could SEE. A same-named declaration may sit
       *  behind the cut, which makes any downstream uniqueness / completeness reading a floor, not a
       *  fact (§3.4) — reads disclose it, writes refuse on it. Absent on an exact target (symbolId /
       *  position / name+file), which no search ranked. */
      searchTruncated?: true;
    }
  | { ok: false; message: string; rebind?: HandleRebind };
