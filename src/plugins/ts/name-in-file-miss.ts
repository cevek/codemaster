// The `name+file` miss message (t-406178) — split out of `resolve-target.ts` (300-line cap). When no
// TOP-LEVEL declaration of the name anchors, the file may still declare it below top level (a class
// method, an object-literal member, a nested function) or as a shape the top-level walk is blind to (a
// binding pattern, an import). Naming those turns the dead end into a pick-list.
//
// The candidates come from TS's own `getNamedDeclarations` index — the one `source {syntactic:true}`
// addresses by — plus object-literal property assignments, which that index omits. A candidate is printed as
// a pasteable `file:line:col` ONLY when go-to-definition at that position lands back on it: an
// object-literal member's name resolves through its contextual type (an interface signature elsewhere),
// an import or a destructured binding to its source, so pasting their position would print a
// different declaration than the one listed. Those are named by line only.

import ts from 'typescript';
import type { TsProjectHost } from './ls-host.ts';
import { nameWithMore } from '../../common/truncate/name-with-more.ts';
import { namedDeclarations, namedDeclarationsAvailable } from './syntactic-internal.ts';
import { isRealDeclaration, nameAnchor, nodeKindLabel } from './syntactic-nodes.ts';

const PREVIEW = 8;

type Candidate = { node: ts.Declaration; anchor: number };

function candidatesNamed(sf: ts.SourceFile, name: string): Candidate[] | undefined {
  if (!namedDeclarationsAvailable()) return undefined;
  let nodes: readonly ts.Declaration[];
  try {
    nodes = namedDeclarations(sf).get(name) ?? [];
  } catch {
    return undefined;
  }
  const seen = new Set<number>();
  const out: Candidate[] = [];
  const add = (node: ts.Declaration): void => {
    const anchor = nameAnchor(node, sf);
    if (seen.has(anchor)) return;
    seen.add(anchor);
    out.push({ node, anchor });
  };
  nodes.forEach(add);
  // TS's index leaves out object-literal property assignments (`load: async () => …`, `a: 1`) — the
  // commonest "method of an object literal" spelling. The syntactic index misses them too, so its
  // redirect cannot print them yet (t-857899).
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === name
    ) {
      add(node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return out.sort((a, b) => a.anchor - b.anchor);
}

/** Nearest named enclosing declaration — `Engine` for a method, `createHost` for a returned literal. */
function container(node: ts.Node): { name: string; member: boolean } | undefined {
  for (let up: ts.Node | undefined = node.parent; up !== undefined; up = up.parent) {
    if (ts.isSourceFile(up)) return undefined;
    const typeLike =
      ts.isClassLike(up) ||
      ts.isInterfaceDeclaration(up) ||
      ts.isTypeAliasDeclaration(up) ||
      ts.isEnumDeclaration(up);
    if (
      !typeLike &&
      !ts.isFunctionLike(up) &&
      !ts.isVariableDeclaration(up) &&
      !ts.isModuleDeclaration(up)
    ) {
      continue;
    }
    const n = ts.getNameOfDeclaration(up as ts.Declaration);
    if (n !== undefined && ts.isIdentifier(n)) return { name: n.text, member: typeLike };
  }
  return undefined;
}

function kindOf(node: ts.Declaration): string {
  if (ts.isBindingElement(node)) return 'destructured binding';
  if (ts.isPropertyAssignment(node)) return 'property';
  if (ts.isShorthandPropertyAssignment(node)) return 'shorthand property';
  if (!isRealDeclaration(node)) return ts.isExportSpecifier(node) ? 're-export' : 'import';
  return nodeKindLabel(node);
}

function label(node: ts.Declaration, name: string): string {
  const literal = ts.isObjectLiteralExpression(node.parent) ? ' in object literal' : '';
  const kind = `${kindOf(node)}${literal}`;
  const where = container(node);
  if (where === undefined) return `${name} (${kind})`;
  return where.member ? `${where.name}.${name} (${kind})` : `${name} (${kind}, in ${where.name})`;
}

/** Does go-to-definition at `anchor` yield THIS declaration first (what `source` prints)? An empty
 *  answer or a thrown LS call is "not shown to", never a guess — the candidate degrades to its line. */
function selfResolving(h: TsProjectHost, abs: string, anchor: number): boolean {
  try {
    const service = h.sourceFileAcross(abs)?.program.service ?? h.service;
    const first = service.getDefinitionAtPosition(abs, anchor)?.[0];
    return first !== undefined && first.fileName === abs && first.textSpan.start === anchor;
  } catch {
    return false;
  }
}

/** The message for a `name+file` lookup that anchored no top-level declaration. */
export function nameInFileMissMessage(
  h: TsProjectHost,
  sf: ts.SourceFile,
  abs: string,
  name: string,
  file: string,
): string {
  const head = `could not anchor a top-level declaration named '${name}' in ${file}`;
  const found = candidatesNamed(sf, name);
  if (found === undefined || found.length === 0) {
    return `${head} — check the name/file, or pass file:line:col. NOTE: this is NOT proof of absence — a destructured binding / namespace import-export / object-literal property is declared yet missed by THIS lookup. A bare '${name}' (no file) may find it, though it can land a same-named symbol elsewhere; to check without a name, address by position (file:line:col)`;
  }
  // One LS call per candidate, so only the shown preview is checked; the rest are counted. The count is
  // a FLOOR, not a total: the index collapses an overload set and omits plain parameters and computed
  // names, and no walk here adds them back.
  let byLine = false;
  let byPos = false;
  const labels = found.map((c, i) => {
    if (i >= PREVIEW) return '';
    const lc = sf.getLineAndCharacterOfPosition(c.anchor);
    if (selfResolving(h, abs, c.anchor)) {
      byPos = true;
      return `${label(c.node, name)} @${file}:${lc.line + 1}:${lc.character + 1}`;
    }
    byLine = true;
    return `${label(c.node, name)} at line ${lc.line + 1}`;
  });
  const lineOnly = byLine
    ? ' An entry given by line only is one go-to-definition at its name did not return (it resolves through a contextual type / import source, or to nothing), so a position there does not print it.'
    : '';
  const byPosition = byPos ? ' Address one by its @file:line:col.' : '';
  return `${head} — found ${found.length} '${name}' declared in this file below or beside what this top-level lookup anchors (a floor: overload signatures, plain parameters and computed names are not listed): ${nameWithMore(labels, PREVIEW)}.${byPosition}${lineOnly}`;
}
