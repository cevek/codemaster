// Cross-tier observation (§5-L2): the TS plugin is the one that *sees* SCSS-module
// usage — `import s from './x.module.scss'` + `s.button` / `s['button']` — so it
// exposes that fact; the scss plugin asks for it, never the other way around.
// Syntactic scan over the LS's cached SourceFiles. A computed access (`s[expr]`) is
// flagged `dynamic`, never guessed (§3.3).

import ts from 'typescript';
import * as path from 'node:path';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Confidence, Span } from '../../core/span.ts';
import { spanFromRange } from './spans.ts';
import { extendShadow } from './scope-shadow.ts';
import type { TsProjectHost } from './ls-host.ts';

export type CssModuleAccess = {
  /** Class name as written, '' when dynamic. */
  className: string;
  span: Span;
  confidence: Confidence; // 'certain' literal access | 'dynamic' computed
};

export type CssModuleUsages = {
  /** scss module path (repo-relative) → accesses observed in TS files. */
  byModule: Map<RepoRelPath, CssModuleAccess[]>;
};

export function scanCssModuleUsages(host: TsProjectHost): CssModuleUsages {
  const byModule = new Map<RepoRelPath, CssModuleAccess[]>();
  const program = host.service.getProgram();
  if (program === undefined) return { byModule };

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.fileName.includes('/node_modules/')) continue;
    const rel = host.relOf(sourceFile.fileName);

    // import <binding> from '<specifier ending .scss>'
    const bindings = new Map<string, RepoRelPath>(); // local name → scss rel path
    for (const stmt of sourceFile.statements) {
      if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const spec = stmt.moduleSpecifier.text;
      if (!/\.(scss|sass|css)$/.test(spec)) continue;
      const name = stmt.importClause?.name?.text;
      if (name === undefined) continue;
      const resolved = resolveRelative(rel, spec);
      if (resolved !== undefined) bindings.set(name, resolved);
    }
    if (bindings.size === 0) continue;

    const record = (modulePath: RepoRelPath, access: CssModuleAccess): void => {
      const list = byModule.get(modulePath) ?? [];
      list.push(access);
      byModule.set(modulePath, list);
    };

    // Scope-aware: a function param / catch var that shadows an import binding name (e.g.
    // `useStore((s) => s.field)`, `rows.map((s) => s.foo)`) is NOT the css import, so its
    // `s.X` accesses must not be counted as class usage (§3). The shadow set is threaded down
    // the subtree, the binding-introduction logic shared with css-usage via scope-shadow.ts.
    const pool = new Set(bindings.keys());
    const accessible = (name: string, shadowed: ReadonlySet<string>): RepoRelPath | undefined =>
      shadowed.has(name) ? undefined : bindings.get(name);

    const visit = (node: ts.Node, shadowed: ReadonlySet<string>): void => {
      const next = extendShadow(node, pool, shadowed);
      // s.button
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const modulePath = accessible(node.expression.text, next);
        if (modulePath !== undefined) {
          record(modulePath, {
            className: node.name.text,
            span: spanFromRange(sourceFile, rel, node.getStart(sourceFile), node.getEnd()),
            confidence: 'certain',
          });
        }
      }
      // s['button'] / s[expr]
      if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const modulePath = accessible(node.expression.text, next);
        if (modulePath !== undefined) {
          const literal = ts.isStringLiteralLike(node.argumentExpression)
            ? node.argumentExpression.text
            : undefined;
          record(modulePath, {
            className: literal ?? '',
            span: spanFromRange(sourceFile, rel, node.getStart(sourceFile), node.getEnd()),
            confidence: literal !== undefined ? 'certain' : 'dynamic',
          });
        }
      }
      ts.forEachChild(node, (child) => {
        visit(child, next);
      });
    };
    visit(sourceFile, new Set());
  }
  return { byModule };
}

function resolveRelative(fromRel: RepoRelPath, spec: string): RepoRelPath | undefined {
  if (!spec.startsWith('.')) return undefined; // aliased scss imports: Phase 3 (module-resolve)
  const dir = path.posix.dirname(fromRel);
  return path.posix.normalize(path.posix.join(dir, spec)) as RepoRelPath;
}
