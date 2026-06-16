// Capture detection for `codemod` — the hard flavor: shape-based, NO symbol anchor (§7). We
// cannot anchor on a renamed declaration, so we snapshot the resolved declaration of every
// reference identifier INSIDE each rewritten region BEFORE the edit, then re-resolve the same
// identifier (matched by text, at its shifted position) AFTER the overlay: a preserved reference
// that now binds to a DIFFERENT declaration is a forward capture the §2.8 typecheck can't see
// (type-compatible) — e.g. a `$X` capture landing inside a new lambda whose param shadows it.
//
// RESIDUAL GAP (documented honestly, per spec): this catches re-resolution of identifiers that
// SURVIVE the rewrite (metavar captures) and sit inside the rewritten span. It does NOT flag an
// INTRODUCED identifier (literal template text) that happens to bind a same-named local — flagging
// that would refuse legitimate codemods wholesale (the §1 over-refusal risk) — nor a reference
// OUTSIDE the span whose scope the rewrite changed (e.g. deleting a shadowing declaration). Those
// reside with the whole-program typecheck the codemod already runs. See docs/backlog.md.

import ts from 'typescript';
import type { TsProjectHost } from '../../ls-host.ts';
import type { RepoRelPath } from '../../../../core/brands.ts';
import { toPosix } from '../../../../support/fs/canonicalize.ts';
import type { Capture } from './types.ts';
import { captureAt, declarationDefAt, withOverlay } from './overlay.ts';

/** A rewritten span, addressed both in the pre-edit (`before*`) and post-edit (`after*`) text —
 *  the op computes these from the ast-grep match ranges + the per-match replacement lengths. */
export interface CodemodRegion {
  beforeStart: number;
  beforeEnd: number;
  afterStart: number;
  afterEnd: number;
}

/** One rewritten file's pre/post content + the spans the rewrite changed. */
export interface CodemodEdit {
  path: RepoRelPath;
  before: string;
  after: string;
  regions: readonly CodemodRegion[];
}

/** Captures where a metavar-preserved reference inside a rewritten span re-resolves to a
 *  different declaration after the codemod. Empty when every preserved reference still binds to
 *  the same symbol. */
export function detectCodemodCaptures(
  host: TsProjectHost,
  edits: readonly CodemodEdit[],
): Capture[] {
  // The two phases resolve declarations against DIFFERENT program states (disk pre-edit vs the
  // overlay post-edit), so an edited file's declaration offsets SHIFT between them. Comparing raw
  // post-edit offsets to pre-edit ones would read a merely-relocated same symbol as a different one
  // → a fabricated capture on a clean codemod (the #1 over-refusal risk). So every declaration key
  // is normalized to PRE-EDIT offset space: an after-offset is mapped back through the same per-file
  // length deltas the rewrite produced.
  const { toBefore, beforeInside } = offsetMappers(host, edits);
  // Pre-edit declarations sit in before-offset space; post-edit in after-offset space. Both are
  // keyed in PRE-EDIT space so a merely-relocated same symbol keys identically. A declaration that
  // lives INSIDE a rewritten span keys to `undefined` in BOTH phases — symmetry is load-bearing: a
  // metavar bound to an in-pattern local/param (e.g. `$X` of `($X)=>$X.id`) resolves to a decl
  // inside the span before AND after, so without the before-phase inside guard it would key defined
  // before / undefined after → a FABRICATED capture (the #1 over-refusal risk). Keyed `undefined`
  // both sides, it collapses into the `bKey === undefined → continue` skip — the documented
  // introduced-identifier residual gap, guarded by the whole-program §2.8 typecheck, not a new miss.
  const rawKey = (def: { fileName: string; start: number } | undefined): string | undefined =>
    def === undefined || beforeInside(def.fileName, def.start)
      ? undefined
      : `${toPosix(def.fileName)}|${def.start}`;
  const remappedKey = (
    def: { fileName: string; start: number } | undefined,
  ): string | undefined => {
    if (def === undefined) return undefined;
    const before = toBefore(def.fileName, def.start);
    return before === undefined ? undefined : `${toPosix(def.fileName)}|${before}`;
  };

  // Pre-edit: resolve each region's reference identifiers to their declaration (disk = before).
  // Keyed per (file, regionIndex) → text → declaration key.
  const beforeByRegion = new Map<string, Map<string, string>>();
  for (const e of edits) {
    const abs = host.absOf(e.path);
    e.regions.forEach((r, i) => {
      const m = new Map<string, string>();
      for (const id of referenceIdentifiersInRange(e.before, r.beforeStart, r.beforeEnd)) {
        if (m.has(id.text)) continue; // first occurrence anchors the text's pre-edit binding
        const k = rawKey(declarationDefAt(host, abs, id.pos));
        if (k !== undefined) m.set(id.text, k);
      }
      beforeByRegion.set(`${e.path}#${i}`, m);
    });
  }

  // Post-edit: overlay all rewritten files, re-resolve each region's reference identifiers, and
  // compare in the SAME pre-edit offset space.
  const overlay = edits.map((e) => ({ abs: host.absOf(e.path), content: e.after }));
  return withOverlay(host, overlay, [], () => {
    const program = host.service.getProgram();
    const out: Capture[] = [];
    for (const e of edits) {
      const abs = host.absOf(e.path);
      e.regions.forEach((r, i) => {
        const before = beforeByRegion.get(`${e.path}#${i}`);
        if (before === undefined || before.size === 0) return;
        const seen = new Set<string>();
        for (const id of referenceIdentifiersInRange(e.after, r.afterStart, r.afterEnd)) {
          if (seen.has(id.text)) continue;
          const bKey = before.get(id.text);
          if (bKey === undefined) continue; // introduced or unresolved before → typecheck guards
          seen.add(id.text);
          const aKey = remappedKey(declarationDefAt(host, abs, id.pos));
          if (aKey !== bKey) {
            out.push(
              captureAt(
                host,
                program,
                abs,
                id.pos,
                'forward',
                `'${id.text}' now resolves to a different declaration than before the codemod`,
              ),
            );
          }
        }
      });
    }
    return out;
  });
}

