// The write-side half of the §2.8 contract shared by `applyMutation` and `applyRefactorPlan`
// (t-439159). The overlay gate already typechecked the exact post-edit bytes over the gate's full
// scope, so the post-write work is NOT a second full typecheck — it proves the disk now holds what
// the gate verified and rechecks only what the write could make differ:
//   - before the write: no verdict-relevant drift since the op began, and every file about to be
//     overwritten still holds the bytes the plan was computed from;
//   - after the write: readback of every written path, then a recheck of the written files alone,
//     widened to the gate's full scope only when program membership diverged from the overlay's
//     (`claimDivergence`).
// Rollback happens only on PROVEN damage — the recheck finding an error the edit introduced. A
// recheck that could not finish (deadline, LS throw, reindex throw) or bytes some other writer put
// on disk leave the gate-verified write in place and say so: reverting a verified edit over an
// unfinished check is the inverse lie (§3.6), and reverting over a foreign write destroys it.

import { existsSync, readFileSync } from 'node:fs';
import type { Result } from '../core/result.ts';
import type { JsonValue } from '../core/json.ts';
import type { RepoRelPath } from '../core/brands.ts';
import { ok, fail, messageOfThrown } from '../common/result/construct.ts';
import { isOk } from '../common/result/narrow.ts';
import { DeadlineExceededError } from '../common/async/deadline.ts';
import type { Deadline } from '../common/async/deadline.ts';
import {
  captureWorktree,
  worktreeDrift,
  type WorktreeSnapshot,
} from '../support/git/worktree-snapshot.ts';
import type { GateClaims, TsDiagnostic, TsPluginApi } from '../plugins/ts/plugin.ts';
import type { GateScope } from '../plugins/ts/program-gate.ts';
import { affectsTypecheck } from '../plugins/ts/gate-membership.ts';
import { absOf, buildTypecheckField, type BaselinePathRemap } from './mutation-support.ts';

/** Raw disk text — every plan producer reads with `readFileSync(…, 'utf8')` (BOM and CRLF kept)
 *  and `writeFileAtomic` writes verbatim, so both comparisons are exact. */
function diskText(root: string, rel: RepoRelPath): string | undefined {
  try {
    return readFileSync(absOf(root, rel), 'utf8');
  } catch {
    return undefined;
  }
}

/** The entry fence — captured only for an apply (a dry-run writes nothing and pays no git call).
 *  Awaited BEFORE the gate: the gate is synchronous, so a capture left pending would read its
 *  hashes only after the gate returned and miss any drift during it. */
export async function captureEntry(
  root: string,
  apply: boolean,
): Promise<Result<WorktreeSnapshot> | undefined> {
  return apply ? captureWorktree(root, affectsTypecheck) : undefined;
}

/** Pre-write checks. `ok(reason)` = refuse with that reason (nothing written); `ok(undefined)` =
 *  write. A git failure is a `fail` — we cannot prove the tree is the one the gate verified. */
export async function preWriteCheck(
  root: string,
  atEntry: Result<WorktreeSnapshot> | undefined,
  touched: readonly RepoRelPath[],
  overwrites: readonly { path: RepoRelPath; before: string }[],
  dirtyOk: boolean,
): Promise<Result<string | undefined>> {
  if (atEntry !== undefined && !isOk(atEntry)) return fail(atEntry.failure);
  const now = await captureWorktree(root, affectsTypecheck);
  if (!isOk(now)) return fail(now.failure);
  if (atEntry !== undefined) {
    const drift = worktreeDrift(atEntry.data, now.data);
    if (drift.length > 0) {
      return ok(
        `the working tree changed while this op ran (${drift.join(', ')}) — the typecheck verified a different tree; nothing written, re-run`,
      );
    }
  }
  const dirtySet = new Set(now.data.dirtyPaths);
  const dirty = touched.filter((p) => dirtySet.has(p));
  if (dirty.length > 0 && !dirtyOk) {
    return ok(
      `touched files have uncommitted changes (${dirty.join(', ')}); commit/stash or pass dirtyOk`,
    );
  }
  const moved = overwrites.filter((o) => diskText(root, o.path) !== o.before).map((o) => o.path);
  if (moved.length > 0) {
    return ok(
      `touched files changed on disk after the edit was planned (${moved.join(', ')}) — writing would overwrite that change; nothing written, re-run`,
    );
  }
  return ok(undefined);
}

