// `impact_type_error` — type-error blast radius (read-only, §17 Phase 5). The complement to
// `impact`: where `impact` reports WHO transitively depends on a symbol (reference closure),
// this answers WHO REALLY BREAKS BY TYPES if the symbol changes — by SIMULATING the change
// (a trial edit overlaid on the symbol's declaration) and reporting the REAL `tsc` diagnostics
// the edit introduces at the dependents. The errors are the proof: a `file:line` an agent can
// open, not a heuristic.
//
// Honesty (§3): the edit is applied EXACTLY as the caller specifies (verbatim `replace` /
// `remove` of the declaration span) — no invented mutation DSL (a "drop param N" primitive
// would duplicate `change_signature`). Errors are diffed against a pre-edit BASELINE so a repo's
// pre-existing red is never counted as the edit's fault (§3.6). The dependent SET is the same
// bounded closure `impact` uses (`buildClosure` + the shared `outcomeFromView` projection), so a
// truncated closure is flagged `!!` and the typecheck scope it drives is honestly incomplete, never
// silently clean. A program the gate could not check (a degraded sibling) is flagged, never read as
// clean (§3.4). The splice reads the SAME VFS bytes the gate's baseline reads (`ts.fileText`), so
// the introduced-error diff is purely the edit's effect, not a disk/overlay skew.
//
// One more masking hazard the verdict makes honest (§3): when the trial edit breaks the edited file
// ITSELF (`editSiteBroke`), an intra-file error can collapse an inferred type the dependents rely on
// (e.g. the edited symbol degrading to `any`) — the dependents then see `any`, their would-be breaks
// stop erroring, and `brokenFiles` UNDER-counts. So `downstreamTrusted:false` marks the count a LOWER
// BOUND, never letting `brokenFiles=0` read as a proven-clean downstream. (A clean widen-to-`any` that
// introduces NO edit-site error is a distinct, deferred case — diff-of-diagnostics cannot see it.)

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import type { RepoRelPath } from '../core/brands.ts';
import type { Result } from '../core/result.ts';
import type { Span } from '../core/span.ts';
import { failFromThrown, fail, ok } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import { computeLineStarts, locToOffset } from '../common/span/offset.ts';
import { applyEdits } from '../support/text-edits/apply.ts';
import type { TsDiagnostic, TsPluginApi } from '../plugins/ts/plugin.ts';
import type { UsageOptions } from '../plugins/ts/query-types.ts';
import { defineOp } from './registry.ts';
import { TS_TARGET_HINT, requireTarget, tsTargetShape, tsTargetIntake } from './ts-target.ts';
import { buildClosure, type ClosureResult, type Expand } from './impact-closure.ts';
import { outcomeFromView } from './impact-expand.ts';
import { buildTypecheckField, gateCoverageNotes } from './mutation-support.ts';

const DEFAULT_DEPTH = 3;
const MAX_DEPTH = 12;
const DEFAULT_NODES = 200;
const MAX_NODES = 2000;

/** The trial edit: replace the symbol's declaration span with `replace` text, OR `remove` it
 *  (delete the span). Exactly one — `remove` is sugar for an empty replacement. The caller
 *  expresses any semantic mutation (make a field required, drop a param, retype) by writing the
 *  new declaration source; we never interpret it, only apply it verbatim. */
const editSchema = z
  .strictObject({
    replace: z.string().optional(),
    remove: z.literal(true).optional(),
  })
  .refine((e) => (e.replace !== undefined) !== (e.remove === true), {
    message: "edit needs exactly one of { replace: '<new declaration source>' } | { remove: true }",
  });

