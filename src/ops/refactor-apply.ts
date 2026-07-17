// The shared mutating-op core (spec §2.10) — every symbol-anchored refactor (rename, and
// later change-signature / move / extract) funnels its per-file before/after edits through
// here to get one honest envelope. The contract, in order:
//
//   1. format each `after` in-memory (project prettier) so the dry-run PREVIEW is
//      byte-identical to what apply writes — `diff(dry) == diff(apply)` (§16.4).
//   2. §2.8 GATE: typecheck the post-edit content over the overlay, DIFFED against a pre-edit
//      baseline over the same scope. An error the edit INTRODUCES → no write, ever (a mis-port
//      surfaces as a diagnostic, never silent corruption); a repo's pre-existing errors don't
//      block (reported as a preExisting count) — the gate judges the edit, not the repo's state.
//   3. apply: dirty-gate the touched files → write → reindex → post-apply DISK typecheck →
//      roll back byte-exact iff THAT typecheck shows newly-introduced errors (never on a
//      prettier hiccup, never on a pre-existing error the edit didn't cause).
//
// Any failure that leaves disk touched (a write that died mid-loop, a post-apply rollback)
// reports the rollback outcome explicitly — a partially-mutated tree is never hidden behind
// a bare failure. Every external-tool call is wrapped → `ToolFailure`; nothing throws (§3.6).

