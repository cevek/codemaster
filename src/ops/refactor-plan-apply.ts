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
import { absOf, diagsToJson, formatOne, resolvePrettier, dirtyAmong } from './mutation-support.ts';
import { commitMove, revertMove, type CommitMovePlan, type RevertSpec } from './refactor-commit.ts';

/** Apply a planned refactor. `refusalReason` tailors the §2.8 / dirty-gate message per op. */
export async function applyRefactorPlan(
  ctx: OpContext,
  plan: RefactorPlan,
  opts: { dirtyOk?: boolean; refusalLabel: string; cssCoExtract?: JsonValue },
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
    notes.push('extract edits produced via the patched-LS rescue (§4) — verified by the gate');
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

  const diff = plan.diff
    .map((d) => createTwoFilesPatch(d.from, d.to, d.before, contentOf(d.to, d.after), '', ''))
    .join('');
  const touched = [
    ...new Set<RepoRelPath>([
      ...plan.diff.map((d) => d.from),
      ...plan.diff.map((d) => d.to),
      ...plan.newFiles.map((f) => f.path),
    ]),
  ];
  const baseNotes = {
    ...(notes.length > 0 ? { notes } : {}),
    ...(opts.cssCoExtract !== undefined ? { cssCoExtract: opts.cssCoExtract } : {}),
  };

  // §2.8 gate — typecheck the post-edit content; tombstone removed paths, scope to the whole
  // program so a missed rewrite surfaces as a dangling import rather than a silent clean.
  const overlayFiles = plan.overlayFiles.map((o) => ({
    path: o.path,
    content: contentOf(o.path, o.content),
  }));
  let diag: TsDiagnostic[];
  try {
    diag = ts.typecheckOverlay(overlayFiles, { removed: plan.removed, check: plan.checkPaths });
  } catch (thrown) {
    return failFromThrown('ts-ls', thrown);
  }
  const typecheck: JsonValue =
    diag.length === 0 ? { clean: true } : { clean: false, diagnostics: diagsToJson(diag) };

  if (ctx.flags.apply !== true) {
    return ok<JsonValue>({ mode: 'dry-run', diff, touched, typecheck, ...baseNotes }, handleExtra);
  }
  if (diag.length > 0) {
    return ok<JsonValue>(
      {
        mode: 'dry-run',
        applied: false,
        reason: `post-${opts.refusalLabel} typecheck not clean — apply refused (§2.8)`,
        diff,
        touched,
        typecheck,
        ...baseNotes,
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
        diff,
        touched,
        typecheck,
        ...baseNotes,
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
        diff,
        touched,
        typecheck,
        ...baseNotes,
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
        diff,
        touched,
        typecheck: tc,
        rollback: { performed: reverted.complete, reason },
        ...baseNotes,
      },
      handleExtra,
    );
  };

  const committed = await commitMove(root, commitPlan);
  if (!committed.ok) return rollback(`commit failed (${committed.failure.message})`, typecheck);

  let postDiag: TsDiagnostic[];
  try {
    await ts.reindex(touched); // structural reindex reads disk/tsconfig — can throw
    postDiag = ts.diagnostics(plan.checkPaths);
  } catch (thrown) {
    return rollback(`post-apply typecheck threw (${String(thrown)})`, typecheck);
  }
  if (postDiag.length > 0) {
    return rollback('post-apply typecheck failed', {
      clean: false,
      diagnostics: diagsToJson(postDiag),
    });
  }
  return ok<JsonValue>(
    {
      mode: 'applied',
      applied: true,
      diff,
      touched,
      typecheck: { clean: true },
      rollback: { performed: false },
      ...baseNotes,
    },
    handleExtra,
  );
}