const argsSchema = z
  .strictObject({
    ...tsTargetShape,
    edit: editSchema,
    /** Closure depth (default 3) — bounds the dependent set the typecheck scope is built from. */
    depth: z.number().int().min(1).max(MAX_DEPTH).optional(),
    /** Global cap on dependents (default 200). Bounds total work = closure × find_usages + the
     *  cross-program typecheck over the dependent files. */
    nodes: z.number().int().min(1).max(MAX_NODES).optional(),
    /** Counts + verdict only — omit the per-file broken/clean listing. */
    summary: z.boolean().optional(),
  })
  .refine(requireTarget.predicate, { message: requireTarget.message });

type TypeErrorArgs = z.infer<typeof argsSchema>;

/** Splice the declaration span out of `content`, replacing it with `replacement`. Returns the
 *  post-edit file text, or `undefined` when the span's coordinates fall outside the content (an
 *  out-of-range Loc — reported honestly, never clamped into a plausible-looking lie). */
function spliceDecl(content: string, decl: Span, replacement: string): string | undefined {
  const lineStarts = computeLineStarts(content);
  const start = locToOffset(lineStarts, content.length, decl.line, decl.col);
  const end = locToOffset(lineStarts, content.length, decl.endLine, decl.endCol);
  if (start === undefined || end === undefined || end < start) return undefined;
  return applyEdits(content, [{ start, end, text: replacement }]);
}

/** Assemble the load-bearing honesty notes (§12 verdict-before-bulk — these precede the
 *  introduced-diagnostics proof). Caps on the closure (the typecheck SCOPE) are `!!`; a degraded
 *  program is surfaced so an unchecked dependent never reads clean; an edit-site error is
 *  distinguished from the downstream blast radius. */
function notesFor(
  closure: ClosureResult,
  programs: readonly string[],
  degraded: readonly string[],
  declFile: RepoRelPath,
  editSiteDirty: boolean,
  maxDepth: number,
  maxNodes: number,
): string[] {
  const notes: string[] = [];
  if (closure.capped?.by === 'nodes') {
    notes.push(
      `!! dependent set hit the node cap (${maxNodes}) — typecheck SCOPE incomplete (${closure.capped.boundaryNodes} node(s) un-expanded); a dependent beyond it is NOT checked, not proven clean. Raise nodes: or narrow.`,
    );
  } else if (closure.capped?.by === 'depth') {
    notes.push(
      `!! reached depth cap (${maxDepth}) — ${closure.capped.boundaryNodes} boundary node(s) not expanded; deeper dependents are outside the typecheck scope. Raise depth:.`,
    );
  }
  if (closure.hubTruncated) {
    notes.push(
      `!! a hub had more direct dependents than the per-query cap (${maxNodes}) — some dependents are OUTSIDE the typecheck scope (not checked, not proven clean); raise nodes: or narrow with depth.`,
    );
  }
  if (closure.unexpandable > 0) {
    notes.push(
      `!! ${closure.unexpandable} dependent(s) could not be re-expanded (module rollups / unresolved ids) — their transitive dependents are outside the typecheck scope.`,
    );
  }
  if (closure.dynamicBoundaries.length > 0) {
    notes.push(
      `scope PARTIAL: ${closure.dynamicBoundaries.length} value-flow boundary(ies) — a callable target read as a value (possible dynamic dispatch); consumers reached dynamically are NOT in the typecheck scope.`,
    );
  }
  if (editSiteDirty) {
    notes.push(
      `!! ${declFile}: the trial edit introduced error(s) in the edited file ITSELF — the DOWNSTREAM blast radius is UNTRUSTWORTHY (downstreamTrusted:false). An edit-site error can collapse an inferred type the dependents depend on (e.g. the edited symbol degrading to \`any\`), so a downstream break stops erroring and is silently MASKED. Treat brokenFiles as a LOWER BOUND — real breaks may be hidden, and brokenFiles=0 is NOT proof of a clean downstream. Fix the edit-site error (verify the replacement parses / infers) before trusting the downstream list.`,
    );
  }
  notes.push(...gateCoverageNotes(programs, degraded));
  return notes;
}

