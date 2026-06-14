// The CSS co-extract JOIN (spec-css-coextract §2.2) — orchestrated at the op level because the
// plugin DAG forbids `ts → scss`. Given an extract plan carrying the block-scoped css analysis
// (`plan.cssExtract`, from the ts plugin), this:
//   1. asks the scss plugin to classify each referenced class (safe vs left-behind, §2.7);
//   2. asks it to clone the safe rules into a new sheet beside the extracted file (§2.4);
//   3. asks the ts plugin to repoint the extracted file's css import + inject `sLegacy` (§2.5);
//   4. folds the new sheet / edited source sheet / rewritten extracted file into the plan so
//      the SAME apply machinery writes them (§2.6).
// Type-blind correctness (§1): `.scss` is not in the TS program, so the §2.8 gate can't vouch
// for a class move — every move is the taxonomy's proven claim, everything else stays + is
// reported. Nothing moves that we can't prove safe.

import * as path from 'node:path';
import type { RepoRelPath } from '../core/brands.ts';
import type { Span } from '../core/span.ts';
import { readTextFile } from '../support/fs/read-file.ts';
import type {
  RefactorPlan,
  CssExtractAnalysis,
  CssExtractCandidate,
  TsPluginApi,
  ImportRewrite,
} from '../plugins/ts/plugin.ts';
import type { ScssPluginApi, ClassVerdict, LeftBehindCode } from '../plugins/scss/plugin.ts';
import type { OpContext } from './registry.ts';

// `type` aliases (not interfaces) so they structurally satisfy `JsonValue` — the op hands the
// report straight to the envelope with no `as unknown` bridge, and a future non-serializable
// field fails to compile rather than riding through silently.
type LeftBehindEntry = {
  class: string;
  code: LeftBehindCode;
  detail?: string;
  reason: string;
  /** Proof span of the class's declaration in the SOURCE sheet (§3.2) — so a COMPOUND / NESTED
   *  / EXTEND / SASS-VAR (etc.) claim is verifiable without re-opening the sheet. Absent for
   *  codes with no clean single sheet location (USED — a TS-usage reason; NO-RULE — the class
   *  has no rule; PARSE-FAIL / ALIAS-IMP — nothing parsed). Never fabricated (§3.2). */
  span?: Span;
};

export type CssCoExtractReport = {
  sourceStylesheet: string;
  /** The new sheet the safe classes moved to, or '' when nothing moved. */
  targetStylesheet: string;
  moved: string[];
  leftBehind: LeftBehindEntry[];
  /** A caveat at the point of action (set when classes moved): co-extract can't see ALIASED
   *  importers of this sheet, so the agent should confirm none of them use the moved classes. */
  note?: string;
};

/** Run the join over `plan.cssExtract`, mutating `plan` with the folded sheet/file edits and
 *  returning one report per source stylesheet. A no-op (returns []) when there's nothing to
 *  co-extract. A scss parse/IO failure is RETURNED (those classes stay behind), never thrown
 *  (the scss plugin's classify/extract are total). An unexpected TS-LS throw (the warm LS /
 *  rewrite) propagates to the dispatcher as an honest op error — and since this runs before the
 *  plan is applied, nothing is ever half-written.
 *
 *  Two passes: (1) classify each css import (per local binding); (2) transform each SOURCE
 *  sheet exactly once with the UNION of every move it received — two `import s/t from './x'`
 *  binding the same sheet must not each write a clobbering "full source minus my own slice". */
