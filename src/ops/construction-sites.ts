// `construction_sites` — the type-aware read op (§5-L3): given a TYPE T, the object-literal
// expressions the live checker deems assignable to T (factory returns, array elements, variable
// initializers, call arguments, fixtures), each proof-carrying with its enclosing declaration
// and an honest confidence. The type-aware complement to `find_usages`'s "who references X" —
// "what BUILDS a T", which grep cannot answer. A thin pass-through: the assignability scan +
// confidence demotion live in the ts plugin (§5-L2), the op is the surface.

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import type { Result, Truncation } from '../core/result.ts';
import { failFromThrown, fail, ok, partial } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import type { TsPluginApi, ConstructionSite, ConstructionTarget } from '../plugins/ts/plugin.ts';
import { completeEmptyVerdict } from '../plugins/ts/construction-target.ts';
import { DEFAULT_SCAN_CAP } from '../plugins/ts/construction-sites.ts';
import { defineOp } from './registry.ts';
import type { Cell, TableSpec } from './registry.ts';
import { TS_TARGET_HINT, requireTarget, tsTargetShape, tsTargetIntake } from './ts-target.ts';
import { TS_TARGET_ONE_OF } from './ts-target.ts';
import { semanticFanoutRefusal } from './guard/semantic-fanout-guard.ts';
import {
  scanEmptinessNote,
  scanFloorNotes,
  scanScopeFields,
  type ScanSubject,
} from './scan-coverage.ts';

const argsSchema = z
  .strictObject({
    ...tsTargetShape,
    pathInclude: z.array(z.string()).optional(),
    pathExclude: z.array(z.string()).optional(),
    /** Hard cap on object literals examined (assignability checks) across the WHOLE cross-program
     *  fan — N programs never multiply it. Default 10000. */
    limit: z.number().int().positive().max(20_000).optional(),
  })
  .refine(requireTarget.predicate, { message: requireTarget.message });

/** What a `construction_sites` floor is a floor OF — the nouns the shared coverage vocabulary needs
 *  (`scan-coverage.ts`) so five distinct causes read in this op's own terms. */
const SUBJECT: ScanSubject = {
  subject: 'construction sites',
  noun: 'construction site',
  negation: 'that nothing builds it',
  candidate: 'object literal',
};

type ConstructionData = {
  /** `complete:false` + the per-program scope lead the object (verdict-first, §12). */
  complete?: false;
  programsScanned?: JsonValue;
  undiscoveredPrograms?: JsonValue;
  target: ConstructionTarget;
  sites: ConstructionSite[];
  scanned: { literals: number; files: number };
  truncated?: { examined: number; candidates: number };
  notes?: string[];
};

const constructionSitesTable: TableSpec<JsonValue> = {
  columns: [
    { name: 'file', type: 'text' },
    { name: 'line', type: 'int' },
    { name: 'col', type: 'int' },
    { name: 'confidence', type: 'text' },
    { name: 'encloser', type: 'text' },
    { name: 'encloser_id', type: 'text' },
    { name: 'encloser_kind', type: 'text' },
    { name: 'encloser_file', type: 'text' },
    { name: 'exported', type: 'int' },
    { name: 'note', type: 'text' },
  ],
  rows(data) {
    const sites = (data as { sites?: ConstructionSite[] }).sites ?? [];
    return sites.map((s): readonly Cell[] => [
      s.span.file,
      s.span.line,
      s.span.col,
      s.confidence,
      s.encloser.name,
      s.encloser.id,
      s.encloser.kind,
      s.encloser.file,
      s.encloser.exported ? 1 : 0,
      s.note ?? null,
    ]);
  },
  notes(data) {
    const out: string[] = [];
    const target = (data as { target?: ConstructionTarget }).target;
    if (target !== undefined)
      out.push(`target: ${target.kind} ${target.name} @ ${target.span.file}:${target.span.line}`);
    const t = (data as { truncated?: { examined: number; candidates: number } }).truncated;
    if (t !== undefined) {
      out.push(
        `examined ${t.examined} of ${t.candidates} object literals (cap hit) — narrow with pathInclude or raise limit to scan the rest.`,
      );
    }
    for (const n of (data as { notes?: string[] }).notes ?? []) out.push(n);
    return out;
  },
};

