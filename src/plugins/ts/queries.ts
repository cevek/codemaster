// Read-side TS queries: search / definition / usages / type expansion. All results
// are proof-carrying spans built in ./spans.ts from the same SourceFiles the LS
// answered from. Semantic answers come from the live LS — the only oracle (§3.1).

import type ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Confidence, Span } from '../../core/span.ts';
import { encodeSymbolId } from '../../common/ids/codec.ts';
import { matchesAnyGlob } from '../../common/glob/match.ts';
import { spanFromRange } from './spans.ts';
import { classifyRole, findEncloser, type UsageRole } from './usage-roles.ts';
import type { TsProjectHost } from './ls-host.ts';

export type SymbolView = {
  id: string;
  name: string;
  kind: string;
  span: Span;
  container?: string;
};

export type UsageView = {
  span: Span;
  role: UsageRole;
  confidence: Confidence;
};

/** One enclosing-declaration rollup row. `id` is a chainable ts: SymbolId of the
 *  encloser (it carries name + file:line:col); `count` = references inside it. */
export type GroupRow = {
  id: string;
  kind: string;
  count: number;
  roles: string;
};

export type UsageOptions = {
  limit: number;
  /** Keep only references with this syntactic role (e.g. 'jsx'). */
  role?: UsageRole | undefined;
  /** Roll references up to their nearest enclosing named declaration. */
  groupBy?: 'enclosing' | undefined;
  pathInclude?: readonly string[] | undefined;
  pathExclude?: readonly string[] | undefined;
  /** Grouped mode: keep only enclosers of this kind ('function'|'method'|'class'|'module'). */
  enclosingKind?: string | undefined;
  /** Grouped mode: keep only exported enclosers. */
  exportedOnly?: boolean | undefined;
};

export type UsagesView = {
  definition?: SymbolView;
  /** Flat mode. */
  usages?: UsageView[];
  /** Grouped mode (`groupBy: 'enclosing'`), sorted by count desc. */
  groups?: GroupRow[];
  /** References matching the question (post role filter), before the limit cap. */
  total: number;
  /** References dropped by YOUR filters (path/kind/exported) — explicit, so a filter
   *  never reads as completeness (§3.4). */
  excluded: number;
};

export type TypeView = {
  about: string;
  type: string;
  doc?: string;
  span?: Span;
};

function mintSymbolId(name: string, rel: RepoRelPath, line: number, col: number): string {
  return encodeSymbolId('ts', `${name}@${rel}:${line}:${col}`);
}

export type SearchView = {
  matches: SymbolView[];
  /** Eligible matches seen (post node_modules filter) — may exceed `matches.length`
   *  when the cap hit; the op surfaces that as explicit truncation (§3.4). The LS
   *  itself was asked for a bounded set, so this is a floor, not a guess. */
  total: number;
};

export type SearchFilter = {
  kind?: string | undefined;
  exportedOnly?: boolean | undefined;
  pathInclude?: readonly string[] | undefined;
  pathExclude?: readonly string[] | undefined;
};

export function searchSymbols(
  host: TsProjectHost,
  query: string,
  limit: number,
  filter?: SearchFilter,
): SearchView {
  // excludeDtsFiles: with it off, the LS spends the whole result budget on lib.d.ts /
  // node_modules declarations (createElement, …) and a small limit comes back EMPTY
  // after our node_modules filter — an honest-looking lie. Project-local .d.ts symbols
  // are out of search scope for now (schema.d.ts gets its own plugin in Phase 3).
  const items = host.service.getNavigateToItems(query, limit * 4, undefined, true);
  const views: SymbolView[] = [];
  let total = 0;
  for (const item of items) {
    if (item.fileName.includes('/node_modules/')) continue;
    if (filter?.kind !== undefined && item.kind !== filter.kind) continue;
    if (filter?.exportedOnly === true && !item.kindModifiers.split(',').includes('export')) {
      continue;
    }
    const rel = host.relOf(item.fileName);
    if (filter?.pathExclude !== undefined && matchesAnyGlob(rel, filter.pathExclude)) continue;
    if (filter?.pathInclude !== undefined && !matchesAnyGlob(rel, filter.pathInclude)) continue;
    total++;
    if (views.length >= limit) continue; // keep counting — a silent cutoff is a lie
    const view = navigateToView(host, item);
    if (view !== undefined) views.push(view);
  }
  return { matches: views, total };
}

export function findDefinitions(
  host: TsProjectHost,
  abs: string,
  offset: number,
): SymbolView[] | undefined {
  const defs = host.service.getDefinitionAtPosition(abs, offset);
  if (defs === undefined) return undefined;
  const views: SymbolView[] = [];
  for (const def of defs) {
    const sourceFile = host.service.getProgram()?.getSourceFile(def.fileName);
    if (sourceFile === undefined) continue;
    const rel = host.relOf(def.fileName);
    const span = spanFromRange(
      sourceFile,
      rel,
      def.textSpan.start,
      def.textSpan.start + def.textSpan.length,
    );
    views.push({
      id: mintSymbolId(def.name, rel, span.line, span.col),
      name: def.name,
      kind: def.kind,
      span,
      ...(def.containerName !== undefined && def.containerName !== ''
        ? { container: def.containerName }
        : {}),
    });
  }
  return views;
}