export function applyCssCoExtract(ctx: OpContext, plan: RefactorPlan): CssCoExtractReport[] {
  const analysis = plan.cssExtract;
  const root = ctx.daemon?.root;
  if (analysis === undefined || root === undefined) return [];

  const scss = ctx.plugins.get<ScssPluginApi>('scss');
  const ts = ctx.plugins.get<TsPluginApi>('ts');

  // Pass 1 — classify per candidate; collect the moves grouped by source sheet.
  const reports: CssCoExtractReport[] = [];
  const movesBySheet = new Map<RepoRelPath, Move[]>();
  for (const cand of analysis.candidates) {
    const res = classifyCandidate(scss, ts, analysis, cand);
    if (res.report === undefined) continue;
    const reportIdx = reports.push(res.report) - 1;
    if (res.move !== undefined) {
      const group = movesBySheet.get(res.move.sheetRel) ?? [];
      group.push({ ...res.move, reportIdx });
      movesBySheet.set(res.move.sheetRel, group);
    }
  }

  // Pass 2 — one transform per source sheet (union of its moves); fold sheets + rewrites.
  const rewrites: ImportRewrite[] = [];
  const newSheetByPath = new Map<RepoRelPath, string>();
  // Reserve EVERY source sheet up front: a new sheet must never equal a sheet we're editing
  // (e.g. extracting `Foo.tsx` from a `./Foo.module.scss` import would otherwise name the new
  // sheet `Foo.module.scss` == the source, clobbering it on commit). New sheets join as made.
  const usedNewSheets = new Set<RepoRelPath>(movesBySheet.keys());
  for (const [sheetRel, group] of movesBySheet) {
    const union = [...new Set(group.flatMap((m) => m.moved))];
    const extracted = scss.extractRules(sheetRel, union);
    if (!extracted.ok) {
      // Unreachable after a successful classify of the same file in one dry-run; if it ever
      // happens, stay HONEST — move nothing, flip these classes to left-behind, no rewrite.
      for (const m of group) demoteToLeftBehind(reports[m.reportIdx], m.moved, extracted.message);
      continue;
    }
    // Read the pre-op source bytes NOW — needed for the diff `before` AND the rollback `restore`.
    // On a genuine IO failure, abort THIS sheet HONESTLY (leave its classes behind, write nothing)
    // rather than guess before='' — a guessed empty renders the whole sheet as an add and, worse,
    // becomes the rollback restore content, truncating the sheet to empty on a later failure (data
    // loss). Done before any new-sheet state is created so the abort is clean.
    const before = readTextFile(path.join(root, sheetRel));
    if (!before.ok) {
      for (const m of group)
        demoteToLeftBehind(
          reports[m.reportIdx],
          m.moved,
          `source sheet unreadable (${before.failure.message}) — left behind`,
        );
      continue;
    }
    // A DISTINCT source sheet must land in a DISTINCT new sheet — two sheets sharing a class
    // name collapsed into one file would silently alias the two definitions (type-blind, no
    // gate catches it). The default name is `<Component>.module.<ext>`; a collision (a second
    // source sheet of the same ext) disambiguates with the source sheet's base name.
    const newSheetRel = uniqueNewSheet(analysis.extractedFile, sheetRel, usedNewSheets);
    usedNewSheets.add(newSheetRel);
    appendSheet(newSheetByPath, newSheetRel, extracted.sheets.newSheet);
    foldSourceSheetEdit(plan, sheetRel, before.data, extracted.sheets.sourceSheet);
    for (const m of group) {
      const report = reports[m.reportIdx];
      if (report !== undefined) {
        report.targetStylesheet = newSheetRel;
        report.note =
          'verify no ALIASED importer of this sheet uses the moved classes — aliased css imports are not resolved';
      }
      rewrites.push({
        localName: m.localName,
        newSpec: `./${path.posix.basename(newSheetRel)}`,
        legacySpec: m.specifier, // the extracted file's own relative specifier to the sheet
        leftBehind: m.leftBehindClasses,
      });
    }
  }

  // Fold the accumulated new sheet(s) and the rewritten extracted file into the plan.
  for (const [sheetPath, content] of newSheetByPath) {
    plan.newFiles.push({ path: sheetPath, content });
    plan.diff.push({ from: sheetPath, to: sheetPath, before: '', after: content });
  }
  if (rewrites.length > 0) foldExtractedRewrite(plan, ts, analysis.extractedFile, rewrites);

  return reports;
}

