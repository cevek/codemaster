// The textual-occurrence overlay for `find_usages text:true` (§ text-overlay): scan the
// tracked-file listing for word-boundary occurrences of each resolved name, then ANTI-JOIN
// against the symbol's semantic reference spans — a hit overlapping any semantic ref is a
// known reference (covered, dropped); the remainder is `text-only`, identity unproven. The
// agent can't do this dedup cheaply; the join is the value we add over raw ripgrep.

import { gitLsFiles } from '../support/git/ls-files.ts';
import { walkFiles } from '../support/fs/walk.ts';
import { isOk } from '../common/result/narrow.ts';
import { tag } from '../common/shape-tag/tag.ts';
import { intersects } from '../common/span/compare.ts';
import type { JsonValue } from '../core/json.ts';
import type { Span } from '../core/span.ts';
import type { ToolFailure } from '../core/result.ts';
import type { TextScanner } from '../support/text-search/scan.ts';
import type { TsPluginApi, TsTargetInput } from '../plugins/ts/plugin.ts';

/** Cap on text-only hits per name; the rest is honest truncation (§3.4). */
export const TEXT_ONLY_CAP = 50;

interface TextOnlyHit {
  span: Span;
  /** Always `unresolved`: same text, identity NOT proven (the LS never claimed it). */
  confidence: 'unresolved';
}
export interface NameOverlay {
  textOnly: TextOnlyHit[];
  /** Text-only occurrences before the cap. */
  textTotal: number;
}

/** Compute the text-only overlay for every name, scanning the file set ONCE. `covered`
 *  maps each name to its full semantic ref-span set (the dedup set). Returns a
 *  `ToolFailure` only on a whole-scan failure (can't list files, or the scanner failed) —
 *  a single unreadable file is skipped inside the scanner, never blanks the overlay. */
async function computeTextOverlay(
  scanner: TextScanner,
  root: string,
  covered: ReadonlyMap<string, readonly Span[]>,
  cap: number = TEXT_ONLY_CAP,
): Promise<{ ok: true; byName: Map<string, NameOverlay> } | { ok: false; failure: ToolFailure }> {
  const names = [...covered.keys()];
  if (names.length === 0) return { ok: true, byName: new Map() };

  const files = await listTrackedFiles(root);
  if (files === undefined) {
    return {
      ok: false,
      failure: { tool: 'fs', message: 'text scan: could not list workspace files' },
    };
  }
  const scanned = scanner.scan(root, files, names);
  if (!scanned.ok) return { ok: false, failure: scanned.failure };

  const byName = new Map<string, NameOverlay>();
  for (const name of names) {
    const hits = scanned.data.get(name) ?? [];
    const semantic = covered.get(name) ?? [];
    // Anti-join: drop any hit that overlaps a semantic ref span (file-aware §19).
    const textOnly = hits.filter((hit) => !semantic.some((span) => intersects(hit, span)));
    byName.set(name, {
      textOnly: textOnly
        .slice(0, cap)
        .map((hit) => ({ span: hit, confidence: 'unresolved' as const })),
      textTotal: textOnly.length,
    });
  }
  return { ok: true, byName };
}

/** The §10 default listing: git's gitignore-aware set, falling back to the walker. */
async function listTrackedFiles(root: string): Promise<readonly string[] | undefined> {
  const git = await gitLsFiles(root);
  if (isOk(git)) return git.data;
  const walked = walkFiles(root);
  return walked.ok ? walked.data.map((f) => f.path) : undefined;
}

/** Resolve each target's full semantic ref-span set (the dedup set) and compute the
 *  text-only overlay in ONE scan. `failure` set only on a whole-scan failure — the op
 *  then returns its semantic half `partial`, never a whole-call FAIL. */
export async function overlayFor(
  ts: TsPluginApi,
  scanner: TextScanner,
  root: string | undefined,
  cap: number,
  entries: ReadonlyArray<{ name: string; target: TsTargetInput }>,
): Promise<{ byName: Map<string, NameOverlay>; failure?: ToolFailure }> {
  if (root === undefined || entries.length === 0) return { byName: new Map() };
  const covered = new Map<string, Span[]>();
  for (const { name, target } of entries) {
    if (covered.has(name)) continue;
    const refs = ts.referenceSpans(target);
    covered.set(name, typeof refs === 'string' ? [] : refs.spans);
  }
  const overlay = await computeTextOverlay(scanner, root, covered, cap);
  return overlay.ok ? { byName: overlay.byName } : { byName: new Map(), failure: overlay.failure };
}

/** Attach a name's text overlay to its result section, returning the (shown, total) it
 *  contributes to the truncation tally (a capped text table feeds NOT IN → §2.3). States
 *  the "same text — identity NOT proven" contract as a section note. */
export function attachOverlay(
  section: Record<string, JsonValue>,
  overlay: NameOverlay | undefined,
): { shown: number; total: number } {
  if (overlay === undefined) return { shown: 0, total: 0 };
  const existing = Array.isArray(section['notes']) ? (section['notes'] as JsonValue[]) : [];
  // The count rides the section NOTE (the `textOnly (N):` header carries the shown count; the note
  // carries the pre-cap total) — a separate `textTotal` field would just repeat it. The note is
  // emitted even at zero so "no textOnly" never reads as "text scan skipped" (§3.6 capability).
  if (overlay.textOnly.length > 0) {
    section['textOnly'] = overlay.textOnly.map((h) => tag('text-hit', h)) as unknown as JsonValue;
    section['notes'] = [
      ...existing,
      `text-only (same text — identity NOT proven): ${overlay.textTotal} occurrence(s) in comments/strings/docs`,
    ];
  } else {
    section['notes'] = [
      ...existing,
      'text-only: 0 occurrence(s) (scan ran; no comment/string/doc mentions beyond the semantic refs)',
    ];
  }
  return { shown: overlay.textOnly.length, total: overlay.textTotal };
}
