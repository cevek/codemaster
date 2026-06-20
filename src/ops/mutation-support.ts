// Shared building blocks for the mutating ops (rename / move / …) so the dry-run-apply
// contract is implemented once. Each piece wraps its external tool → never throws across the
// boundary (§3.6); the orchestration (which differs per op — content writes vs git mv) stays
// in the op / its apply helper.

import * as path from 'node:path';
import { diffLines } from 'diff';
import type { Result } from '../core/result.ts';
import type { JsonValue } from '../core/json.ts';
import type { RepoRelPath } from '../core/brands.ts';
import { ok, fail } from '../common/result/construct.ts';
import { isOk } from '../common/result/narrow.ts';
import { tag } from '../common/shape-tag/tag.ts';
import { gitStatus } from '../support/git/status.ts';
import { resolvePrettier, type ResolvedPrettier } from '../support/prettier/resolve.ts';
import { formatContent } from '../support/prettier/format.ts';
import type { Capture, TsDiagnostic } from '../plugins/ts/plugin.ts';

/** Repo-relative path → absolute (posix `/` → OS separators for the filesystem). */
export const absOf = (root: string, rel: RepoRelPath): string => path.join(root, ...rel.split('/'));

/** TS diagnostics → JSON rows (internal to `buildTypecheckField`). */
function diagsToJson(ds: readonly TsDiagnostic[]): JsonValue[] {
  const out: JsonValue[] = [];
  for (const d of ds)
    out.push(tag('ts-diagnostic', { file: String(d.file), line: d.line, message: d.message }));
  return out;
}

/** Cap on the rendered introduced-diagnostics list. The set the gate cares about — what the
 *  EDIT broke — is normally tiny; this only bounds a pathological blow-up so one mutation can't
 *  bury the diff under a wall of errors (the whole-program scope reaches the entire repo). */
const INTRODUCED_DIAG_CAP = 20;

const keyOf = (file: string, line: number, message: string): string =>
  `${file}\0${line}\0${message}`;
const diagKey = (d: TsDiagnostic): string => keyOf(String(d.file), d.line, d.message);

/** Re-key a moved file's path in the baseline so its OWN pre-existing errors don't re-surface as
 *  "introduced" purely because the file changed paths. `move_file`/`extract_symbol` rename a file
 *  (diagnostics key on `file·line·message`), so a pre-existing error leaves the baseline under the
 *  OLD path and re-appears in the post-edit set under the NEW path → an identical, merely relocated
 *  error is mis-counted as edit-introduced and a sound move is refused (spec-stresstest §1b). Maps
 *  `oldPath → newPath`; an in-place edit (rename/codemod) passes none → the identity. */
export type BaselinePathRemap = (file: string) => string;

/** Diagnostics the edit INTRODUCED: post-edit diags whose (file,line,message) is absent from the
 *  pre-edit baseline over the same scope. Pre-existing repo errors live in untouched files at
 *  stable lines, so they match the baseline and drop out; an edit-broken importer or a touched
 *  file's new error survives. A touched file's lines shift, so a pre-existing error THERE can
 *  resurface as "introduced" — accepted on purpose: it sits in a file the edit changed, and for a
 *  write-gate erring toward "surface it / refuse" is the safe direction. A pure path change
 *  (move/extract) re-keys the baseline via `remapBaselineFile` so a relocated-but-identical error
 *  is not counted as introduced (§1b). */
function introducedDiagnostics(
  baseline: readonly TsDiagnostic[],
  after: readonly TsDiagnostic[],
  remapBaselineFile: BaselinePathRemap = (f) => f,
): TsDiagnostic[] {
  // MULTISET diff, not set membership: TS routinely emits several diagnostics that collapse to
  // one (file,line,message) — they differ only by column, which our key drops (`Cannot find name
  // 'Bar'` twice on `Bar + Bar`). A set would let ONE pre-existing occurrence mask N post-edit
  // ones → an edit-introduced error filtered away → a broken edit written as clean. Decrement a
  // per-key baseline count so only the matched count is absorbed; the surplus is genuinely new.
  const remaining = new Map<string, number>();
  for (const d of baseline) {
    const k = keyOf(remapBaselineFile(String(d.file)), d.line, d.message);
    remaining.set(k, (remaining.get(k) ?? 0) + 1);
  }
  const out: TsDiagnostic[] = [];
  for (const d of after) {
    const k = diagKey(d);
    const n = remaining.get(k) ?? 0;
    if (n > 0) remaining.set(k, n - 1);
    else out.push(d);
  }
  return out;
}

/** Build the `typecheck` envelope field by diffing post-edit diagnostics against a pre-edit
 *  baseline. `clean` means the edit introduced NOTHING — a repo's pre-existing errors never block
 *  an unrelated edit (they surface as a `preExisting` count, never as the edit's fault — §3.6).
 *  The introduced list is capped; `moreIntroduced` reports the overflow so a cut never reads as
 *  completeness (§3.4). `remapBaselineFile` re-keys a moved file's baseline path so a path-only
 *  change (move/extract) doesn't mis-count its own pre-existing errors as introduced (§1b). */