export function findUsages(
  host: TsProjectHost,
  abs: string,
  offset: number,
  options: UsageOptions,
): UsagesView | undefined {
  const groups = host.service.findReferences(abs, offset);
  if (groups === undefined) return undefined;

  let definition: SymbolView | undefined;
  const usages: UsageView[] = [];
  const rollup = new Map<string, { id: string; kind: string; count: number; roles: Set<string> }>();
  let total = 0;
  let excluded = 0;

  for (const group of groups) {
    if (definition === undefined && !group.definition.fileName.includes('/node_modules/')) {
      const defFile = host.service.getProgram()?.getSourceFile(group.definition.fileName);
      if (defFile !== undefined) {
        const rel = host.relOf(group.definition.fileName);
        const span = spanFromRange(
          defFile,
          rel,
          group.definition.textSpan.start,
          group.definition.textSpan.start + group.definition.textSpan.length,
        );
        // `definition.name` from the LS is the full display string; the span text is
        // the identifier itself — use it when it is one.
        const name = /^[\w$]+$/.test(span.text) ? span.text : group.definition.name;
        definition = {
          id: mintSymbolId(name, rel, span.line, span.col),
          name,
          kind: group.definition.kind,
          span,
        };
      }
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
      // A role mismatch is outside the question, not an exclusion.
      if (options.role !== undefined && role !== options.role) continue;

      if (
        (options.pathExclude !== undefined && matchesAnyGlob(rel, options.pathExclude)) ||
        (options.pathInclude !== undefined && !matchesAnyGlob(rel, options.pathInclude))
      ) {
        excluded++;
        continue;
      }

      if (options.groupBy === 'enclosing') {
        const row = rollupRow(host, sourceFile, rel, ref.textSpan.start, options);
        if (row === undefined) {
          excluded++;
          continue;
        }
        total++;
        const existing = rollup.get(row.key);
        if (existing === undefined) {
          rollup.set(row.key, { id: row.id, kind: row.kind, count: 1, roles: new Set([role]) });
        } else {
          existing.count++;
          existing.roles.add(role);
        }
      } else {
        total++;
        if (usages.length >= options.limit) continue; // total keeps counting — no silent cap
        usages.push({
          span: spanFromRange(
            sourceFile,
            rel,
            ref.textSpan.start,
            ref.textSpan.start + ref.textSpan.length,
          ),
          role,
          confidence: 'certain',
        });
      }
    }
  }

  const base = { ...(definition !== undefined ? { definition } : {}), total, excluded };
  if (options.groupBy === 'enclosing') {
    const groupsOut = [...rollup.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, options.limit)
      .map((g) => ({ id: g.id, kind: g.kind, count: g.count, roles: [...g.roles].join(',') }));
    return { ...base, groups: groupsOut };
  }
  return { ...base, usages };
}

function rollupRow(
  host: TsProjectHost,
  sourceFile: ts.SourceFile,
  rel: RepoRelPath,
  position: number,
  options: UsageOptions,
): { key: string; id: string; kind: string } | undefined {
  const enc = findEncloser(sourceFile, position);
  const kind = enc?.kind ?? 'module';
  if (options.enclosingKind !== undefined && kind !== options.enclosingKind) return undefined;
  if (options.exportedOnly === true && enc !== undefined && !enc.exported) return undefined;
  if (enc === undefined) {
    return { key: `${rel}#<module>`, id: mintSymbolId(moduleName(rel), rel, 1, 1), kind };
  }
  const lc = sourceFile.getLineAndCharacterOfPosition(enc.start);
  return {
    key: `${rel}#${enc.name}#${enc.start}`,
    id: mintSymbolId(enc.name, rel, lc.line + 1, lc.character + 1),
    kind,
  };
}

function moduleName(rel: RepoRelPath): string {
  const base = rel.split('/').pop() ?? rel;
  return `(top-level ${base})`;
}

export function expandTypeAt(
  host: TsProjectHost,
  abs: string,
  offset: number,
): TypeView | undefined {
  const info = host.service.getQuickInfoAtPosition(abs, offset);
  if (info === undefined) return undefined;
  const sourceFile = host.service.getProgram()?.getSourceFile(abs);
  const rel = host.relOf(abs);
  const doc = (info.documentation ?? [])
    .map((d) => d.text)
    .join('\n')
    .trim();
  return {
    about:
      (info.displayParts ?? [])
        .map((p) => p.text)
        .join('')
        .split('\n')[0] ?? '',
    type: (info.displayParts ?? []).map((p) => p.text).join(''),
    ...(doc.length > 0 ? { doc } : {}),
    ...(sourceFile !== undefined
      ? {
          span: spanFromRange(
            sourceFile,
            rel,
            info.textSpan.start,
            info.textSpan.start + info.textSpan.length,
          ),
        }
      : {}),
  };
}

function navigateToView(host: TsProjectHost, item: ts.NavigateToItem): SymbolView | undefined {
  const sourceFile = host.service.getProgram()?.getSourceFile(item.fileName);
  if (sourceFile === undefined) return undefined;
  const rel = host.relOf(item.fileName);
  // navto's textSpan covers the whole declaration (`export function …`); anchor the
  // SymbolId and span on the NAME token instead — that's where quickInfo/references
  // resolve, and where the §6 same-symbol check (`text.startsWith(name, offset)`)
  // must look.
  const declText = sourceFile.text.slice(
    item.textSpan.start,
    item.textSpan.start + item.textSpan.length,
  );
  const nameIdx = declText.indexOf(item.name);
  const nameStart = nameIdx >= 0 ? item.textSpan.start + nameIdx : item.textSpan.start;
  const span = spanFromRange(sourceFile, rel, nameStart, nameStart + item.name.length);
  return {
    id: mintSymbolId(item.name, rel, span.line, span.col),
    name: item.name,
    kind: item.kind,
    span,
    ...(item.containerName !== '' ? { container: item.containerName } : {}),
  };
}
