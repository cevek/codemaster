// t-679091 — the pre-warm guard for heavy SEMANTIC fan-out ops (find_usages / impact /
// importers_of, and find_definition when bare-name-addressed). The sibling of the search_symbol
// size-guard (t-333163), for the ops that warm the LS and fan references/imports across EVERY
// loaded program — the OOM surface Fix A's discovery pruning does NOT cover on a references
// monorepo (its primary doesn't subsume, so the fan-out builds all programs).
//
// Its frame since auto-escalation (t-754922): an oversized repo is normally raised into a killable
// child at spawn, where an OOM is an honest `ToolFailure` and the daemon lives — so this guard no
// longer fires there at all. What is left for it to catch is the repo that is oversized AND STILL
// in-process, i.e. the mode was PINNED (`autoEscalate:false` / an explicit `isolation:'in-process'`)
// or this build cannot fork. There, an OOM is still uncatchable and still kills the singleton
// daemon, so the op declines to warm and names the ONE cause that applies plus its remedy (§3.6).
//
// `force:true` does NOT override this. It used to, and the refusal text advertised it as the
// in-band escape — so an agent following the tool's own instruction reached a dead daemon
// (t-693742, a live production incident). §1 ranks a crash below a wrong answer: there is no
// legitimate reading of "force" that includes killing the process the agent is talking to. Where
// forcing IS safe — an escalated / configured process-mode child — this guard never runs anyway.

import type { ToolFailure } from '../../core/result.ts';
import type { TsPluginApi } from '../../plugins/ts/plugin.ts';
import type { DaemonInfo, IsolationReason } from '../registry.ts';

/** Refuse a heavy semantic fan-out when the in-process daemon would OOM on it — else `undefined`
 *  (warm as normal). Called at the TOP of a guarded op's `run()`, BEFORE any resolve/warm (a
 *  name-addressed call warms the LS inside `resolveByName`→`searchSymbols`, so a guard placed after
 *  resolve has already paid the OOM). Params are narrowed to exactly what the check reads (the
 *  isolation mode + its cause + the cheap estimate), so it composes with the full
 *  `OpContext`/`TsPluginApi` and is unit-testable without faking either whole. */
export function semanticFanoutRefusal(
  ctx: { daemon?: Pick<DaemonInfo, 'isolation' | 'isolationReason'> | undefined },
  ts: Pick<TsPluginApi, 'estimateSourceFileCount' | 'searchWarmMaxFiles'>,
  force: boolean | undefined,
): ToolFailure | undefined {
  // Only in-process: a forked child (process-mode) has its own killable heap → the t-000052
  // mechanism turns the OOM into an honest ToolFailure without touching the daemon. `undefined`
  // isolation (a synthetic context that never wired daemon info) is treated as NOT in-process → no
  // refusal, so the guard can never over-refuse where it can't confirm the risk.
  if (ctx.daemon?.isolation !== 'in-process') return undefined;
  // The SAME host-free count + threshold the spawn-time escalation decision used (escalate.ts), so
  // the two can only disagree inside the memo window — and only in the safe direction (a repo that
  // outgrew its cached count is still in-process and IS refused here).
  const estimate = ts.estimateSourceFileCount();
  // Estimate failure (git hiccup) or a repo within budget → warm as normal. The guard is an
  // optimization against a known-oversized repo, never a correctness gate.
  if (!estimate.ok || estimate.data <= ts.searchWarmMaxFiles) return undefined;
  return {
    tool: 'size-guard',
    message: fanoutRefusalMessage(
      estimate.data,
      ts.searchWarmMaxFiles,
      ctx.daemon.isolationReason,
      force === true,
    ),
  };
}

function fanoutRefusalMessage(
  count: number,
  threshold: number,
  reason: IsolationReason | undefined,
  forced: boolean,
): string {
  const forcedNote = forced
    ? ' `force:true` does NOT override this refusal — forcing the warm here killed the daemon in production (t-693742).'
    : '';
  return (
    `repo is large (${count} source files > threshold ${threshold}) and this engine runs IN-PROCESS — ` +
    `this op warms the type-checker and fans references across every program, and an OOM in the ` +
    `daemon's own heap is uncatchable (it kills the daemon, taking every workspace with it). ` +
    `${remedyFor(reason)}${forcedNote}`
  );
}

/** Name the ACTUAL cause and its remedy. Exhaustive over the union, so a new cause cannot fall
 *  through to a plausible-but-wrong sentence; an absent cause says exactly that (§3.6). */
function remedyFor(reason: IsolationReason | undefined): string {
  switch (reason) {
    case 'auto-escalated':
      // Structurally unreachable (an escalated engine IS the child, and the child never reaches
      // this guard) — stated, not silently defaulted, so the union stays exhaustive.
      return 'This workspace was auto-escalated into a child engine, yet this op ran in-process — report this inconsistency via the `feedback` op.';
    case 'auto-escalate-disabled':
      return (
        'Auto-escalation is switched OFF for this workspace (`daemon.autoEscalate: false`), so the ' +
        'oversized repo was NOT raised into a killable child — remove that setting (the default) to ' +
        'run this op in an isolated child instead.'
      );
    case 'configured':
      return (
        "This workspace pins `daemon.isolation: 'in-process'` in codemaster.config — remove it (an " +
        'oversized repo then auto-escalates into a killable child) or set it to `process`.'
      );
    case 'no-process-host':
      return (
        'This build provides no process-host factory, so the repo could not be escalated into a ' +
        'child — run codemaster through its normal entry point (`codemaster mcp` / `codemaster daemon`), ' +
        'which does.'
      );
    case 'within-budget':
      return (
        'The engine was spawned when the repo still measured within budget, so it was not escalated — ' +
        'restart the daemon (`codemaster daemon restart`) to re-decide against the current size.'
      );
    case 'estimate-failed':
      return (
        'The repo size could not be measured at spawn (git listing failed), so escalation was not ' +
        "attempted — fix the git state, or set `daemon.isolation: 'process'` explicitly."
      );
    case undefined:
      return (
        'Why this workspace was not escalated into a killable child is not recorded on this path — ' +
        "check `daemon.autoEscalate` / `daemon.isolation` in codemaster.config, or set `isolation: 'process'`."
      );
  }
}
