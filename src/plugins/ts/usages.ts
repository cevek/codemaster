// Reference-site discovery: semantic references from the live LS, classified by role and
// optionally rolled up to enclosing declarations. All results are proof-carrying spans
// built in ./spans.ts from the same SourceFiles the LS answered from. Semantic answers
// come from the live LS — the only oracle (§3.1).

import type ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Span } from '../../core/span.ts';
import { passesPathFilter } from '../../common/glob/path-filter.ts';
import { spanFromRange } from './spans.ts';
import { mintSymbolId } from './symbol-id.ts';
import { classifyRole, type UsageRole } from './usage-roles.ts';
import type { SymbolView, UsageView, UsageOptions, UsagesView } from './query-types.ts';
import type { TsProjectHost } from './ls-host.ts';
import { findReferencesAcross, type CrossReferences } from './cross-program.ts';
import { rollupGroups, type Ref } from './usages-rollup.ts';

/** A reference site fed to `assembleView` — the cross-program ref shape plus, in
 *  `mergeDeclarations` mode, the indices of the merged declarations whose reference set
 *  surfaced this site (per-site provenance, §3.3 — never collapse unrelated symbols silently). */
export type SourceRef = {
  rel: RepoRelPath;
  sourceFile: ts.SourceFile;
  start: number;
  length: number;
  isDefinition: boolean;
  isWriteAccess: boolean;
  /** The program that surfaced this ref (`tsconfig.json` / `tsconfig.test.json`), primary
   *  preferred — surfaced as per-ref provenance when more than one program is loaded (Task G). */
  program: string;
  /** Merge mode only: which `mergedDeclarations` entries reference this exact site. */
  declIndices?: number[];
};

export function findUsages(
  host: TsProjectHost,
  abs: string,
  offset: number,
  options: UsageOptions,
): UsagesView | undefined {
  // Fan out across every loaded program containing the decl (spec Task G): a `test/**` usage
  // under a sibling tsconfig counts, deduped against the src refs the primary already sees.
  const cross = findReferencesAcross(host, abs, offset, true);
  if (cross === undefined) return undefined;
  const definition =
    cross.definition !== undefined ? buildDefinition(host, cross.definition) : undefined;
  return assembleView(host, cross.refs, options, definition !== undefined ? { definition } : {});
}

/** Build a `UsagesView` from a set of (already cross-program-deduped) reference sites — the shared
 *  pipeline for both the single-symbol `findUsages` and the multi-declaration merge (usages-merge).
 *  Pass-1 classification + path filter + import collapse + flat/grouped projection live here so the
 *  two entries never drift. `meta` carries the definition (single) or merged declaration list. */
