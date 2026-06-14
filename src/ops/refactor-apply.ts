// The shared mutating-op core (spec §2.10) — every symbol-anchored refactor (rename, and
// later change-signature / move / extract) funnels its per-file before/after edits through
// here to get one honest envelope. The contract, in order:
//
//   1. format each `after` in-memory (project prettier) so the dry-run PREVIEW is
//      byte-identical to what apply writes — `diff(dry) == diff(apply)` (§16.4).
//   2. §2.8 GATE: typecheck the post-edit content over the overlay. No clean typecheck →
//      no write, ever (a mis-port surfaces as a diagnostic, never silent corruption).
//   3. apply: dirty-gate the touched files → write → reindex → post-apply DISK typecheck →
//      roll back byte-exact iff THAT typecheck fails (never on a prettier hiccup).
//
// Any failure that leaves disk touched (a write that died mid-loop, a post-apply rollback)
// reports the rollback outcome explicitly — a partially-mutated tree is never hidden behind
// a bare failure. Every external-tool call is wrapped → `ToolFailure`; nothing throws (§3.6).

import { createTwoFilesPatch } from 'diff';
import type { Result } from '../core/result.ts';
import type { JsonValue } from '../core/json.ts';
import type { HandleRebind } from '../core/ids.ts';
import type { RepoRelPath } from '../core/brands.ts';
import { ok, fail, failFromThrown, messageOfThrown } from '../common/result/construct.ts';
import { writeFileAtomic } from '../support/text-edits/write.ts';
import type { TsDiagnostic, TsPluginApi } from '../plugins/ts/plugin.ts';
import type { OpContext } from './registry.ts';
import { absOf, diagsToJson, formatOne, resolvePrettier, dirtyAmong } from './mutation-support.ts';

/** One file's full before/after content (offsets already applied by the plugin). */
export interface MutationChange {
  path: RepoRelPath;
  before: string;
  after: string;
}

export interface ApplyOptions {
  /** Override the touched-files-dirty refusal (§7 `dirtyOk`). */
  dirtyOk?: boolean;
  /** A rebound stale handle to surface on `Result.handle` (§6). */
  handle?: HandleRebind;
  /** Caller-supplied completeness caveats (e.g. rename sites that could not be edited) —
   *  merged into the envelope's `notes` so an incomplete edit is never reported as clean. */
  warnings?: readonly string[];
  /** Widen the §2.8 gate to the WHOLE program. Set ONLY by a caller whose changeset is NOT
   *  complete — a shape-based `codemod` can break an un-matched importer. A symbol-anchored
   *  caller (rename: the LS `findRenameLocations` set is complete) leaves it off, keeping the
   *  hot path narrow and not refusing on a repo with unrelated pre-existing errors. */
  crossFileScope?: boolean;
  /** Build a disclosure from the FORMATTED changes (post-prettier), run once after formatting.
   *  Its `notes` (plain text, NO span claims) append to the envelope `notes` in EVERY mode — a
   *  preview warning. Its `fields` carry proof spans computed from the post-edit content, so they
   *  are valid against disk ONLY after a successful apply: they are attached to the
   *  applied-success envelope ALONE — never to a dry-run / refused / rolled-back one, where disk
   *  still holds the pre-edit text (§3.2 — a span must match the bytes at its `file:line`). Used
   *  by `rename_symbol` to disclose old-name survivors; absent when the rename is complete. */
  buildNote?: (
    changes: readonly MutationChange[],
  ) => { fields?: Record<string, JsonValue>; notes?: string[] } | undefined;
}

/** Write every `before` back to disk (byte-exact revert) and reindex. Best-effort: a failed
 *  revert is reported, never swallowed — a partially-reverted tree is the worst case. */
function revertAll(
  root: string,
  changes: readonly MutationChange[],
  ts: TsPluginApi,
): Promise<{ complete: boolean; failed: RepoRelPath[] }> {
  const failed: RepoRelPath[] = [];
  for (const c of changes) {
    if (!writeFileAtomic(absOf(root, c.path), c.before).ok) failed.push(c.path);
  }
  // The disk revert already happened; a reindex failure only leaves the warm index stale
  // (the next op's read-time freshness check reconciles), so it must never throw out of the
  // rollback — wrap it (it can throw synchronously before the promise forms).
  return safeReindex(
    ts,
    changes.map((c) => c.path),
  ).then(() => ({
    complete: failed.length === 0,
    failed,
  }));
}

