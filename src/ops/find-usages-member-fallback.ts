// `find_usages {name, file}` member / re-export fallback (t-755152) — the op-level dispatch that runs
// only when a bare name+file resolves NO top-level declaration. It asks the ts plugin for the
// non-top-level bindings of that name in the file (members / enum members / re-export specifiers) and,
// on a unique match, re-issues `find_usages` by position — so a class METHOD / type-alias MEMBER /
// re-exported name is not a dead-end. The reference discovery still rides the one alias-safe
// `find_usages` primitive (a re-export specifier follows to its target). find-usages.ts owns the
// dispatch call; this owns the resolve-a-member decision.

import type { ToolFailure } from '../core/result.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import type { UsageOptions } from '../plugins/ts/query-types.ts';

type FindUsagesOutcome = ReturnType<TsPluginApi['findUsages']>;

/** The bare `name`+`file` target shape the fallback applies to (a subset of the op args). */
type NameFileTarget = {
  name?: string | undefined;
  file?: string | undefined;
  symbolId?: string | undefined;
  line?: number | undefined;
  col?: number | undefined;
};

/** `resolved` → the re-issued outcome + a disclosure note the op leads with (§3.6 — the agent asked
 *  for a top-level and got a member). `ambiguous` → several same-named members; an honest pick-list
 *  failure (+ a `member_usages` redirect naming the containing type). `undefined` → not applicable
 *  (wrong target shape) or nothing matched, so the op keeps its original top-level failure. */
export type MemberFallback =
  | { kind: 'resolved'; outcome: FindUsagesOutcome; note: string }
  | { kind: 'ambiguous'; failure: ToolFailure }
  | undefined;

function describe(m: { kind: string; container?: string | undefined }): string {
  return `${m.kind}${m.container !== undefined ? ` of ${m.container}` : ''}`;
}

export function memberFallback(
  ts: TsPluginApi,
  args: NameFileTarget,
  options: UsageOptions,
): MemberFallback {
  // Shape-gated (never a substring match on the failure message): only a bare name+file with no
  // symbolId and no explicit position — the exact form `resolveNameInFile` handles top-level-only.
  if (
    args.name === undefined ||
    args.file === undefined ||
    args.symbolId !== undefined ||
    args.line !== undefined ||
    args.col !== undefined
  ) {
    return undefined;
  }
  const members = ts.membersNamedInFile(args.name, args.file);
  if (typeof members === 'string' || members.length === 0) return undefined;

  if (members.length > 1) {
    const list = members.map((m) => `${m.line}:${m.col} (${describe(m)})`).join(', ');
    const container = members.find((m) => m.container !== undefined)?.container;
    const redirect =
      container !== undefined
        ? ` — or member_usages {name:'${container}', member:'${args.name}'}`
        : '';
    return {
      kind: 'ambiguous',
      failure: {
        tool: 'ts-ls',
        message: `${args.file} has ${members.length} member/re-export bindings named '${args.name}' (${list}) — pass file:line:col to pick one${redirect}`,
      },
    };
  }

  const m = members[0];
  if (m === undefined) return undefined;
  const outcome = ts.findUsages({ file: args.file, line: m.line, col: m.col }, options);
  return {
    kind: 'resolved',
    outcome,
    note: `resolved '${args.name}' as ${describe(m)} at ${args.file}:${m.line}:${m.col} — not a top-level declaration`,
  };
}