export function assembleView(
  host: TsProjectHost,
  sourceRefs: readonly SourceRef[],
  options: UsageOptions,
  meta: { definition?: SymbolView; mergedDeclarations?: SymbolView[] },
): UsagesView {
  // Per-ref program provenance is only meaningful when several programs are loaded — a
  // single-program repo (the common case) emits no `program`, so its view shape is unchanged.
  const multiProgram = host.programs().length > 1;
  const refs: Ref[] = [];
  const breakdown = new Map<UsageRole, number>();
  let excluded = 0;
  const roleActive = options.role !== undefined;

  // Pass 1: classify every in-scope ref. Path filter applies here; the role filter does
  // NOT yet (it is the question, not an exclusion) — so the role breakdown and the
  // collapse decision both see the full, role-unfiltered picture.
  for (const ref of sourceRefs) {
    const { sourceFile, rel } = ref;
    const role = classifyRole(sourceFile, ref.start, {
      isDefinition: ref.isDefinition,
      isWrite: ref.isWriteAccess,
    });
    // `</X>` is the second token of an element already counted at `<X`.
    if (role === 'jsx-closing') continue;
    const pathPass = passesPathFilter(rel, {
      pathInclude: options.pathInclude,
      pathExclude: options.pathExclude,
    });
    // Breakdown reflects the role-unfiltered answer WITH the same path filters.
    if (pathPass) breakdown.set(role, (breakdown.get(role) ?? 0) + 1);
    const roleMatch = !roleActive || role === options.role;
    if (!roleMatch) continue; // outside the question — counted in breakdown, nothing else
    if (!pathPass) {
      excluded++; // a question-matching ref dropped by YOUR path filter (§3.4)
      continue;
    }
    refs.push({
      rel,
      sourceFile,
      start: ref.start,
      length: ref.length,
      role,
      program: ref.program,
      ...(ref.declIndices !== undefined ? { declIndices: ref.declIndices } : {}),
    });
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
  // §3.4 floor: name the repo tsconfigs we did NOT search (a usage living only under one would be
  // missed) — the op turns a non-empty set into `complete:false` + a `!!` LOWER-BOUND note, so a
  // confident `0` over an alias-only-resolved symbol is impossible.
  const undiscovered = host.undiscoveredProgramLabels();
  const undiscoveredField =
    undiscovered.length > 0 ? { undiscoveredPrograms: [...undiscovered] } : {};
  const base = {
    ...(meta.definition !== undefined ? { definition: meta.definition } : {}),
    ...(meta.mergedDeclarations !== undefined
      ? { mergedDeclarations: meta.mergedDeclarations }
      : {}),
    total: refs.length, // counts everything matched — collapse is display-only (§2.2)
    excluded,
    ...collapseField,
    ...breakdownField,
    ...undiscoveredField,
  };

  if (options.groupBy === 'enclosing') {
    const {
      groups,
      groupTotal,
      excluded: rollupExcluded,
    } = rollupGroups(host, displayed, options, multiProgram);
    // Combine path-filter exclusions (pass 1) with kind/exported rollup exclusions.
    return { ...base, groups, groupTotal, excluded: excluded + rollupExcluded };
  }
  const usages: UsageView[] = displayed.slice(0, options.limit).map((r) => ({
    span: spanFromRange(r.sourceFile, r.rel, r.start, r.start + r.length),
    role: r.role,
    confidence: 'certain',
    ...(multiProgram ? { program: r.program } : {}),
    ...(r.declIndices !== undefined ? { decls: r.declIndices } : {}),
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
  const cross = findReferencesAcross(host, abs, offset, true);
  if (cross === undefined) return undefined;
  return cross.refs.map((ref) =>
    spanFromRange(ref.sourceFile, ref.rel, ref.start, ref.start + ref.length),
  );
}

/** True when the symbol declared at `pos` has a call/construct signature — catches an
 *  arrow/fn-expr-bound `const` (whose LS `kind` is `const`) that `impact`'s kind check would
 *  otherwise treat as non-callable, falsely declaring a value-only-read closure complete.
 *  Uses the checker of the program the definition was found in (a test-declared symbol's checker
 *  is the sibling program's, not the primary's). */
function isCallableAt(program: ts.Program, defFile: ts.SourceFile, pos: number): boolean {
  const checker = program.getTypeChecker();
  let node: ts.Node | undefined;
  const visit = (n: ts.Node): void => {
    if (pos >= n.getStart(defFile) && pos < n.getEnd()) {
      node = n;
      n.forEachChild(visit);
    }
  };
  defFile.forEachChild(visit);
  if (node === undefined) return false;
  try {
    const type = checker.getTypeAtLocation(node);
    return type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0;
  } catch {
    return false;
  }
}

function buildDefinition(
  host: TsProjectHost,
  d: NonNullable<CrossReferences['definition']>,
): SymbolView {
  const { info: def, sourceFile: defFile, program } = d;
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
  return {
    id: mintSymbolId(name, rel, span.line, span.col, host.rootTag),
    name,
    kind: def.kind,
    span,
    callable: isCallableAt(program, defFile, def.textSpan.start),
  };
}