export const constructionSitesOp = defineOp({
  name: 'construction_sites',
  summary:
    'Object literals the live checker deems assignable to a TYPE T (factory returns, array elements, initializers, call args) — the type-aware "what builds a T?", proof-carrying',
  mutating: false,
  requires: ['ts'],
  argsSchema,
  argsHint: `${TS_TARGET_HINT} (the TYPE) — plus { pathInclude?: string[], pathExclude?: string[], limit?: number }`,
  intake: tsTargetIntake,
  requiredOneOf: TS_TARGET_ONE_OF,
  example: { args: { name: 'User' } },
  notes: [
    'the complement to find_usages: find_usages finds who REFERENCES a symbol; construction_sites finds object literals that BUILD a type T (anywhere the checker proves assignability) — answer to "I added a required field to T, which construction sites break?".',
    "assignability is the live checker's, over each literal's FRESH type — so it is excess-property-checked exactly as `const _: T = <literal>` would be: a literal missing a required field, OR carrying an excess one, is correctly NOT reported (high precision, no structural-superset flood).",
    "confidence: certain = a concrete fully-typed literal proven assignable · partial = assignable but the target is generic OR a field of T is satisfied by an `any`-value · dynamic = the literal's own type is `any` (assignable vacuously). A partial/dynamic site is honest uncertainty, never asserted certain.",
    'recall boundary (v1, object literals + initializers): a literal that loses freshness through an intermediate binding before flowing to T (`const base = {…,extra}; useUser(base)`) is NOT reported — its initializer is fresh and excess-fails. Stated, never silently missed.',
    'cross-program: the scan fans over EVERY loaded program containing T\'s declaration (a `test/**` sibling, a monorepo package that imports T), re-resolving T per program because assignability is invalid across checkers. `programsScanned` states the scope POSITIVELY, per program — so a small `files=N` can never be mistaken for "scanned the repo". A repo tsconfig codemaster never loaded, a spent budget, and files under no tsconfig are three DISTINCT floors, each named with the lever that can actually change it.',
    '`sites: 0` is a VERDICT only when the scan was complete: an empty SCAN and an empty RESULT are different facts, so a 0 over a scan that examined nothing reads `!! NOT A VERDICT`, and a 0 over an incomplete scan states the shortfall instead of asserting that nothing builds T.',
    'bounded: the assignability checks are hard-capped (default 10000 across the whole fan, raise with limit) and the cap is reported as truncation; scope with pathInclude/pathExclude. Each enclosing declaration is a chainable SymbolId (→ find_usages / source / rename_symbol).',
  ],
  table: constructionSitesTable,
  async run(ctx, args): Promise<Result<JsonValue>> {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    // §9: the scan now fans across every program containing T's declaration and warms each one's
    // checker — the same OOM surface the guard exists for. Guarded UNCONDITIONALLY (not via
    // `fanCapable`): the fan follows the DECLARATION, so a `name+file` / position target fans just
    // as a bare name does and a fan-capability carve-out here would under-guard.
    // `force` is `undefined`: this op declares no such arg, and the guard is not overridable anyway
    // (forcing the warm here kills the daemon, t-693742) — so advertising the flag would be a lever
    // that cannot change the outcome.
    const refusal = semanticFanoutRefusal(ctx, ts, undefined, args);
    if (refusal !== undefined) return fail(refusal);
    try {
      const outcome = ts.constructionSites(args, {
        ...(args.pathInclude !== undefined ? { pathInclude: args.pathInclude } : {}),
        ...(args.pathExclude !== undefined ? { pathExclude: args.pathExclude } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(ctx.deadline !== undefined ? { deadline: ctx.deadline } : {}),
      });
      if (typeof outcome === 'string') return fail({ tool: 'ts-ls', message: outcome });
      if ('unresolved' in outcome) {
        // §6: the held target handle's symbol is gone — state it structurally on `handle`.
        return fail({ tool: 'ts-ls', message: outcome.unresolved }, { handle: outcome.rebind });
      }
      const { view, rebind } = outcome;
      // A target GUARD fired (vacuous / value-with-vacuous-inferred type) → no scan was attempted,
      // so there is no scope to report and no emptiness to explain: the guard note IS the answer.
      const coverage = view.coverage;
      const undiscovered = coverage !== undefined ? ts.undiscoveredProgramLabels() : [];
      const notes = [...(view.notes ?? [])];
      if (coverage !== undefined) {
        const limit = args.limit ?? DEFAULT_SCAN_CAP;
        // Verdict-first (§12): the floor notes precede the target-level caveats, and the emptiness
        // line — which says whether `sites: 0` is a verdict at all — leads them.
        const empty = scanEmptinessNote(
          coverage,
          undiscovered,
          view.sites.length,
          SUBJECT,
          completeEmptyVerdict(view.target),
        );
        notes.unshift(...scanFloorNotes(coverage, undiscovered, SUBJECT, limit));
        if (empty !== undefined) notes.unshift(empty);
      }
      const data: ConstructionData = {
        ...(coverage !== undefined
          ? (scanScopeFields(coverage, undiscovered) as Partial<ConstructionData>)
          : {}),
        target: tag('target-ref', view.target),
        sites: view.sites.map((s) => tag('construction-site', s)),
        scanned: { literals: view.scannedLiterals, files: view.scannedFiles },
        ...(view.truncated !== undefined ? { truncated: view.truncated } : {}),
        ...(notes.length > 0 ? { notes } : {}),
      };
      const truncated: Truncation | undefined =
        view.truncated !== undefined
          ? {
              shown: view.truncated.examined,
              total: view.truncated.candidates,
              hint: 'narrow with pathInclude / pathExclude, or raise limit, to scan the rest',
            }
          : undefined;
      const extras = {
        ...(rebind !== undefined ? { handle: rebind } : {}),
        ...(truncated !== undefined ? { truncated } : {}),
      };
      // §19 loop boundary: the deadline stopped the walk mid-way. The sites found ARE real data, so
      // the honest shape is `partial` — never `ok` (which would read as a finished scan).
      if (coverage?.deadlineHit === true) {
        return partial(
          data as JsonValue,
          {
            tool: 'timeout',
            message: `the scan's wall-clock budget expired after ${coverage.examined} of ${coverage.candidates} object literals — the sites listed are real, the scan is unfinished`,
          },
          extras,
        );
      }
      return ok(data as JsonValue, Object.keys(extras).length > 0 ? extras : undefined);
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
  },
});
