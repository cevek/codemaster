// `member_usages` — the reference sites of a SPECIFIC MEMBER of a type (§5-L3): given a TYPE T
// (addressed by symbolId / name / file:line:col) and a MEMBER name, every `x.member` / `{member}=x`
// / `x['member']` / `x.member = …` site, classified read / write / destructure. The "who reads/writes
// THIS field" query — which `find_usages` on T finds the TYPE for, not a named member, and whose
// syntactic role:read/write can't resolve a member access. A thin pass-through: the checker-resolved
// member + identity-gated (by construction) reference scan live in the ts plugin (§5-L2).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import type { Result, Truncation } from '../core/result.ts';
import { failFromThrown, fail, ok } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import type { MemberUsagesView, MemberUsageSite } from '../plugins/ts/member-usages.ts';
import { defineOp } from './registry.ts';
import type { Cell, TableSpec } from './registry.ts';
import { semanticFanoutRefusal } from './guard/semantic-fanout-guard.ts';
import { TS_TARGET_HINT, requireTarget, tsTargetShape, tsTargetIntake } from './ts-target.ts';

const argsSchema = z
  .strictObject({
    ...tsTargetShape,
    /** The member (property / method / field) name whose access sites to trace. */
    member: z.string().min(1),
    /** Bypass the in-process semantic-fanout size guard (t-411303) and warm anyway. */
    force: z.boolean().optional(),
    pathInclude: z.array(z.string()).optional(),
    pathExclude: z.array(z.string()).optional(),
    /** Display cap on the emitted site list (dispositions/total still count every matched site). */
    limit: z.number().int().positive().max(50_000).optional(),
  })
  .refine(requireTarget.predicate, { message: requireTarget.message });

const memberUsagesTable: TableSpec<JsonValue> = {
  columns: [
    { name: 'file', type: 'text' },
    { name: 'line', type: 'int' },
    { name: 'col', type: 'int' },
    { name: 'kind', type: 'text' },
    { name: 'encloser', type: 'text' },
    { name: 'encloser_kind', type: 'text' },
    { name: 'program', type: 'text' },
  ],
  rows(data) {
    const sites = (data as { sites?: MemberUsageSite[] }).sites ?? [];
    return sites.map((s): readonly Cell[] => [
      s.span.file,
      s.span.line,
      s.span.col,
      s.kind,
      s.enclosing?.name ?? null,
      s.enclosing?.kind ?? null,
      s.program ?? null,
    ]);
  },
  notes(data) {
    const out: string[] = [];
    const m = (data as { member?: MemberUsagesView['member'] }).member;
    const d = (data as { dispositions?: MemberUsagesView['dispositions'] }).dispositions;
    if (m !== undefined) {
      out.push(`member: ${m.type}.${m.name} @ ${m.span.file}:${m.span.line}:${m.span.col}`);
    }
    if (d !== undefined) {
      out.push(`disposition: ${d.read} read · ${d.write} write · ${d.destructure} destructure`);
    }
    const ex = (data as { excluded?: number }).excluded;
    if (ex !== undefined && ex > 0) out.push(`${ex} site(s) dropped by your path filter.`);
    for (const n of (data as { notes?: string[] }).notes ?? []) out.push(n);
    return out;
  },
};

type MemberUsagesData = {
  member: MemberUsagesView['member'];
  sites: MemberUsageSite[];
  dispositions: MemberUsagesView['dispositions'];
  total: number;
  excluded?: number;
  complete: boolean;
  undiscoveredPrograms?: string[];
  notes: string[];
};