import { createTwoFilesPatch } from 'diff';
import type { Result } from '../core/result.ts';
import type { JsonValue } from '../core/json.ts';
import type { HandleRebind } from '../core/ids.ts';
import type { RepoRelPath } from '../core/brands.ts';
import { ok, fail, messageOfThrown } from '../common/result/construct.ts';
import { failTimeout, failTimeoutOr } from './refactor-timeout.ts';
import { writeFileAtomic } from '../support/text-edits/write.ts';
import type { Capture, TsDiagnostic, TsPluginApi } from '../plugins/ts/plugin.ts';
import type { OpContext } from './registry.ts';
import {
  absOf,
  buildTypecheckField,
  capturesField,
  captureRefusal,
  touchedStat,
  formatOne,
  gateCoverageNotes,
  resolvePrettier,
  dirtyAmong,
} from './mutation-support.ts';

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
   *  complete — a shape-based `codemod` can break an un-matched importer, so it must look beyond
   *  the touched files. A symbol-anchored caller (rename: the LS `findRenameLocations` set is
   *  complete) leaves it off, keeping the typecheck cheap. Either way a repo's pre-existing errors
   *  do not block — the gate diffs post-edit diagnostics against a pre-edit baseline (§3.6). */
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
  /** Capture sites (§ capture-safety) the caller detected — rewritten references that would
   *  silently re-bind to a DIFFERENT symbol (type-compatible → invisible to the §2.8 gate).
   *  Surfaced on every envelope; apply is REFUSED when non-empty. Absent/empty → no capture. */
  captures?: readonly Capture[];
  /** The corrective action named in the capture-refusal message (op-specific, e.g. "pick a
   *  different newName"). */
  captureAction?: string;
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
  const appliedFields = built?.fields ?? {};
  const touched = changes.map((c) => c.path);
  const captures = options.captures ?? [];
  const captureRows = capturesField(captures);
  // Verdict-first envelope tail (§3a): the diff/per-file list is the LAST key, so the render cap can
  // only ever truncate it, never the verdict. `summaryOnly` swaps the (tens-of-KB) unified diff for
  // ONE merged `touched` list (path + `+A -R` counts) — the safety verdict stays, the bytes don't —
  // replacing the redundant bare `touched` (verdict zone) + keyed `diffstat`. In-place ops have no
  // moved-away source, so `gone` is empty. non-summary is byte-identical: bare `touched` in the
  // verdict zone + the unified `diff` tail.
  const summaryOnly = ctx.flags.summaryOnly === true;
  const verdictTouched: Record<string, JsonValue> = summaryOnly ? {} : { touched };
  const tail: Record<string, JsonValue> = summaryOnly
    ? {
        touched: touchedStat(
          changes.map((c) => ({ label: String(c.path), before: c.before, after: c.after })),
        ),
      }
    : {
        diff: changes
          .map((c) => createTwoFilesPatch(c.path, c.path, c.before, c.after, '', ''))
          .join(''),
      };

  // §2.8 gate — typecheck the post-edit content over the overlay. Scope depends on whether the
  // changeset is COMPLETE: a symbol-anchored rename (LS findRenameLocations) touches every ref
  // site, so checking just the changed files is sound AND keeps the typecheck cheap. A shape-based
  // codemod has no such guarantee — it can break an un-matched importer — so it (and only it)
  // widens to the whole program. Pre-existing repo errors don't block either scope: the gate
  // diffs against a pre-edit baseline and refuses only on what THIS edit introduced (below).
  // crossFileScope (codemod): the changeset is incomplete AND can break a SIBLING-only importer, so
  // the scope must span EVERY program's files — a primary-only list would leave a `test/**` importer
  // the codemod broke outside the gate's reach → a cross-program false-clean (the fan-out still runs,
  // but each affected program only diagnoses files present in this scope).
  const checkScope = options.crossFileScope === true ? ts.allProgramTsFiles() : touched;
  // Fan the gate across EVERY program the edit touches (Task G for WRITES): a `test/**` site under
  // a sibling tsconfig is verified too, so a cross-program dangle is caught — not just primary
  // errors (`anchor: touched` selects the affected programs; each sibling checks its whole set).
  const gateScope = { anchor: touched, check: checkScope };
  const overlayFiles = changes.map((c) => ({ path: c.path, content: c.after }));
  let baselineDiag: TsDiagnostic[];
  let overlayDiag: TsDiagnostic[];
  let gateProgms: string[];
  let gateDegraded: string[];
  try {
    // Baseline (pre-edit disk) and overlay sampled over the SAME affected (program × file) set —
    // so a pre-existing repo error is told apart from one THIS edit introduced. The gate refuses on
    // the latter only; a repo's unrelated errors never make a sound rename/move inapplicable.
    const g = ts.gateAcross(overlayFiles, gateScope, ctx.deadline);
    baselineDiag = g.baseline;
    overlayDiag = g.overlay;
    gateProgms = g.programs; // pin the post-apply check to this same program set (symmetry)
    gateDegraded = g.degraded;
  } catch (thrown) {
    // §1 never-hang: the typecheck gate ran past the budget (BEFORE any write) → honest `timeout`.
    return failTimeoutOr('this refactor', 'ts-ls', thrown);
  }
  const gate = buildTypecheckField(baselineDiag, overlayDiag);
  const typecheck = gate.field;

  // Assembled AFTER the gate so the cross-program coverage (how many programs verified the edit,
  // which broken sibling was skipped) rides on EVERY envelope — a 1-program check never reads as
  // repo-wide (§3.6 / §6).
  const notes = [
    ...(options.warnings ?? []),
    ...(built?.notes ?? []),
    ...buildNotes,
    ...formatNotes,
    ...gateCoverageNotes(gateProgms, gateDegraded),
  ];
  const baseNotes = notes.length > 0 ? { notes } : {};

  // Envelope key order matters: the diff/diffstat tail can be tens of KB and the render self-caps
  // at a char budget (§12), so anything emitted AFTER it (the typecheck + captures verdict + touched
  // count — the whole point of the gates) falls past the cap on a big edit and the agent never sees
  // whether the edit is safe (spec-stresstest §3a). So the verdict summary (typecheck, captures)
  // leads and the diff/diffstat is ALWAYS the last key — the cap can only truncate the re-fetchable
  // bytes, never the verdict.
  // A refused dry-run carries no `applied` field — `mode:'dry-run'` + a `reason` already say it was
  // not written (the redundant `applied:false` is dropped; `applied` rides ONLY on `mode:'applied'`).
  const refused = (reason: string): Result<JsonValue> =>
    ok<JsonValue>(
      {
        mode: 'dry-run',
        reason,
        typecheck,
        ...verdictTouched,
        ...captureRows,
        ...baseNotes,
        ...tail,
      },
      handleExtra,
    );

  if (ctx.flags.apply !== true) {
    return ok<JsonValue>(
      { mode: 'dry-run', typecheck, ...verdictTouched, ...captureRows, ...baseNotes, ...tail },
      handleExtra,
    );
  }
  // Capture gate FIRST (§ capture-safety): a type-compatible re-bind is the insidious one the §2.8
  // typecheck cannot see, so refuse on it before the typecheck verdict (both fields stay visible).
  if (captures.length > 0) {
    return refused(
      captureRefusal(
        captures,
        options.captureAction ?? 'pick a different edit, or remove the shadowing binding first',
      ),
    );
  }
  if (!gate.clean) {
    return refused('this edit introduces new typecheck errors — apply refused (§2.8)');
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
        typecheck: tc,
        ...verdictTouched,
        rollback: { performed: reverted.complete, reason },
        ...captureRows,
        ...baseNotes,
        ...tail,
      },
      handleExtra,
    );
  };

  // §1 never-hang — the LAST gate before the atomic write. Even if the LS-cancellation predicate
  // was never tripped (the compute finished just under budget), this cheap poll guarantees the
  // never-CORRUPT invariant's twin: on an exhausted budget we degrade to an honest `timeout` with
  // ZERO files written (§7 write-last), never a partial edit. A tiny injected budget forces exactly
  // this path deterministically (the abort-before-write test).
  if (ctx.deadline?.expired() === true) return failTimeout('this refactor');

  // Write, then verify against the project's own TS reading the real files.
  for (const c of changes) {
    const w = writeFileAtomic(absOf(root, c.path), c.after);
    if (!w.ok) {
      const reverted = await revertAll(root, changes, ts);
      return appliedWithRollback(typecheck, reverted, `write failed (${w.failure.message})`);
    }
  }
  let postGate: { clean: boolean; field: JsonValue };
  try {
    await ts.reindex(touched); // structural reindex reads disk/tsconfig — can throw
    // Diff post-apply disk diagnostics (across the same affected programs) against the SAME pre-edit
    // baseline — a pre-existing repo error must not trigger a (byte-exact, but pointless) rollback.
    postGate = buildTypecheckField(
      baselineDiag,
      ts.diagnosticsAcross(gateScope, gateProgms, ctx.deadline),
    );
  } catch (thrown) {
    const reverted = await revertAll(root, changes, ts);
    return appliedWithRollback(
      typecheck,
      reverted,
      `post-apply typecheck threw (${messageOfThrown(thrown)})`,
    );
  }
  if (!postGate.clean) {
    const reverted = await revertAll(root, changes, ts);
    return appliedWithRollback(postGate.field, reverted, 'post-apply typecheck failed');
  }
  return ok<JsonValue>(
    {
      mode: 'applied',
      applied: true,
      // postGate is clean here; carry it (not a bare {clean:true}) so a repo's pre-existing
      // error count rides along on success too — honest, and consistent with the dry-run field.
      typecheck: postGate.field,
      ...verdictTouched,
      rollback: { performed: false },
      ...baseNotes,
      // Proof spans valid only now that the post-edit content is on disk (§3.2).
      ...appliedFields,
      ...tail, // last — the cap can only ever truncate the diff/touched-stat, never the verdict (§3a).
    },
    handleExtra,
  );
}
