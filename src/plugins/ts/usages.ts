// Reference-site discovery: semantic references from the live LS, classified by role and
// optionally rolled up to enclosing declarations. All results are proof-carrying spans
// built in ./spans.ts from the same SourceFiles the LS answered from. Semantic answers
// come from the live LS — the only oracle (§3.1).

import type ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Confidence } from '../../core/span.ts';
import { matchesAnyGlob } from '../../common/glob/match.ts';
import { spanFromRange } from './spans.ts';
import { mintSymbolId, moduleName } from './symbol-id.ts';
import { classifyRole, findEncloser } from './usage-roles.ts';
import type { SymbolView, UsageView, UsageOptions, UsagesView } from './query-types.ts';
import type { TsProjectHost } from './ls-host.ts';

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
          rollup.set(row.key, {
            id: row.id,
            name: row.name,
            file: rel,
            line: row.line,
            col: row.col,
            kind: row.kind,
            count: 1,
            roles: new Set([role]),
            exported: row.exported,
          });
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
    return { ...base, groups: groupsOut, groupTotal: rollup.size };
  }
  return { ...base, usages };
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
