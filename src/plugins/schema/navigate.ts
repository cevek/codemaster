// AST-navigation helpers over an openapi-typescript `schema.d.ts` (§4). The shape is
// declarative and regular, so the plugin reads it with the TS compiler's own parser
// (`ts.createSourceFile`, AST only — no checker, no `deps: ['ts']`): every fact is a
// node read off the syntax tree. Spans are minted HERE from real node ranges
// (`getStart`/`getEnd`) — never substring offsets — so the §16 invariant-1 proof-span
// check holds (the 1-based↔0-based `+1` is applied once, in `spanOfNode`).

import ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Span } from '../../core/span.ts';

/** The HTTP methods openapi-typescript emits as members of a path object. */
export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** Proof span over a node, built from its real source range (the i18n precedent). */
export function spanOfNode(node: ts.Node, sf: ts.SourceFile, rel: RepoRelPath): Span {
  const start = node.getStart(sf);
  const end = node.getEnd();
  const s = sf.getLineAndCharacterOfPosition(start);
  const e = sf.getLineAndCharacterOfPosition(end);
  return {
    file: rel,
    line: s.line + 1,
    col: s.character + 1,
    endLine: e.line + 1,
    endCol: e.character + 1,
    text: sf.text.slice(start, end),
  };
}

/** The string text of a property-signature name (`get`, `"/users/{id}"`, `200`). */
export function memberName(member: ts.TypeElement): string | undefined {
  const name = member.name;
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

/** A node that carries a member list — a `{ … }` type literal or an `interface { … }`. */
export type MembersHolder = { readonly members: readonly ts.TypeElement[] };

/** Find a property signature by name within a member-bearing node. */
export function member(lit: MembersHolder, name: string): ts.PropertySignature | undefined {
  for (const m of lit.members) {
    if (ts.isPropertySignature(m) && memberName(m) === name) return m;
  }
  return undefined;
}

/** A `never` keyword type (openapi-typescript writes absent slots as `?: never`). */
export function isNever(type: ts.TypeNode | undefined): boolean {
  return type !== undefined && type.kind === ts.SyntaxKind.NeverKeyword;
}

/** The type literal of a member, if its type is an inline object (`{ … }`). Internal: only
 *  `contentJsonType` needs it now (parse.ts distinguishes present-but-non-literal slots itself). */
function memberLiteral(lit: MembersHolder, name: string): ts.TypeLiteralNode | undefined {
  const m = member(lit, name);
  if (m?.type !== undefined && ts.isTypeLiteralNode(m.type)) return m.type;
  return undefined;
}

/** From a `{ headers; content: { "application/json": T } }` literal, return `T`'s node.
 *  A `content?: never` / no-content response yields `undefined` (a 204 etc. — honest
 *  absence, never a guessed body). */
export function contentJsonType(lit: ts.TypeLiteralNode): ts.TypeNode | undefined {
  const content = memberLiteral(lit, 'content');
  if (content === undefined) return undefined;
  // Prefer application/json; fall back to the first declared media type.
  const json = member(content, 'application/json');
  if (json?.type !== undefined) return json.type;
  const first = content.members.find(ts.isPropertySignature);
  return first?.type;
}

/** If `type` is `operations["OpId"]`, return `OpId`; otherwise `undefined`. */
export function operationRef(type: ts.TypeNode | undefined): string | undefined {
  if (type === undefined || !ts.isIndexedAccessTypeNode(type)) return undefined;
  const obj = type.objectType;
  if (!ts.isTypeReferenceNode(obj) || !ts.isIdentifier(obj.typeName)) return undefined;
  if (obj.typeName.text !== 'operations') return undefined;
  const index = type.indexType;
  if (ts.isLiteralTypeNode(index) && ts.isStringLiteral(index.literal)) return index.literal.text;
  return undefined;
}

/** Top-level `export interface <name> { … }` as a type-literal-like member list. */
export function findInterface(
  sf: ts.SourceFile,
  name: string,
): ts.InterfaceDeclaration | undefined {
  for (const stmt of sf.statements) {
    if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === name) return stmt;
  }
  return undefined;
}