/** A pending move of one css import's safe classes out of `sheetRel`, carrying enough to fold
 *  the extracted-file rewrite and finalize the report once the sheet is transformed. */
interface Move {
  sheetRel: RepoRelPath;
  localName: string;
  specifier: string;
  moved: string[];
  leftBehindClasses: string[];
  reportIdx: number;
}

/** Classify one css import: produce its report (or none, for an untracked relative sheet) and,
 *  when there are safe classes, the pending `Move` (without its report index). No I/O — the
 *  sheet transform + plan fold happen in pass 2. */
function classifyCandidate(
  scss: ScssPluginApi,
  ts: TsPluginApi,
  analysis: CssExtractAnalysis,
  cand: CssExtractCandidate,
): { report?: CssCoExtractReport; move?: Omit<Move, 'reportIdx'> } {
  // Aliased import → resolve nothing, report it (§2.8).
  if (!cand.specifier.startsWith('.')) {
    return {
      report: {
        sourceStylesheet: cand.specifier,
        targetStylesheet: '',
        moved: [],
        leftBehind: [
          {
            class: '*',
            code: 'ALIAS-IMP',
            detail: cand.specifier,
            reason: 'aliased import — resolve manually',
          },
        ],
      },
    };
  }
  const sheetRel = cand.sheetRel;
  if (sheetRel === undefined) {
    // A relative specifier whose sheet isn't tracked/resolved — disclose it (we looked and
    // couldn't), never silently skip (§3).
    return {
      report: {
        sourceStylesheet: cand.specifier,
        targetStylesheet: '',
        moved: [],
        leftBehind: [],
        note: 'relative stylesheet not tracked / could not be resolved — nothing moved',
      },
    };
  }
  // The extracted block uses the import non-trivially (spread / rebind / computed) — we can't
  // enumerate what it touches, so repointing the import could strand an access. Skip, disclose.
  if (cand.extractedWildcard) {
    return {
      report: {
        sourceStylesheet: sheetRel,
        targetStylesheet: '',
        moved: [],
        leftBehind: [],
        note: `extracted block uses ${cand.localName} non-trivially (spread / rebind / computed) — co-extract skipped for this import`,
      },
    };
  }
  // We looked but the extracted block referenced no class → an explicit empty report (so
  // "found nothing to move" reads differently from "didn't try"). §3.
  if (cand.refsInExtracted.length === 0) {
    return {
      report: { sourceStylesheet: sheetRel, targetStylesheet: '', moved: [], leftBehind: [] },
    };
  }

  const usedInRemaining = stillUsedClasses(ts, cand, analysis.sourceFile, sheetRel);
  const classified = scss.classifyForExtract(sheetRel, cand.refsInExtracted, usedInRemaining);
  if (!classified.ok) {
    // Parse/IO failure → leave every candidate behind with an honest note, never move (§3.6).
    return {
      report: {
        sourceStylesheet: sheetRel,
        targetStylesheet: '',
        moved: [],
        leftBehind: cand.refsInExtracted.map((cls) => ({
          class: cls,
          code: 'PARSE-FAIL' as const,
          reason: `stylesheet could not be parsed (${classified.message})`,
        })),
      },
    };
  }

  // Declaration spans (proof, §3.2) for the left-behind reasons that point at a sheet rule —
  // reuses the scss plugin's own class spans (assertSpansValid-clean), never re-derives them.
  const declSpans = new Map<string, Span>();
  for (const c of scss.classes(sheetRel)) if (!declSpans.has(c.name)) declSpans.set(c.name, c.span);

  const moved: string[] = [];
  const leftBehind: LeftBehindEntry[] = [];
  for (const cls of cand.refsInExtracted) {
    const verdict = classified.verdicts.get(cls);
    if (verdict !== undefined && verdict.kind === 'safe') moved.push(cls);
    else leftBehind.push(toLeftEntry(cls, verdict, declSpans));
  }

  const report: CssCoExtractReport = {
    sourceStylesheet: sheetRel,
    targetStylesheet: '', // filled in pass 2 if the transform succeeds
    moved,
    leftBehind,
  };
  if (moved.length === 0) return { report };
  return {
    report,
    move: {
      sheetRel,
      localName: cand.localName,
      specifier: cand.specifier,
      moved,
      leftBehindClasses: leftBehind.map((l) => l.class).filter((cls) => cls !== '*'),
    },
  };
}

