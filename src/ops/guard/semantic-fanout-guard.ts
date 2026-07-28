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
import type { DaemonInfo } from '../registry.ts';
import type { IsolationReason } from '../../core/isolation.ts';
import { navigationFor } from './navigate.ts';

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
  // t-959904: which op is refusing, and what it was asked — the refusal names the call that answers
  // the SAME question here (navigate.ts). REQUIRED, so tsc catches a call site that would otherwise
  // silently emit a redirect for the wrong op.
  nav: { op: string; args: unknown },
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
      nav,
    ),
  };
}

/** Ordering IS the contract here (§12 verdict-first, t-959904). What the agent can run RIGHT NOW
 *  comes before why the heavy path is unavailable, because the reader of this message is usually an
 *  agent inside someone else's repo: it can make another call, and it cannot restart a machine-wide
 *  daemon or edit that repo's config. The cause+remedy still ships — one clause, explicitly labelled
 *  as needing access the caller may not have — so the operator who CAN act is not left guessing. */
function fanoutRefusalMessage(
  count: number,
  threshold: number,
  reason: IsolationReason | undefined,
  forced: boolean,
  nav: { op: string; args: unknown },
): string {
  const forcedNote = forced
    ? ' (`force:true` does NOT override this — forcing the warm here killed the daemon in production, t-693742.)'
    : '';
  return (
    `${nav.op} declines: repo ${count} src files > threshold ${threshold}, engine IN-PROCESS — its ` +
    `cross-program reference fan-out can OOM the daemon uncatchably, killing every workspace on it. ` +
    `${navigationFor(nav.op, nav.args)} ` +
    `Cause (needs config/daemon access): ${remedyFor(reason)}${forcedNote}`
  );
}

/** Name the ACTUAL cause and its remedy, one clause each. Exhaustive over the union, so a new cause
 *  cannot fall through to a plausible-but-wrong sentence; an absent cause says exactly that (§3.6). */
function remedyFor(reason: IsolationReason | undefined): string {
  switch (reason) {
    case 'auto-escalated':
      // Structurally unreachable (an escalated engine IS the child, and the child never reaches
      // this guard) — stated, not silently defaulted, so the union stays exhaustive.
      return 'this workspace was auto-escalated into a child engine yet ran in-process — inconsistent; report it via the `feedback` op.';
    case 'auto-escalate-disabled':
      return '`daemon.autoEscalate: false` switched escalation off, so the oversized repo was never raised into a killable child.';
    case 'configured':
      return "codemaster.config pins `daemon.isolation: 'in-process'` — `process` (or removing it) runs this in a killable child instead.";
    case 'escalation-failed':
      return 'escalation was attempted but forking the isolated child engine failed (see the daemon debug log); a retry reuses this same in-process engine.';
    case 'no-process-host':
      return 'this build ships no process-host factory; the normal entry point (`codemaster mcp` / `codemaster daemon`) provides one.';
    case 'within-budget':
      return 'the repo measured within budget when this engine spawned and has grown since; `codemaster daemon restart` re-decides.';
    case 'estimate-failed':
      return "the repo size could not be measured at spawn (git listing failed), so escalation was never attempted; `daemon.isolation: 'process'` sets it explicitly.";
    case undefined:
      return 'not recorded on this path — check `daemon.autoEscalate` / `daemon.isolation` in codemaster.config.';
  }
}
