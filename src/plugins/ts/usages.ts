// Reference-site discovery: semantic references from the live LS, classified by role and
// optionally rolled up to enclosing declarations. All results are proof-carrying spans
// built in ./spans.ts from the same SourceFiles the LS answered from. Semantic answers
// come from the live LS — the only oracle (§3.1).

import type ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Confidence, Span } from '../../core/span.ts';
import { matchesAnyGlob } from '../../common/glob/match.ts';
import { spanFromRange } from './spans.ts';
import { mintSymbolId, moduleName } from './symbol-id.ts';
import { classifyRole, findEncloser, type UsageRole } from './usage-roles.ts';
import type { SymbolView, GroupRow, UsageView, UsageOptions, UsagesView } from './query-types.ts';
import type { TsProjectHost } from './ls-host.ts';

/** One in-scope reference site, collected in pass 1 before role filtering / collapse so
 *  the role distribution (§2.3) and the per-file collapse decision (§2.2) can both see
 *  the whole picture. */
type Ref = {
  rel: RepoRelPath;
  sourceFile: ts.SourceFile;
  start: number;
  length: number;
  role: UsageRole;
};

export function findUsages(
  host: TsProjectHost,
  abs: string,
  offset: number,
  options: UsageOptions,
): UsagesView | undefined {
  const groups = host.service.findReferences(abs, offset);
  if (groups === undefined) return undefined;

  let definition: SymbolView | undefined;
  const refs: Ref[] = [];
  const breakdown = new Map<UsageRole, number>();
  let excluded = 0;
  const roleActive = options.role !== undefined;

  // Pass 1: classify every in-scope ref. Path filter applies here; the role filter does
  // NOT yet (it is the question, not an exclusion) — so the role breakdown and the
  // collapse decision both see the full, role-unfiltered picture.
  for (const group of groups) {
    if (definition === undefined && !group.definition.fileName.includes('/node_modules/')) {
      definition = buildDefinition(host, group.definition) ?? definition;
    }
    for (const ref of group.references) {
      if (ref.fileName.includes('/node_modules/')) continue;
      const sourceFile = host.service.getProgram()?.getSourceFile(ref.fileName);
      if (sourceFile === undefined) continue;
      const rel = host.relOf(ref.fileName);
      const role = classifyRole(sourceFile, ref.textSpan.start, {
        isDefinition: ref.isDefinition === true,
        isWrite: ref.isWriteAccess === true,
      });
      // `</X>` is the second token of an element already counted at `<X`.
      if (role === 'jsx-closing') continue;
      const pathPass =
        !(options.pathExclude !== undefined && matchesAnyGlob(rel, options.pathExclude)) &&
        !(options.pathInclude !== undefined && !matchesAnyGlob(rel, options.pathInclude));
      // Breakdown reflects the role-unfiltered answer WITH the same path filters.
      if (pathPass) breakdown.set(role, (breakdown.get(role) ?? 0) + 1);
      const roleMatch = !roleActive || role === options.role;
      if (!roleMatch) continue; // outside the question — counted in breakdown, nothing else
      if (!pathPass) {
        excluded++; // a question-matching ref dropped by YOUR path filter (§3.4)
        continue;
      }
      refs.push({ rel, sourceFile, start: ref.textSpan.start, length: ref.textSpan.length, role });
    }
  }

  // Conditional import collapse (§2.2): an import is bookkeeping for the usages that
  // follow it — drop it only when its file ALSO has a substantive (non-import) ref. Never
  // when the question IS imports (role filter), and off in sql-mode (caller's choice).
  const collapse = !roleActive && options.collapseImports !== false;
  const substantiveFiles = collapse
    ? new Set(refs.filter((r) => r.role !== 'import').map((r) => r.rel))
    : undefined;
  let importsCollapsed = 0;
  const displayed = refs.filter((r) => {
    if (substantiveFiles !== undefined && r.role === 'import' && substantiveFiles.has(r.rel)) {
      importsCollapsed++;
      return false;
    }
    return true;
  });

  const collapseField = importsCollapsed > 0 ? { importsCollapsed } : {};
  const breakdownField = roleActive ? { roleBreakdown: Object.fromEntries(breakdown) } : {};
  const base = {
    ...(definition !== undefined ? { definition } : {}),
    total: refs.length, // counts everything matched — collapse is display-only (§2.2)
    excluded,
    ...collapseField,
    ...breakdownField,
  };

  if (options.groupBy === 'enclosing') {
    const { groups, groupTotal, excluded: rollupExcluded } = rollupGroups(host, displayed, options);
    // Combine path-filter exclusions (pass 1) with kind/exported rollup exclusions.
    return { ...base, groups, groupTotal, excluded: excluded + rollupExcluded };
  }
  const usages: UsageView[] = displayed.slice(0, options.limit).map((r) => ({
    span: spanFromRange(r.sourceFile, r.rel, r.start, r.start + r.length),
    role: r.role,
    confidence: 'certain',
  }));
  return { ...base, usages };
}

