// Execute a `RefactorPlan` (move OR extract) under the §2.10 dry-run/apply contract — the
// shared half both `move_file` and `extract_symbol` reuse. Formats each changed file once so
// the preview is byte-identical to what apply writes, runs the §2.8 typecheck over the
// overlay (tombstones + whole-program scope), then commits and rolls back to the pre-op state
// (the on-disk bytes when the op started, not HEAD — dirty-safe) on failure.

import { existsSync } from 'node:fs';
import { createTwoFilesPatch } from 'diff';
import type { Result } from '../core/result.ts';
import type { JsonValue } from '../core/json.ts';
import type { RepoRelPath } from '../core/brands.ts';
import { ok, fail, failFromThrown } from '../common/result/construct.ts';
import type { TsDiagnostic, TsPluginApi, RefactorPlan } from '../plugins/ts/plugin.ts';
import type { OpContext } from './registry.ts';
import {
  absOf,
  buildTypecheckField,
  capturesField,
  captureRefusal,
  diffstat,
  formatOne,
  gateCoverageNotes,
  resolvePrettier,
  dirtyAmong,
} from './mutation-support.ts';
import { commitMove, revertMove, type CommitMovePlan, type RevertSpec } from './refactor-commit.ts';

/** Apply a planned refactor. `refusalReason` tailors the §2.8 / dirty-gate message per op. */
export async function applyRefactorPlan(
  ctx: OpContext,
  plan: RefactorPlan,
  opts: {
    dirtyOk?: boolean;
    refusalLabel: string;
    cssCoExtract?: JsonValue;
    /** Corrective action named in the capture-refusal message (§ capture-safety). */
    captureAction?: string;
  },
): Promise<Result<JsonValue>> {
  const root = ctx.daemon?.root;
  if (root === undefined)
    return fail({ tool: 'engine', message: 'no workspace root in op context' });
  // A proof-carrying rebind (§6) from a stale SymbolId target — surfaced on every envelope's
  // Result.handle, never silent (a destructive op on a re-located symbol must say so).
  const handleExtra = plan.rebind !== undefined ? { handle: plan.rebind } : undefined;
  const ts = ctx.plugins.get<TsPluginApi>('ts');

  // Format each changed file's content once (so the dry-run preview == the applied bytes).
  const prettier = await resolvePrettier(root);
  const formatted = new Map<string, string>();
  const notes: string[] = [];
  if (plan.notes !== undefined) notes.push(...plan.notes);
  if (plan.rescued === true) {
    // Shared by extract_symbol AND move_symbol (both LS-driven relocations use the §4 rescue) —
    // phrase the provenance neutrally so a rescued MOVE never mislabels itself an "extract" (§3).
    notes.push('LS-refactor edits produced via the patched-LS rescue (§4) — verified by the gate');
  }
  const formatInto = async (rel: RepoRelPath, content: string): Promise<void> => {
    const f = await formatOne(prettier, root, rel, content);
    formatted.set(String(rel), f.content);
    if (f.note !== undefined) notes.push(f.note);
  };
  for (const d of plan.diff) if (d.before !== d.after) await formatInto(d.to, d.after);
  for (const nf of plan.newFiles) await formatInto(nf.path, nf.content);
  const contentOf = (rel: RepoRelPath, fallback: string): string =>
    formatted.get(String(rel)) ?? fallback;

  const touched = [
    ...new Set<RepoRelPath>([
      ...plan.diff.map((d) => d.from),
      ...plan.diff.map((d) => d.to),
      ...plan.newFiles.map((f) => f.path),
    ]),
  ];
  const captures = plan.captures;
  const captureRows = capturesField(captures);
  // Verdict-first tail (§3a): `summaryOnly` swaps the unified diff for a per-file diffstat; either
  // way it is the LAST envelope key, so the render cap truncates only the re-fetchable bytes.
  const tail: Record<string, JsonValue> =
    ctx.flags.summaryOnly === true
      ? {
          diffstat: diffstat(
            plan.diff.map((d) => ({
              label: String(d.to),
              before: d.before,
              after: contentOf(d.to, d.after),
            })),
          ),
        }
      : {
          diff: plan.diff
            .map((d) =>
              createTwoFilesPatch(d.from, d.to, d.before, contentOf(d.to, d.after), '', ''),
            )
            .join(''),
        };
  // §2.8 gate — typecheck the post-edit content; tombstone removed paths, scope to the whole
  // program so a missed rewrite surfaces as a dangling import rather than a silent clean.
  const overlayFiles = plan.overlayFiles.map((o) => ({
    path: o.path,
    content: contentOf(o.path, o.content),
  }));
  // Fan the gate across EVERY program the move/extract touches (Task G for WRITES): a `test/**`
  // importer under a sibling tsconfig is verified too, so a dangling import the primary program
  // can't see is caught. `anchor` (touched + moved-away paths) picks the affected programs; the
  // same whole-tree `checkPaths` fans to each (each program diagnoses the files it contains).
  const gateScope = { anchor: [...touched, ...plan.removed], check: plan.checkPaths };
  let baselineDiag: TsDiagnostic[];
  let diag: TsDiagnostic[];
  let gateProgms: string[];
  let gateDegraded: string[];
  try {
    // Baseline (pre-edit disk) and overlay sampled over the SAME affected (program × file) set — the
    // gate refuses on errors THIS refactor introduces, not on the repo's pre-existing ones.
    const g = ts.gateAcross(overlayFiles, { ...gateScope, removed: plan.removed });
    baselineDiag = g.baseline;
    diag = g.overlay;
    gateProgms = g.programs; // pin post-apply to this set (a move shifts program membership)
    gateDegraded = g.degraded;
  } catch (thrown) {
    return failFromThrown('ts-ls', thrown);
  }
  // A whole-file move renames the file, so its OWN pre-existing errors would leave the baseline
  // under the old path and re-surface under the new path as "introduced" — refusing a
  // semantically-safe move (§1b). Re-key the baseline's moved paths (exact for a file move, prefix
  // for a folder move) so a merely-relocated error matches and drops out.
  //
  // KNOWN LIMITATION (§1b, extract): this covers `move_file` (plan.moves) only. `extract_symbol`
  // populates `newFiles`, not `moves`, and relocates a SUBSET of a file — so an extracted block's
  // own pre-existing error shifts BOTH path AND line, breaking the file·line·message key beyond
  // what a path-remap can repair. A pre-existing error inside an extracted symbol therefore still
  // reads as introduced and over-refuses the extract. Erring toward refuse on a file the edit
  // changed is the safe direction for a write-gate (§2.8); the clean fix is a span-aware remap,
  // tracked as a follow-up. (Extract of clean code — the common case — is unaffected.)
  const remapBaselineFile = (file: string): string => {
    for (const m of plan.moves) {
      if (file === String(m.from)) return String(m.to);
      if (m.kind === 'dir' && file.startsWith(`${m.from}/`)) {
        return `${m.to}${file.slice(String(m.from).length)}`;
      }
    }
    return file;
  };
  const gate = buildTypecheckField(baselineDiag, diag, remapBaselineFile);
  const typecheck = gate.field;

  // Built AFTER the gate so the cross-program coverage (programs checked / broken siblings skipped)
  // rides on every envelope — a 1-program check never reads as repo-wide (§3.6 / §6).
  notes.push(...gateCoverageNotes(gateProgms, gateDegraded));
  const baseNotes = {
    ...(notes.length > 0 ? { notes } : {}),
    ...(opts.cssCoExtract !== undefined ? { cssCoExtract: opts.cssCoExtract } : {}),
  };

  if (ctx.flags.apply !== true) {
    // The diff/diffstat tail is ALWAYS the last key: it can be tens of KB and the render self-caps
    // (§12), so the verdict (typecheck + captures + touched) must lead or it falls past the cap on a
    // big move (§3a).
    return ok<JsonValue>(
      { mode: 'dry-run', typecheck, touched, ...captureRows, ...baseNotes, ...tail },
      handleExtra,
    );
  }
  // Capture gate FIRST (§ capture-safety): a rewritten import landing on a different same-named,
  // type-compatible export is invisible to the §2.8 typecheck — refuse on it before the typecheck
  // verdict (both fields stay visible on the envelope).
  if (captures.length > 0) {
    return ok<JsonValue>(
      {
        mode: 'dry-run',
        applied: false,
        reason: captureRefusal(
          captures,
          opts.captureAction ??
            `the ${opts.refusalLabel} relinks an import onto a different export — choose a different destination or relink manually`,
        ),
        typecheck,
        touched,
        ...captureRows,
        ...baseNotes,
        ...tail,
      },
      handleExtra,
    );
  }
  if (!gate.clean) {
    // Honesty (§3): `extract_symbol` / `move_symbol` do NOT re-key their baseline (the §1b
    // carve-out — both relocate a SUBSET of a file, shifting a moved error's path AND line, beyond
    // a path-remap), so an `introduced` count MAY be a pre-existing error that merely relocated
    // INTO the moved block, not one the edit caused. Don't assert "introduces new errors" as fact
    // for these — hedge it. (move_file re-keys its baseline and gets the flat message.)
    const subsetMove = opts.refusalLabel === 'extract' || opts.refusalLabel === 'move-symbol';
    const reason = subsetMove
      ? `this ${opts.refusalLabel} introduces new typecheck errors — OR relocates a pre-existing one into the moved block, which it can't yet distinguish (§1b); apply refused (§2.8)`
      : `this ${opts.refusalLabel} introduces new typecheck errors — apply refused (§2.8)`;
    return ok<JsonValue>(
      {
        mode: 'dry-run',
        applied: false,
        reason,
        typecheck,
        touched,
        ...captureRows,
        ...baseNotes,
        ...tail,
      },
      handleExtra,
    );
  }

  // A new file OR a move target must land on FRESH ground. The tree is built from git ls-files
  // (§2.6), so it cannot see a gitignored/untracked path already sitting at a newFiles OR a
  // moves[].to path: overwriting it is unrecoverable (never in git → rollback can't restore
  // it), AND rollback's rmSync of a move target would DELETE that pre-existing path the op
  // never created (for a folder move, a recursive nuke of unrelated content). Refuse
  // REGARDLESS of dirtyOk — orthogonal to the dirty waiver. A *tracked* collision is already
  // refused at plan time by the tree; this catches the ones the tree can't see.
  const collidingDests = [
    ...plan.newFiles.map((f) => f.path),
    ...plan.moves.map((m) => m.to),
  ].filter((p) => existsSync(absOf(root, p)));
  if (collidingDests.length > 0) {
    return ok<JsonValue>(
      {
        mode: 'dry-run',
        applied: false,
        reason: `a path already exists at the destination(s) ${collidingDests.join(', ')} — refusing to overwrite`,
        typecheck,
        touched,
        ...captureRows,
        ...baseNotes,
        ...tail,
      },
      handleExtra,
    );
  }

  const dirty = await dirtyAmong(root, touched);
  if (!dirty.ok) return fail(dirty.failure);
  if (dirty.data.length > 0 && opts.dirtyOk !== true) {
    return ok<JsonValue>(
      {
        mode: 'dry-run',
        applied: false,
        reason: `touched files have uncommitted changes (${dirty.data.join(', ')}); commit/stash or pass dirtyOk`,
        typecheck,
        touched,
        ...captureRows,
        ...baseNotes,
        ...tail,
      },
      handleExtra,
    );
  }

  const commitPlan: CommitMovePlan = {
    moves: plan.moves,
    newFiles: plan.newFiles.map((f) => ({ path: f.path, content: contentOf(f.path, f.content) })),
    contentWrites: plan.contentWrites.map((w) => ({
      path: w.path,
      content: contentOf(w.path, w.content),
    })),
  };
  // Rollback restores PRE-OP bytes (`plan.diff[].before` — what was actually on disk when
  // the op started, dirty edits included), NOT HEAD. `restore` covers moved-from + edited
  // files; `remove` drops what the op created (move targets + new files). Synthetic new
  // files have before='' so they're in `remove`, not `restore`.
  const newPaths = new Set(plan.newFiles.map((f) => String(f.path)));
  const revertSpec: RevertSpec = {
    restore: plan.diff
      .filter((d) => !newPaths.has(String(d.to)))
      .map((d) => ({ path: d.from, content: d.before })),
    remove: [...plan.newFiles.map((f) => f.path), ...plan.moves.map((m) => m.to)],
  };

  const rollback = async (why: string, tc: JsonValue): Promise<Result<JsonValue>> => {
    const reverted = await revertMove(root, revertSpec);
    const base = reverted.complete
      ? `${why}; reverted to pre-op state`
      : `${why}; ROLLBACK INCOMPLETE for ${reverted.failed.join(', ')}`;
    const reason = reverted.note !== undefined ? `${base} — note: ${reverted.note}` : base;
    return ok<JsonValue>(
      {
        mode: 'applied',
        applied: false,
        typecheck: tc,
        touched,
        rollback: { performed: reverted.complete, reason },
        ...captureRows,
        ...baseNotes,
        ...tail,
      },
      handleExtra,
    );
  };

  const committed = await commitMove(root, commitPlan);
  if (!committed.ok) return rollback(`commit failed (${committed.failure.message})`, typecheck);

  let postGate: { clean: boolean; field: JsonValue };
  try {
    await ts.reindex(touched); // structural reindex reads disk/tsconfig — can throw
    // Diff post-apply disk diagnostics (across the same affected programs) against the SAME pre-edit
    // baseline — a pre-existing repo error must not roll back a sound refactor.
    postGate = buildTypecheckField(
      baselineDiag,
      ts.diagnosticsAcross(gateScope, gateProgms),
      remapBaselineFile,
    );
  } catch (thrown) {
    return rollback(`post-apply typecheck threw (${String(thrown)})`, typecheck);
  }
  if (!postGate.clean) {
    return rollback('post-apply typecheck failed', postGate.field);
  }
  return ok<JsonValue>(
    {
      mode: 'applied',
      applied: true,
      // postGate is clean here; carry it (not a bare {clean:true}) so a repo's pre-existing
      // error count rides along on success too — honest, and consistent with the dry-run field.
      typecheck: postGate.field,
      touched,
      rollback: { performed: false },
      ...baseNotes,
      ...tail, // last — the cap can only ever truncate the diff/diffstat, never the verdict (§3a).
    },
    handleExtra,
  );
}