/** Honest fallback when a sheet transform fails after its classify succeeded (unreachable in a
 *  single dry-run): nothing moved, so flip the reported `moved` classes back to left-behind. */
function demoteToLeftBehind(
  report: CssCoExtractReport | undefined,
  moved: readonly string[],
  message: string,
): void {
  if (report === undefined) return;
  for (const cls of moved) {
    report.leftBehind.push({ class: cls, code: 'PARSE-FAIL', reason: message });
  }
  report.moved = report.moved.filter((cls) => !moved.includes(cls));
  report.targetStylesheet = '';
}

/** Classes that must STAY because the post-extract source — OR another importer of the same
 *  sheet — still uses them. A wildcard (non-trivial use, or a dynamic access anywhere) collapses
 *  to "every referenced class stays". This narrows the shared-sheet silent-dangle hazard the
 *  source-only scope would miss (type-blind, the gate can't catch it) to the importers
 *  codemaster can resolve. KNOWN GAP (honest): `cssModuleUsages` resolves only RELATIVE css
 *  imports (css-modules.ts `resolveRelative`), so a third file importing this same sheet via an
 *  ALIASED specifier (`@/styles/…`) is invisible here — a class only it uses could be moved.
 *  This mirrors codemaster's repo-wide relative-only css resolution (the deferred module-resolve
 *  work, §2.8 / plugins/ts/module-resolve); surfaced as a caveat on the op + spec §2.8. */
function stillUsedClasses(
  ts: TsPluginApi,
  cand: CssExtractCandidate,
  sourceFile: RepoRelPath,
  sheetRel: RepoRelPath,
): Set<string> {
  if (cand.remainingWildcard) return new Set(cand.refsInExtracted);
  const leaveAll = (): Set<string> => new Set(cand.refsInExtracted);
  const used = new Set(cand.refsInRemaining);
  const inExtracted = new Set(cand.refsInExtracted);
  // Wrapped: an LS throw degrades to the conservative "leave every class" (resilience §19).
  try {
    for (const access of ts.cssModuleUsages().byModule.get(sheetRel) ?? []) {
      if (access.confidence === 'dynamic') return leaveAll(); // computed access → leave all
      if (access.className === '') continue;
      // A source-file access for a class the extracted block does NOT reference is a remainder
      // use under SOME binding (possibly a second `import t from './x'`) → it stays. (The source
      // side for THIS binding is already in refsInRemaining.) A class used in BOTH the extracted
      // block and the remainder under a different binding stays a known edge — see §2.8.
      if (access.span.file === sourceFile && inExtracted.has(access.className)) continue;
      used.add(access.className);
    }
  } catch {
    return leaveAll();
  }
  return used;
}

/** Codes whose class IS declared at a single sheet rule, so a declaration span is meaningful
 *  proof. USED (a TS-usage reason) and NO-RULE (no rule at all) intentionally carry none. */
const SPANNED_CODES = new Set<LeftBehindCode>([
  'COMPOUND',
  'NESTED',
  'NEST-PARENT',
  'AT-RULE',
  'SASS-VAR',
  'EXTEND',
  'COMPOSES',
  'KEYFRAMES',
]);