/** Whether the trial edit introduced any error in file `f` — a per-file `buildTypecheckField`
 *  diff (reusing the one mandated diff, never a hand-rolled twin). `clean` is honest against the
 *  pre-edit baseline, so a file already red for unrelated reasons is not counted. */
function fileBroke(
  baseline: readonly TsDiagnostic[],
  overlay: readonly TsDiagnostic[],
  f: RepoRelPath,
): boolean {
  return !buildTypecheckField(
    baseline.filter((d) => d.file === f),
    overlay.filter((d) => d.file === f),
  ).clean;
}

export const impactTypeErrorOp = defineOp({
  name: 'impact_type_error',
  summary:
    'Type-error blast radius: SIMULATE a change to a symbol (trial edit on its declaration) and report the REAL tsc errors it introduces at each dependent — proof-carrying, baseline-diffed, closure-bounded',
  mutating: false,
  requires: ['ts'],
  argsSchema,
  argsHint: `${TS_TARGET_HINT} — plus { edit: { replace: '<new decl source>' } | { remove: true }, depth?: 1-${MAX_DEPTH} (default ${DEFAULT_DEPTH}), nodes?: 1-${MAX_NODES} (default ${DEFAULT_NODES}), summary?: boolean }`,
  intake: tsTargetIntake,
  example: { args: { name: 'createEngine', edit: { remove: true } } },
  notes: [
    'simulates the edit by overlaying it on the declaration span (NO write to disk), then runs the cross-program typecheck over the dependent files and reports the diagnostics the edit INTRODUCED (diffed against a pre-edit baseline, so pre-existing repo errors are never blamed on the edit).',
    "edit is applied VERBATIM: { replace } substitutes new declaration source, { remove } deletes the declaration. Express make-required / drop-param / retype by writing the new source — no mutation DSL (that's `change_signature`'s job).",
    'the dependent SET is the same bounded closure as `impact` (depth + node caps); a truncated closure means the typecheck scope is incomplete and is flagged `!!` — a dependent outside the scope, or in a program the gate could not check, is NEVER reported clean.',
    'errors are the proof (file:line:message). Attribution is file-level (which dependent file went red), never a claimed precise symbol; an error in the edited file itself (editSiteBroke) sets downstreamTrusted:false — an edit-site error can collapse an inferred type the dependents rely on, so a downstream break stops erroring and is MASKED. When downstreamTrusted is false, brokenFiles is a LOWER BOUND (brokenFiles=0 is NOT a clean downstream), not a true blast radius.',
  ],
  async run(ctx, args: TypeErrorArgs): Promise<Result<JsonValue>> {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    const maxDepth = args.depth ?? DEFAULT_DEPTH;
    const maxNodes = args.nodes ?? DEFAULT_NODES;
    try {
      // 1. Resolve the symbol's declaration — the span the trial edit splices, and the seed id.
      const defRes = ts.findDefinition(args);
      if (typeof defRes === 'string') return fail({ tool: 'ts-ls', message: defRes });
      if ('unresolved' in defRes) {
        return fail({ tool: 'ts-ls', message: defRes.unresolved }, { handle: defRes.rebind });
      }
      if (defRes.views.length !== 1) {
        return fail({
          tool: 'ts-ls',
          message: `target resolved to ${defRes.views.length} declarations — pass a symbolId or file+line+col to pick one`,
        });
      }
      const def = defRes.views[0];
      if (def === undefined || def.decl === undefined) {
        return fail({
          tool: 'ts-ls',
          message: 'could not locate the declaration span to simulate an edit on',
        });
      }
      const declFile = def.decl.file;

      // 2. Build the trial-edit overlay from the SAME VFS bytes the gate baseline reads.
      const content = ts.fileText(declFile);
      if (content === undefined) {
        return fail({ tool: 'ts-ls', message: `could not read current source of ${declFile}` });
      }
      const replacement = args.edit.remove === true ? '' : (args.edit.replace ?? '');
      const spliced = spliceDecl(content, def.decl, replacement);
      if (spliced === undefined) {
        return fail({
          tool: 'ts-ls',
          message: `declaration span of ${def.name} is out of range for ${declFile}`,
        });
      }

      // 3. The dependent closure (== impact's), driving the typecheck scope.
      const options: UsageOptions = { limit: maxNodes, groupBy: 'enclosing' };
      const seed = ts.findUsages({ symbolId: def.id }, options);
      if (typeof seed === 'string') return fail({ tool: 'ts-ls', message: seed });
      if ('unresolved' in seed) {
        return fail({ tool: 'ts-ls', message: seed.unresolved }, { handle: seed.rebind });
      }
      const seedExpansion = outcomeFromView(seed.view);
      const expand: Expand = (id) => {
        if (id === def.id) return seedExpansion;
        const outcome = ts.findUsages({ symbolId: id }, options);
        if (typeof outcome === 'string' || 'unresolved' in outcome) return { ok: false };
        return outcomeFromView(outcome.view);
      };
      const closure = buildClosure({ id: def.id, name: def.name }, expand, { maxDepth, maxNodes });

      // 4. Typecheck the trial edit across every program owning a dependent (anchor = target ∪
      //    deps), diagnose the same set, and diff vs the pre-edit baseline → introduced errors.
      const checkSet = new Set<RepoRelPath>([declFile]);
      for (const n of closure.nodes) checkSet.add(n.row.file);
      const checkPaths = [...checkSet];
      const gate = ts.gateAcross([{ path: declFile, content: spliced }], {
        anchor: checkPaths,
        check: checkPaths,
      });
      const proof = buildTypecheckField(gate.baseline, gate.overlay);
      // Edit-site vs downstream: a per-file diff over the edited file alone tells us whether the
      // edit broke the target file ITSELF (intra-file consequence or an ill-formed replacement),
      // which is distinct from the downstream blast radius the agent asked about.
      const editSiteDirty = fileBroke(gate.baseline, gate.overlay, declFile);
      // The DOWNSTREAM blast radius: dependent files (excluding the edited one) the edit broke.
      // File-level containment is all we prove — a diagnostic is `file:line`, a closure node carries
      // only its name token, so we never claim a precise broken symbol (§3 — never over-claim).
      const brokenFiles = checkPaths.filter(
        (f) => f !== declFile && fileBroke(gate.baseline, gate.overlay, f),
      );

      const notes = notesFor(
        closure,
        gate.programs,
        gate.degraded,
        declFile,
        editSiteDirty,
        maxDepth,
        maxNodes,
      );

      const data: JsonValue = {
        target: tag('target-ref', { id: def.id, name: def.name, kind: def.kind }),
        simulated: args.edit.remove === true ? 'remove declaration' : 'replace declaration',
        verdict: {
          dependents: closure.nodes.length,
          // The typecheck scope = the edited file + every dependent file (NOT a dependent count —
          // it includes the edit site; a misleading "dependentFiles" would over-count by one).
          filesChecked: checkPaths.length,
          brokenFiles: brokenFiles.length,
          // Did the trial edit break the edited file ITSELF (one CAUSE of an untrustworthy
          // downstream — an intra-file error can collapse an inferred type the dependents rely on).
          editSiteBroke: editSiteDirty,
          // The general "can you trust brokenFiles?" verdict: false when the analysis basis is
          // compromised, so brokenFiles is a LOWER BOUND (breaks may be masked), never a clean
          // signal. Fired regardless of the count — a positive count is still a lower bound.
          downstreamTrusted: !editSiteDirty,
          clean: proof.clean,
        },
        ...(notes.length > 0 ? { notes } : {}),
        typecheck: proof.field,
        ...(args.summary !== true && brokenFiles.length > 0
          ? { brokenBy: brokenFiles.map(String) }
          : {}),
      };
      const extras = seed.rebind !== undefined ? { handle: seed.rebind } : undefined;
      return ok(data, extras);
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
  },
});