/** Per-edited-file offset mappers normalizing declaration positions into PRE-EDIT space:
 *  - `toBefore(file, afterOffset)` reverse-maps a POST-edit offset through the accumulated length
 *    deltas of earlier rewritten regions; `undefined` when the offset is INSIDE a rewritten span.
 *  - `beforeInside(file, beforeOffset)` is `true` when a PRE-edit offset falls inside a rewritten
 *    span (the before-space counterpart, so a decl authored inside the pattern keys `undefined`
 *    symmetrically in both phases).
 *  An un-edited file maps by identity / is never inside a span. */
function offsetMappers(
  host: TsProjectHost,
  edits: readonly CodemodEdit[],
): {
  toBefore: (fileName: string, afterOffset: number) => number | undefined;
  beforeInside: (fileName: string, beforeOffset: number) => boolean;
} {
  const byFile = new Map<
    string,
    {
      beforeStart: number;
      beforeEnd: number;
      afterStart: number;
      afterEnd: number;
      delta: number;
    }[]
  >();
  for (const e of edits) {
    const regions = [...e.regions]
      .sort((a, b) => a.afterStart - b.afterStart)
      .map((r) => ({
        beforeStart: r.beforeStart,
        beforeEnd: r.beforeEnd,
        afterStart: r.afterStart,
        afterEnd: r.afterEnd,
        delta: r.afterEnd - r.afterStart - (r.beforeEnd - r.beforeStart),
      }));
    byFile.set(toPosix(host.absOf(e.path)), regions);
  }
  return {
    toBefore: (fileName, afterOffset) => {
      const regions = byFile.get(toPosix(fileName));
      if (regions === undefined) return afterOffset; // un-edited file → offsets are stable
      let acc = 0;
      for (const r of regions) {
        if (afterOffset >= r.afterEnd) acc += r.delta;
        else if (afterOffset >= r.afterStart)
          return undefined; // inside a rewritten span
        else break;
      }
      return afterOffset - acc;
    },
    beforeInside: (fileName, beforeOffset) => {
      const regions = byFile.get(toPosix(fileName));
      if (regions === undefined) return false;
      return regions.some((r) => beforeOffset >= r.beforeStart && beforeOffset < r.beforeEnd);
    },
  };
}

/** Reference identifiers (NOT declaration names / property members) whose start sits in
 *  `[start, end)`. Parsed with a throwaway source file purely to enumerate positions; resolution
 *  is the LS's job against the real file at those offsets. */
function referenceIdentifiersInRange(
  content: string,
  start: number,
  end: number,
): { text: string; pos: number }[] {
  const sf = ts.createSourceFile(
    '__capture_probe__.tsx',
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const out: { text: string; pos: number }[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && isReferenceIdentifier(n)) {
      const pos = n.getStart(sf);
      if (pos >= start && pos < end) out.push({ text: n.text, pos });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** True when `node` is a genuine reference (a use), not the NAME of a declaration / parameter /
 *  binding, nor a member name on a property access — those don't "resolve" to a shadowing
 *  binding, so comparing them would be noise. */
function isReferenceIdentifier(node: ts.Identifier): boolean {
  const p = node.parent as ts.Node | undefined;
  if (p === undefined) return true;
  if (
    (ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isBindingElement(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isClassDeclaration(p) ||
      ts.isClassExpression(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isTypeAliasDeclaration(p) ||
      ts.isInterfaceDeclaration(p) ||
      ts.isEnumDeclaration(p) ||
      ts.isImportClause(p) ||
      ts.isImportSpecifier(p) ||
      ts.isModuleDeclaration(p)) &&
    p.name === node
  ) {
    return false;
  }
  if (ts.isPropertyAccessExpression(p) && p.name === node) return false;
  if (ts.isQualifiedName(p) && p.right === node) return false;
  return true;
}