function toLeftEntry(
  cls: string,
  verdict: ClassVerdict | undefined,
  declSpans: ReadonlyMap<string, Span>,
): LeftBehindEntry {
  if (verdict === undefined || verdict.kind === 'safe') {
    return { class: cls, code: 'NO-RULE', reason: 'no verdict produced' };
  }
  // Attach the declaration span only for codes that name a sheet rule AND only when we found
  // one — a class with no scss row (NO-RULE-ish) gets no span rather than a fabricated one.
  const span = SPANNED_CODES.has(verdict.code) ? declSpans.get(cls) : undefined;
  return {
    class: cls,
    code: verdict.code,
    ...(verdict.detail !== undefined ? { detail: verdict.detail } : {}),
    reason: verdict.reason,
    ...(span !== undefined ? { span } : {}),
  };
}

/** Pick the new sheet path beside the extracted file. Default `<Component>.module.<ext>`
 *  (`Card.module.scss` next to `Card.tsx`, keeping the source sheet's extension). If a DISTINCT
 *  source sheet of the same extension already claimed that name, disambiguate with the source
 *  sheet's base (`Card.Other.module.scss`) — never collapse two source sheets into one file. */
function uniqueNewSheet(
  extractedFile: RepoRelPath,
  sheetRel: RepoRelPath,
  used: ReadonlySet<RepoRelPath>,
): RepoRelPath {
  const dir = path.posix.dirname(extractedFile);
  const base = path.posix.basename(extractedFile).replace(/\.(tsx?|jsx?)$/, '');
  const ext = sheetRel.split('.').pop() ?? 'scss';
  const place = (name: string): RepoRelPath =>
    (dir === '.' ? name : `${dir}/${name}`) as RepoRelPath;
  const first = place(`${base}.module.${ext}`);
  if (!used.has(first)) return first;
  // Collision: disambiguate with the source sheet's base, then a counter — keep searching
  // until the name is free, so 3+ source sheets (or clashing srcBases) never re-collide and
  // collapse two sheets into one file (the type-blind aliasing lie).
  const srcBase = path.posix.basename(sheetRel).replace(/\.module\.\w+$|\.\w+$/, '');
  let candidate = place(`${base}.${srcBase}.module.${ext}`);
  for (let n = 2; used.has(candidate); n++)
    candidate = place(`${base}.${srcBase}.${n}.module.${ext}`);
  return candidate;
}

function appendSheet(map: Map<RepoRelPath, string>, sheetPath: RepoRelPath, content: string): void {
  const prev = map.get(sheetPath);
  map.set(sheetPath, prev === undefined ? content : `${prev}\n${content}`);
}

/** Add the edited source sheet to the plan as a content write + diff (scss isn't TS, so it
 *  never joins the overlay/typecheck set). `before` is the pre-op bytes the caller already read
 *  (and aborted on if unreadable) — so the diff `before` and the rollback `restore` are always
 *  the real prior content, never a guessed empty. */
function foldSourceSheetEdit(
  plan: RefactorPlan,
  sheetRel: RepoRelPath,
  before: string,
  after: string,
): void {
  plan.contentWrites.push({ path: sheetRel, content: after });
  plan.diff.push({ from: sheetRel, to: sheetRel, before, after });
}

/** Rewrite the extracted file's css imports/refs and update its plan entries in lockstep: the
 *  synthetic `newFiles` content, its `diff` after-text, AND its overlay content (so the §2.8
 *  typecheck sees the `sLegacy` import + repointed refs resolve). */
function foldExtractedRewrite(
  plan: RefactorPlan,
  ts: TsPluginApi,
  extractedFile: RepoRelPath,
  rewrites: readonly ImportRewrite[],
): void {
  const nf = plan.newFiles.find((f) => f.path === extractedFile);
  if (nf === undefined) return; // the extracted file isn't a fresh file — nothing to rewrite
  const rewritten = ts.rewriteExtractedCss(extractedFile, nf.content, rewrites);
  if (rewritten === nf.content) return;
  nf.content = rewritten;
  for (const d of plan.diff) if (d.to === extractedFile) d.after = rewritten;
  for (const o of plan.overlayFiles) if (o.path === extractedFile) o.content = rewritten;
}