export function buildTypecheckField(
  baseline: readonly TsDiagnostic[],
  after: readonly TsDiagnostic[],
  remapBaselineFile?: BaselinePathRemap,
): { clean: boolean; field: JsonValue } {
  const introduced = introducedDiagnostics(baseline, after, remapBaselineFile);
  const preExisting = after.length - introduced.length;
  if (introduced.length === 0) {
    // Tag the clean verdict so the text renderer collapses the `typecheck:`/`clean=true` block to
    // one token (`typecheck=clean` / `typecheck=clean preExisting=N`). json strips the tag → the
    // pre-tag `{clean:true,…}` shape is byte-identical, so every data consumer is unaffected.
    return {
      clean: true,
      field: tag(
        'typecheck-clean',
        preExisting > 0 ? { clean: true, preExisting } : { clean: true },
      ),
    };
  }
  const shown = introduced.slice(0, INTRODUCED_DIAG_CAP);
  return {
    clean: false,
    field: {
      clean: false,
      introduced: diagsToJson(shown),
      ...(introduced.length > shown.length
        ? { moreIntroduced: introduced.length - shown.length }
        : {}),
      ...(preExisting > 0 ? { preExisting } : {}),
    },
  };
}

/** The §2.8 cross-program gate's coverage, as envelope notes: how many programs the verdict rests
 *  on (so a 1-program check is never mistaken for a repo-wide one), and any SIBLING program whose LS
 *  threw and was skipped — a dangle only that program would catch is honestly reported as not gated
 *  (§3.6). Surfaced on every envelope (dry-run / refused / applied). */
export function gateCoverageNotes(
  programs: readonly string[],
  degraded: readonly string[],
): string[] {
  const out: string[] = [];
  // Only when the gate ACTUALLY fanned across >1 program — in a single-tsconfig repo (the common
  // case) "checked 1 program" is pure noise (§12 token-thrift). A degraded sibling is always shown.
  if (programs.length > 1) {
    out.push(`§2.8 gate checked ${programs.length} programs: ${programs.join(', ')}`);
  }
  if (degraded.length > 0) {
    out.push(
      `§2.8 gate could NOT check ${degraded.length} sibling program(s) — SKIPPED (a dangle only they would catch is not gated): ${degraded.join('; ')}`,
    );
  }
  return out;
}

/** Format one file's content with the project prettier in-memory — so a dry-run preview is
 *  byte-identical to what apply writes (§16.4). A prettier failure keeps the unformatted
 *  (already type-checkable) content and is reported, never fatal. */
export async function formatOne(
  prettier: ResolvedPrettier,
  root: string,
  rel: RepoRelPath,
  content: string,
): Promise<{ content: string; note?: string }> {
  if (!prettier.available) return { content };
  const r = await formatContent(prettier.api, absOf(root, rel), content);
  if (r.ok && r.data !== null) return { content: r.data };
  if (!r.ok) return { content, note: `prettier could not format ${rel}: ${r.failure.message}` };
  return { content };
}

export { resolvePrettier };

/** One file's before/after for the diffstat (the `summaryOnly` substitute for the unified diff). */
export interface DiffstatEntry {
  label: string;
  before: string;
  after: string;
}

/** `+added/-removed` line counts for one before/after. */
function lineDelta(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    if (part.added === true) added += part.count ?? 0;
    else if (part.removed === true) removed += part.count ?? 0;
  }
  return { added, removed };
}

/** The single `summaryOnly` touched list (replaces the redundant bare-`touched` + keyed-`diffstat`
 *  pair). Each WRITTEN file is `{ path, added, removed }` (line counts); each moved-away / deleted
 *  source — a path in `touched` that the diffstat never covered — is `{ path, gone:true }`, so a
 *  move's moved-away sources stay visible rather than silently dropped (§3.4). Every row is tagged
 *  so the text renderer prints one `path · +A -R` / `path · (removed)` line; json keeps the
 *  structured fields. The list is the verdict's bulk tail — placed LAST so the cap (§3a) can only
 *  truncate it, never the typecheck/captures verdict. */
export function touchedStat(
  entries: readonly DiffstatEntry[],
  gone: readonly string[] = [],
): JsonValue[] {
  const rows: JsonValue[] = [];
  for (const e of entries) {
    const { added, removed } = lineDelta(e.before, e.after);
    rows.push(tag('touched-stat', { path: e.label, added, removed }));
  }
  for (const p of gone) rows.push(tag('touched-stat', { path: p, gone: true }));
  return rows;
}

/** The envelope `captures` field (the §-capture-safety verdict), empty object when none — so it
 *  spreads cleanly into the envelope only when there is something to refuse on. Each row is
 *  `file:line:col` + kind + detail, the dense shape the §2.8 `typecheck.introduced` list uses. */
export function capturesField(captures: readonly Capture[]): Record<string, JsonValue> {
  if (captures.length === 0) return {};
  return {
    captures: captures.map((c) =>
      tag('capture', { at: `${c.file}:${c.line}:${c.col}`, kind: c.kind, detail: c.detail }),
    ),
  };
}

/** The honest apply-refusal message naming the captured sites + the corrective action (§3.6). */
export function captureRefusal(captures: readonly Capture[], action: string): string {
  const sites = captures.map((c) => `${c.file}:${c.line}:${c.col} ${c.detail}`).join('; ');
  return `this edit would CAPTURE an in-scope binding — refused (a type-compatible shadow is NOT proof the edit is correct): ${sites}. ${action}`;
}

/** Which of `touched` have uncommitted changes (the dirty-gate subset). Surfaces a git
 *  failure honestly rather than guessing the tree is clean. */
export async function dirtyAmong(
  root: string,
  touched: readonly RepoRelPath[],
): Promise<Result<RepoRelPath[]>> {
  const status = await gitStatus(root);
  if (!isOk(status)) return fail(status.failure);
  const dirtySet = new Set(status.data.dirtyPaths);
  return ok(touched.filter((p) => dirtySet.has(p)));
}