/** Every semantic reference SITE span for the symbol at `offset` — all files, all roles,
 *  the definition included, NONE of `find_usages`'s display filters (path/role/collapse).
 *  This is the dedup set the text overlay (§ text-overlay) marks as "covered": a textual
 *  occurrence overlapping any of these is a known semantic ref, not a text-only hit. */
export function referenceSpans(
  host: TsProjectHost,
  abs: string,
  offset: number,
): Span[] | undefined {
  const groups = host.service.findReferences(abs, offset);
  if (groups === undefined) return undefined;
  const spans: Span[] = [];
  for (const group of groups) {
    for (const ref of group.references) {
      if (ref.fileName.includes('/node_modules/')) continue;
      const sourceFile = host.service.getProgram()?.getSourceFile(ref.fileName);
      if (sourceFile === undefined) continue;
      spans.push(
        spanFromRange(
          sourceFile,
          host.relOf(ref.fileName),
          ref.textSpan.start,
          ref.textSpan.start + ref.textSpan.length,
        ),
      );
    }
  }
  return spans;
}

function buildDefinition(
  host: TsProjectHost,
  def: ts.ReferencedSymbolDefinitionInfo,
): SymbolView | undefined {
  const defFile = host.service.getProgram()?.getSourceFile(def.fileName);
  if (defFile === undefined) return undefined;
  const rel = host.relOf(def.fileName);
  const span = spanFromRange(
    defFile,
    rel,
    def.textSpan.start,
    def.textSpan.start + def.textSpan.length,
  );
  // `def.name` from the LS is the full display string; the span text is the identifier
  // itself — use it when it is one.
  const name = /^[\w$]+$/.test(span.text) ? span.text : def.name;
  return { id: mintSymbolId(name, rel, span.line, span.col), name, kind: def.kind, span };
}

/** Roll displayed refs up to their nearest enclosing named declaration. Collapse is
 *  already applied to `displayed`, so the synthetic `(top-level X)` module rows for
 *  collapsed import-only refs simply never form (§2.2). `groupTotal` is the distinct
 *  encloser count BEFORE the limit cap; refs failing the kind/exported filter go to
 *  `excluded` via the returned count. */
function rollupGroups(
  host: TsProjectHost,
  displayed: readonly Ref[],
  options: UsageOptions,
): { groups: GroupRow[]; groupTotal: number; excluded: number } {
  const rollup = new Map<
    string,
    {
      id: string;
      name: string;
      file: RepoRelPath;
      line: number;
      col: number;
      kind: string;
      count: number;
      roles: Set<string>;
      exported: boolean;
    }
  >();
  let excluded = 0;
  for (const r of displayed) {
    const row = rollupRow(host, r.sourceFile, r.rel, r.start, options);
    if (row === undefined) {
      excluded++;
      continue;
    }
    const existing = rollup.get(row.key);
    if (existing === undefined) {
      rollup.set(row.key, {
        id: row.id,
        name: row.name,
        file: r.rel,
        line: row.line,
        col: row.col,
        kind: row.kind,
        count: 1,
        roles: new Set([r.role]),
        exported: row.exported,
      });
    } else {
      existing.count++;
      existing.roles.add(r.role);
    }
  }
  const groups = [...rollup.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, options.limit)
    .map((g) => ({
      id: g.id,
      name: g.name,
      file: g.file,
      line: g.line,
      col: g.col,
      kind: g.kind,
      count: g.count,
      roles: [...g.roles].join(','),
      exported: g.exported,
      // LS structural references are certain; flat usages carry the same value.
      confidence: 'certain' as Confidence,
    }));
  return { groups, groupTotal: rollup.size, excluded };
}

function rollupRow(
  host: TsProjectHost,
  sourceFile: ts.SourceFile,
  rel: RepoRelPath,
  position: number,
  options: UsageOptions,
):
  | {
      key: string;
      id: string;
      name: string;
      line: number;
      col: number;
      kind: string;
      exported: boolean;
    }
  | undefined {
  const enc = findEncloser(sourceFile, position);
  const kind = enc?.kind ?? 'module';
  if (options.enclosingKind !== undefined && kind !== options.enclosingKind) return undefined;
  if (options.exportedOnly === true && enc !== undefined && !enc.exported) return undefined;
  if (enc === undefined) {
    const name = moduleName(rel);
    // A module-level rollup is not an exported symbol — `exported: false` lets SQL drop
    // the synthetic `(top-level X)` nodes without a name LIKE-heuristic.
    return {
      key: `${rel}#<module>`,
      id: mintSymbolId(name, rel, 1, 1),
      name,
      line: 1,
      col: 1,
      kind,
      exported: false,
    };
  }
  const lc = sourceFile.getLineAndCharacterOfPosition(enc.start);
  const line = lc.line + 1;
  const col = lc.character + 1;
  return {
    key: `${rel}#${enc.name}#${enc.start}`,
    id: mintSymbolId(enc.name, rel, line, col),
    name: enc.name,
    line,
    col,
    kind,
    exported: enc.exported,
  };
}