export const memberUsagesOp = defineOp({
  name: 'member_usages',
  summary:
    "reference sites of a SPECIFIC MEMBER (property/method/field) of a type — `x.member` / `{member}=x` / `x['member']` / `x.member = …` — classified read/write/destructure, checker-resolved by IDENTITY (a same-named member on an unrelated type is never matched), which find_usages on the TYPE cannot scope to one member",
  mutating: false,
  requires: ['ts'],
  argsSchema,
  argsHint: `${TS_TARGET_HINT} (the TYPE) + { member: string, pathInclude?: string[], pathExclude?: string[], limit?: number }`,
  intake: tsTargetIntake,
  example: { args: { name: 'Config', member: 'timeout' } },
  notes: [
    "on an oversized IN-PROCESS repo (> `ts.searchWarmMaxFiles`, default 4000 source files) this op REFUSES to warm the type-checker (the member reference scan fans across every program and would OOM, killing the daemon) and redirects to `daemon.isolation:'process'`; pass `force:true` to warm anyway. No refusal in process-mode.",
    'the member-scoped complement to find_usages: find_usages on a TYPE finds references to the type NAME, not accesses of a named member, and its role:read/write is SYNTACTIC (a member access is a `read`/`write` of the OBJECT, not resolved to the field). This op resolves the member through the live checker and finds its access sites.',
    'IDENTITY BY CONSTRUCTION (never name-match): the member is resolved via `getApparentType(T).getProperty(member)` (so an INHERITED / intersection member flattens in) and references run on THAT member symbol — a same-named `.member` on an UNRELATED type is never matched. No separate identity gate is needed; the symbol IS the gate.',
    "access forms traced (via the LS): property access `x.member`, destructuring `const {member}=x` (flagged `destructure`), string-literal element access `x['member']`, shorthand, and writes `x.member = …` (flagged `write`). All emitted sites are certain-identity.",
    "v1 scope (honest under-coverage, stated): a COMPUTED element access `x[expr]` (a variable key the checker cannot resolve to one member) is NOT traced — never guessed; and a destructured local's DOWNSTREAM reads are invisible to member-level references (the binding is flagged `destructure`, disclosed when present). An OVERRIDE in a subclass is a distinct member symbol — address it on the subclass. Undiscovered sibling tsconfigs demote `complete` to false with a `!!` lower-bound note.",
    'read/write/destructure disposition is summarized; scope the display with pathInclude/pathExclude (dropped sites are reported, never read as completeness) or limit.',
  ],
  table: memberUsagesTable,
  async run(ctx, args): Promise<Result<JsonValue>> {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    // Pre-warm guard (t-411303): the member reference scan rides `findReferencesAcross`, fanning
    // across every program — on an oversized in-process repo that OOMs and kills the daemon (§1).
    // Refuse with a process-mode redirect BEFORE any resolve/warm. `force` bypasses; process-mode +
    // an estimate failure fall through (see the guard).
    const refusal = semanticFanoutRefusal(ctx, ts, args.force);
    if (refusal !== undefined) return fail(refusal);
    try {
      const outcome = ts.memberUsages(args, args.member, {
        ...(args.pathInclude !== undefined ? { pathInclude: args.pathInclude } : {}),
        ...(args.pathExclude !== undefined ? { pathExclude: args.pathExclude } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      if (typeof outcome === 'string') return fail({ tool: 'ts-ls', message: outcome });
      if ('unresolved' in outcome) {
        return fail({ tool: 'ts-ls', message: outcome.unresolved }, { handle: outcome.rebind });
      }
      const { view, rebind } = outcome;
      const data: MemberUsagesData = {
        member: view.member,
        sites: view.sites.map((s) => tag('member-usage', s)),
        dispositions: view.dispositions,
        total: view.total,
        ...(view.excluded !== undefined ? { excluded: view.excluded } : {}),
        complete: view.complete,
        ...(view.undiscoveredPrograms !== undefined
          ? { undiscoveredPrograms: view.undiscoveredPrograms }
          : {}),
        notes: view.notes,
      };
      const truncated: Truncation | undefined =
        view.truncated !== undefined
          ? {
              shown: view.truncated.shown,
              total: view.truncated.total,
              hint: 'reference set capped — narrow with pathInclude / pathExclude',
            }
          : undefined;
      const extras = {
        ...(rebind !== undefined ? { handle: rebind } : {}),
        ...(truncated !== undefined ? { truncated } : {}),
      };
      return ok(data as JsonValue, Object.keys(extras).length > 0 ? extras : undefined);
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
  },
});