export interface PostApplyInput {
  ts: TsPluginApi;
  root: string;
  /** Every path the write produced, with the bytes it wrote. */
  written: readonly { path: RepoRelPath; content: string }[];
  /** Paths the write removed (moved-away sources). */
  removed: readonly RepoRelPath[];
  /** The reindex set. */
  touched: readonly RepoRelPath[];
  gateScope: GateScope;
  /** `gateAcross().programs` — the recheck is pinned to them. */
  programs: readonly string[];
  baseline: readonly TsDiagnostic[];
  remap?: BaselinePathRemap;
  claims: GateClaims;
  deadline?: Deadline;
}

export type PostApplyVerdict =
  | { kind: 'verified' }
  | { kind: 'introduced'; field: JsonValue }
  | { kind: 'incomplete'; reason: string };

function readbackMismatch(input: PostApplyInput): RepoRelPath[] {
  const out: RepoRelPath[] = [];
  for (const w of input.written) {
    if (diskText(input.root, w.path) !== w.content) out.push(w.path);
  }
  const written = new Set(input.written.map((w) => w.path));
  for (const r of input.removed) {
    if (!written.has(r) && existsSync(absOf(input.root, r))) out.push(r);
  }
  return out;
}

async function reindex(
  ts: TsPluginApi,
  paths: readonly RepoRelPath[],
): Promise<string | undefined> {
  try {
    await ts.reindex(paths);
    return undefined;
  } catch (thrown) {
    return messageOfThrown(thrown);
  }
}

export async function verifyAfterWrite(input: PostApplyInput): Promise<PostApplyVerdict> {
  const { ts } = input;
  const foreign = readbackMismatch(input);
  if (foreign.length > 0) {
    await reindex(ts, input.touched); // keep the warm LS on what disk now holds
    return {
      kind: 'incomplete',
      reason: `disk holds bytes this op did not write at ${foreign.join(', ')} (a concurrent writer?) — the typecheck verdict describes what was written, not what is there now; not rechecked, not rolled back`,
    };
  }
  const reindexFailure = await reindex(ts, input.touched);
  if (reindexFailure !== undefined) {
    return { kind: 'incomplete', reason: `reindex after the write failed (${reindexFailure})` };
  }
  // The LS polls its cancellation token only inside the checker's bigger nodes, so a recheck
  // started on a spent budget may run to completion — refuse to start it rather than overrun.
  if (input.deadline?.expired() === true) {
    return { kind: 'incomplete', reason: 'the op deadline expired before the post-write recheck' };
  }
  try {
    const diverged = ts.claimDivergence(input.claims, input.programs);
    const check = diverged.length > 0 ? input.gateScope.check : input.written.map((w) => w.path);
    const after = ts.diagnosticsAcross(
      { anchor: input.gateScope.anchor, check },
      input.programs,
      input.deadline,
      { files: input.written, removed: input.removed },
    );
    const gate = buildTypecheckField(input.baseline, after, input.remap);
    return gate.clean ? { kind: 'verified' } : { kind: 'introduced', field: gate.field };
  } catch (thrown) {
    const why =
      thrown instanceof DeadlineExceededError
        ? 'the op deadline expired during the post-write recheck'
        : `the post-write recheck threw (${messageOfThrown(thrown)})`;
    return { kind: 'incomplete', reason: why };
  }
}

/** Envelope fields for an applied write whose post-write recheck did not finish — verdict zone,
 *  so the render cap can never drop them (§12). A verified write adds nothing (byte-identical). */
export function incompleteFields(verdict: PostApplyVerdict): Record<string, JsonValue> {
  if (verdict.kind !== 'incomplete') return {};
  return { postApply: { complete: false, reason: verdict.reason } };
}

export const INCOMPLETE_NOTE =
  'the edit is written; it was typechecked over the overlay before the write, but the post-write recheck did not complete (see postApply.reason)';
