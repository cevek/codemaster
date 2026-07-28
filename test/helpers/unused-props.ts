// Shared oracle + fixture constants for the `find_unused_props` differential tests, split across
// two files to stay under the 300-line cap (§16). The oracle is an INDEPENDENT cold `ts.Program`
// (its own checker, its own AST walk), never the plugin's seams — that would be circular.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import type { OpResult } from '../../src/ops/contracts.ts';
import type { JsonValue } from '../../src/core/json.ts';

export const TSCONFIG = '{"compilerOptions":{"strict":true,"jsx":"react-jsx","module":"preserve"}}';
export const PKG = JSON.stringify({ dependencies: { react: '18' } });

/** Cold-Program oracle: a component's declared vs passed prop names, derived independently.
 *  `external` re-derives each declared prop's DECLARATION file from this program's own symbols
 *  (absolute `fileName`), which is the independent ground truth for the repo-declared narrowing —
 *  the plugin decides it from a `RepoRelPath` span through a different predicate.
 *  `order` is the checker's OWN member order — the ground truth the uncapped view must preserve. */
export function oracle(
  root: string,
  componentName: string,
): {
  declared: Set<string>;
  passed: Set<string>;
  unused: Set<string>;
  external: Set<string>;
  order: string[];
} {
  const cfgPath = path.join(root, 'tsconfig.json');
  const raw = ts.parseConfigFileTextToJson(cfgPath, readFileSync(cfgPath, 'utf8'));
  const parsed = ts.parseJsonConfigFileContent(raw.config as object, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();

  // Locate the component declaration + its symbol.
  let componentSymbol: ts.Symbol | undefined;
  let firstParam: ts.ParameterDeclaration | undefined;
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || sf.fileName.includes('/node_modules/')) continue;
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === componentName) {
        componentSymbol ??= checker.getSymbolAtLocation(n.name);
        const init = n.initializer;
        if (init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          firstParam ??= init.parameters[0];
        }
      }
      if (ts.isFunctionDeclaration(n) && n.name?.text === componentName) {
        componentSymbol ??= checker.getSymbolAtLocation(n.name);
        firstParam ??= n.parameters[0];
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(sf, visit);
  }

  const declared = new Set<string>();
  const external = new Set<string>();
  const order: string[] = [];
  if (firstParam !== undefined) {
    const type = checker.getApparentType(checker.getTypeAtLocation(firstParam));
    for (const prop of type.getProperties()) {
      declared.add(prop.getName());
      order.push(prop.getName());
      const declFile = prop.declarations?.[0]?.getSourceFile().fileName ?? '';
      const inRepo = declFile.startsWith(`${root}/`) && !declFile.includes('/node_modules/');
      if (!inRepo) external.add(prop.getName());
    }
  }

  const passed = new Set<string>();
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || sf.fileName.includes('/node_modules/')) continue;
    const visit = (n: ts.Node): void => {
      if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
        let sym = checker.getSymbolAtLocation(n.tagName);
        if (sym !== undefined && (sym.flags & ts.SymbolFlags.Alias) !== 0) {
          sym = checker.getAliasedSymbol(sym);
        }
        if (sym !== undefined && sym === componentSymbol) {
          for (const a of n.attributes.properties) {
            if (ts.isJsxAttribute(a) && ts.isIdentifier(a.name)) passed.add(a.name.text);
          }
          // Element CONTENT (`<C>body</C>`) passes `children` — independently re-derived here so
          // the oracle catches the children blind spot, not shares it.
          const parent = n.parent;
          if (
            ts.isJsxOpeningElement(n) &&
            ts.isJsxElement(parent) &&
            parent.children.some((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces))
          ) {
            passed.add('children');
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(sf, visit);
  }

  const unused = new Set([...declared].filter((d) => !passed.has(d)));
  return { declared, passed, unused, external, order };
}

export function data(r: OpResult): Record<string, JsonValue> {
  if ('error' in r) throw new Error(`dispatch error: ${r.error.message}`);
  assert.ok(r.result.ok, 'expected ok result');
  return r.result.data as Record<string, JsonValue>;
}

export const unusedNames = (d: Record<string, JsonValue>): Set<string> =>
  new Set((d['unused'] as { name: string }[]).map((u) => u.name));