/** Reindex without ever throwing — a structural reindex reads disk/tsconfig and can fail. */
function safeReindex(ts: TsPluginApi, paths: readonly RepoRelPath[]): Promise<void> {
  try {
    return ts.reindex(paths).catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}

export async function applyMutation(
  ctx: OpContext,
  rawChanges: readonly MutationChange[],
  options: ApplyOptions = {},
): Promise<Result<JsonValue>> {
  const root = ctx.daemon?.root;
  if (root === undefined)
    return fail({ tool: 'engine', message: 'no workspace root in op context' });
  const ts = ctx.plugins.get<TsPluginApi>('ts');
  const handleExtra = options.handle !== undefined ? { handle: options.handle } : undefined;

  const prettier = await resolvePrettier(root);
  const formatNotes: string[] = [];
  const changes: MutationChange[] = [];
  for (const c of rawChanges) {
    const f = await formatOne(prettier, root, c.path, c.after);
    if (f.note !== undefined) formatNotes.push(f.note);
    changes.push({ path: c.path, before: c.before, after: f.content });
  }
  // Built from the FORMATTED `changes`. `notes` are span-free text → safe in every envelope;
  // `appliedFields` carry proof spans valid only post-write → spread into the applied-success
  // envelope alone (below), never into a dry-run/refused/rollback one. Wrapped (§3.6): a note
  // builder that throws degrades the disclosure to a warning — it never sinks the mutation,
  // whose correctness (diff + typecheck) is independent of this optional signal.
  let built: { fields?: Record<string, JsonValue>; notes?: string[] } | undefined;
  const buildNotes: string[] = [];
  try {
    built = options.buildNote?.(changes);
  } catch (thrown) {
    buildNotes.push(`could not compute the completeness signal (${messageOfThrown(thrown)})`);
  }
  const notes = [
    ...(options.warnings ?? []),
    ...(built?.notes ?? []),
    ...buildNotes,
    ...formatNotes,
  ];
  const baseNotes = notes.length > 0 ? { notes } : {};
  const appliedFields = built?.fields ?? {};
  const touched = changes.map((c) => c.path);
  const diff = changes
    .map((c) => createTwoFilesPatch(c.path, c.path, c.before, c.after, '', ''))
    .join('');

  // §2.8 gate — typecheck the post-edit content over the overlay. Scope depends on whether the
  // changeset is COMPLETE: a symbol-anchored rename (LS findRenameLocations) touches every ref
  // site, so checking just the changed files is sound AND keeps the hot path narrow (it won't
  // refuse on a repo with unrelated pre-existing errors). A shape-based codemod has no such
  // guarantee — it can break an un-matched importer — so it (and only it) widens to the whole
  // program (which, like the plan ops, then refuses on a pre-existing-error repo).
  const checkScope = options.crossFileScope === true ? ts.programTsFiles() : touched;
  let overlayDiag: TsDiagnostic[];
  try {
    overlayDiag = ts.typecheckOverlay(
      changes.map((c) => ({ path: c.path, content: c.after })),
      { check: checkScope },
    );
  } catch (thrown) {
    return failFromThrown('ts-ls', thrown);
  }
  const typecheck: JsonValue =
    overlayDiag.length === 0
      ? { clean: true }
      : { clean: false, diagnostics: diagsToJson(overlayDiag) };

  // A requested apply we decline to perform (gate unclean / dirty tree) — nothing written.
  const refused = (reason: string): Result<JsonValue> =>
    ok<JsonValue>(
      { mode: 'dry-run', applied: false, reason, diff, touched, typecheck, ...baseNotes },
      handleExtra,
    );

  if (ctx.flags.apply !== true) {
    return ok<JsonValue>({ mode: 'dry-run', diff, touched, typecheck, ...baseNotes }, handleExtra);
  }
  if (overlayDiag.length > 0) {
    return refused('post-edit typecheck not clean — apply refused (§2.8)');
  }

  // Dirty gate — refuse if a TOUCHED file has uncommitted changes (rollback restores the
  // pre-op content; an unrelated dirty file in the worktree is never our concern).
  const dirtyResult = await dirtyAmong(root, touched);
  if (!dirtyResult.ok) return fail(dirtyResult.failure);
  if (dirtyResult.data.length > 0 && options.dirtyOk !== true) {
    return refused(
      `touched files have uncommitted changes (${dirtyResult.data.join(', ')}); commit/stash or pass dirtyOk`,
    );
  }

  // Applied envelope after disk was touched — always carries the rollback outcome.
  const appliedWithRollback = (
    tc: JsonValue,
    reverted: { complete: boolean; failed: RepoRelPath[] },
    why: string,
  ): Result<JsonValue> => {
    const reason = reverted.complete
      ? `${why}; reverted byte-exact`
      : `${why}; ROLLBACK INCOMPLETE for ${reverted.failed.join(', ')}`;
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

  // Write, then verify against the project's own TS reading the real files.
  for (const c of changes) {
    const w = writeFileAtomic(absOf(root, c.path), c.after);
    if (!w.ok) {
      const reverted = await revertAll(root, changes, ts);
      return appliedWithRollback(typecheck, reverted, `write failed (${w.failure.message})`);
    }
  }
  let postDiag: TsDiagnostic[];
  try {
    await ts.reindex(touched); // structural reindex reads disk/tsconfig — can throw
    postDiag = ts.diagnostics(checkScope);
  } catch (thrown) {
    const reverted = await revertAll(root, changes, ts);
    return appliedWithRollback(
      typecheck,
      reverted,
      `post-apply typecheck threw (${messageOfThrown(thrown)})`,
    );
  }
  if (postDiag.length > 0) {
    const reverted = await revertAll(root, changes, ts);
    return appliedWithRollback(
      { clean: false, diagnostics: diagsToJson(postDiag) },
      reverted,
      'post-apply typecheck failed',
    );
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
      // Proof spans valid only now that the post-edit content is on disk (§3.2).
      ...appliedFields,
    },
    handleExtra,
  );
}
