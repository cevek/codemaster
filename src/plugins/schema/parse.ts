// Parse one openapi-typescript `schema.d.ts` into endpoint cards (§1), each proof-carrying
// (§3.2). The reader is the TS compiler's own parser over the AST — no checker — so it
// stays self-contained (no `deps: ['ts']`): the card surfaces each type as a verbatim
// REFERENCE (text + span, e.g. `components["schemas"]["UserDto"]`), and resolving that
// reference into members is deferred to `expand_type` at the span (the chain in §1).
//
// Target generator: `openapi-typescript` (the `interface paths` / `interface operations`
// shape — backoffice's `openapi.d.ts`). Orval-style runtime clients (amiro's
// `export const api = {…}`) are a stated follow-up (`generator: 'custom'`), NOT read here —
// an absent/foreign shape yields zero cards honestly, never a guess (§3.4, spec §2).

import ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Confidence, Span } from '../../core/span.ts';
import {
  HTTP_METHODS,
  contentJsonType,
  findInterface,
  isNever,
  member,
  memberName,
  operationRef,
  spanOfNode,
} from './navigate.ts';

/** A reference to a type the schema names — `text` is the schema/type name (the chainable
 *  token), `span` anchors at it so `expand_type` there resolves its members (§1). Embedded
 *  in `EndpointCard`; not a standalone public export. */
type TypeRef = { text: string; span: Span; confidence: Confidence };

/** One endpoint: method · path · path-params · query · body · response (§1). Each type is
 *  a proof-carrying `TypeRef`; an unresolvable operation is `unresolved`, never guessed. */
export type EndpointCard = {
  /** Uppercase HTTP verb, e.g. `GET`. (The proof `span.text` stays the verbatim `get`.) */
  method: string;
  path: string;
  pathParams: string[];
  query?: TypeRef;
  body?: TypeRef;
  response?: TypeRef;
  /** The selected response status (lowest 2xx), e.g. 200. */
  status?: number;
  /** Anchor span: the method keyword in the `paths` interface. */
  span: Span;
  confidence: Confidence;
  /** Set when the operation reference could not be resolved (§3.6). */
  note?: string;
};

export type ParseOutcome = { ok: true; cards: EndpointCard[] } | { ok: false; message: string };

const PATH_PARAM = /\{([^}]+)\}/g;

export function parseEndpoints(rel: RepoRelPath, source: string): ParseOutcome {
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  } catch (thrown) {
    return { ok: false, message: thrown instanceof Error ? thrown.message : String(thrown) };
  }

  const paths = findInterface(sf, 'paths');
  if (paths === undefined) return { ok: true, cards: [] };
  const operations = indexOperations(findInterface(sf, 'operations'));

  const cards: EndpointCard[] = [];
  for (const pathProp of paths.members) {
    if (!ts.isPropertySignature(pathProp)) continue;
    const path = memberName(pathProp);
    if (path === undefined || pathProp.type === undefined || !ts.isTypeLiteralNode(pathProp.type)) {
      continue;
    }
    const pathParams = paramsOf(path);
    for (const methodProp of pathProp.type.members) {
      if (!ts.isPropertySignature(methodProp)) continue;
      const method = memberName(methodProp);
      if (method === undefined || !HTTP_METHODS.includes(method)) continue;
      if (isNever(methodProp.type)) continue; // `put?: never` — slot not implemented.
      cards.push(buildCard(method, path, pathParams, methodProp, operations, sf, rel));
    }
  }
  return { ok: true, cards };
}

function paramsOf(path: string): string[] {
  const out: string[] = [];
  for (const m of path.matchAll(PATH_PARAM)) if (m[1] !== undefined) out.push(m[1]);
  return out;
}

function indexOperations(
  decl: ts.InterfaceDeclaration | undefined,
): Map<string, ts.TypeLiteralNode> {
  const map = new Map<string, ts.TypeLiteralNode>();
  if (decl === undefined) return map;
  for (const m of decl.members) {
    if (!ts.isPropertySignature(m)) continue;
    const name = memberName(m);
    if (name !== undefined && m.type !== undefined && ts.isTypeLiteralNode(m.type)) {
      map.set(name, m.type);
    }
  }
  return map;
}

function buildCard(
  method: string,
  path: string,
  pathParams: string[],
  methodProp: ts.PropertySignature,
  operations: Map<string, ts.TypeLiteralNode>,
  sf: ts.SourceFile,
  rel: RepoRelPath,
): EndpointCard {
  const base = {
    method: method.toUpperCase(),
    path,
    pathParams,
    span: spanOfNode(methodProp.name, sf, rel),
  };

  // The operation type is either `operations["OpId"]` (the common indirection) or an
  // inline object literal. An indirection whose target is missing → `unresolved` (§3.6).
  const op = resolveOperation(methodProp.type, operations);
  if (op === undefined) {
    const refName = operationRef(methodProp.type);
    return {
      ...base,
      confidence: 'unresolved',
      note:
        refName !== undefined
          ? `operation "${refName}" not found in the operations interface`
          : 'endpoint type is neither operations["…"] nor an inline object',
    };
  }

  // A slot that is PRESENT but can't be reduced to a concrete shape (a `$ref`/alias
  // `responses`/`parameters`, or a `default`/range-only response) must NOT yield a bare
  // `certain` card with that slot silently missing — that reads as "no response/query" and is
  // the §3.4/§3.6 completeness lie. Such a slot demotes the card to `partial` + a note.
  const query = queryRef(op, sf, rel);
  const body = bodyRef(op, sf, rel);
  const resp = responseRef(op, sf, rel);
  const notes: string[] = [];
  if (query !== undefined && 'unresolved' in query) notes.push(`query: ${query.unresolved}`);
  if (resp !== undefined && 'unresolved' in resp) notes.push(`response: ${resp.unresolved}`);
  const queryRefVal = query !== undefined && 'ref' in query ? query.ref : undefined;
  const respVal = resp !== undefined && 'status' in resp ? resp : undefined;
  return {
    ...base,
    confidence: notes.length > 0 ? 'partial' : 'certain',
    ...(queryRefVal !== undefined ? { query: queryRefVal } : {}),
    ...(body !== undefined ? { body } : {}),
    // The selected 2xx status is reported even when it carries no body (a 204) — so a
    // no-content response is `{ status: 204 }`, distinct from "no 2xx at all" (no status).
    ...(respVal !== undefined
      ? { status: respVal.status, ...(respVal.ref !== undefined ? { response: respVal.ref } : {}) }
      : {}),
    ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
  };
}

function resolveOperation(
  type: ts.TypeNode | undefined,
  operations: Map<string, ts.TypeLiteralNode>,
): ts.TypeLiteralNode | undefined {
  const refName = operationRef(type);
  if (refName !== undefined) return operations.get(refName);
  if (type !== undefined && ts.isTypeLiteralNode(type)) return type;
  return undefined;
}

// The proof span anchors at the schema-name token, NOT the whole `components["schemas"]
// ["UserDto"]` indexed access: `expand_type` at a span's start position resolves the node
// under the cursor, and only the innermost index literal resolves to the schema's members
// (the §1 chain) — the leftmost `components` would resolve the container interface. An
// array (or parenthesized) wrapper is peeled so a `…["X"][]` list response still anchors
// at `X` (`text` keeps the `[]` so the list shape is not lost). A non-indexed (inline)
// type is its own proof + a usable chain anchor.
function refOf(type: ts.TypeNode, sf: ts.SourceFile, rel: RepoRelPath): TypeRef {
  const { node, suffix } = peelWrappers(type);
  if (
    ts.isIndexedAccessTypeNode(node) &&
    ts.isLiteralTypeNode(node.indexType) &&
    ts.isStringLiteral(node.indexType.literal)
  ) {
    const literal = node.indexType.literal;
    return {
      text: `${literal.text}${suffix}`,
      span: spanOfNode(literal, sf, rel),
      confidence: 'certain',
    };
  }
  return { text: type.getText(sf), span: spanOfNode(type, sf, rel), confidence: 'certain' };
}

function peelWrappers(type: ts.TypeNode): { node: ts.TypeNode; suffix: string } {
  if (ts.isArrayTypeNode(type)) {
    const inner = peelWrappers(type.elementType);
    return { node: inner.node, suffix: `${inner.suffix}[]` };
  }
  if (ts.isParenthesizedTypeNode(type)) return peelWrappers(type.type);
  return { node: type, suffix: '' };
}

// A `requestBody` / response slot's content type — inline `{ content: { "application/json":
// T } }` OR a `$ref` indexed access (`components["responses"]["Created"]`). `undefined` is
// returned ONLY for a genuine inline no-content slot (a 204 / `content?: never`); anything
// else resolvable is surfaced, never dropped (the §3.6 honesty line — a body that read as a
// silent no-content 204, and could hide a clean sibling, is a completeness lie).
function contentRef(type: ts.TypeNode, sf: ts.SourceFile, rel: RepoRelPath): TypeRef | undefined {
  if (ts.isTypeLiteralNode(type)) {
    const json = contentJsonType(type);
    return json !== undefined ? refOf(json, sf, rel) : undefined; // inline; undefined ⇒ 204.
  }
  if (ts.isIndexedAccessTypeNode(type)) return refOf(type, sf, rel);
  // A slot that is neither an inline `{ content }` literal nor a `$ref` (a union, a bare
  // type alias — non-standard generator output): surface the whole type verbatim as a
  // PARTIAL reference, never a silent drop. The proof span is valid; `partial` says "found
  // a type here, couldn't reduce it to one schema name".
  return { text: type.getText(sf), span: spanOfNode(type, sf, rel), confidence: 'partial' };
}

function queryRef(
  op: ts.TypeLiteralNode,
  sf: ts.SourceFile,
  rel: RepoRelPath,
): { ref: TypeRef } | { unresolved: string } | undefined {
  const params = member(op, 'parameters');
  if (params?.type === undefined || isNever(params.type)) return undefined; // no parameters slot
  if (!ts.isTypeLiteralNode(params.type)) {
    // `parameters: components["parameters"]["X"]` / a bare alias — present, not enumerable.
    return {
      unresolved: 'parameters is a $ref/alias — query not enumerable (expand_type at the span)',
    };
  }
  const query = member(params.type, 'query');
  if (query?.type === undefined || isNever(query.type)) return undefined; // no query
  return { ref: refOf(query.type, sf, rel) };
}

function bodyRef(op: ts.TypeLiteralNode, sf: ts.SourceFile, rel: RepoRelPath): TypeRef | undefined {
  const body = member(op, 'requestBody');
  if (body?.type === undefined || isNever(body.type)) return undefined;
  return contentRef(body.type, sf, rel);
}

function responseRef(
  op: ts.TypeLiteralNode,
  sf: ts.SourceFile,
  rel: RepoRelPath,
): { status: number; ref?: TypeRef } | { unresolved: string } | undefined {
  const responses = member(op, 'responses');
  if (responses?.type === undefined || isNever(responses.type)) return undefined; // no responses
  if (!ts.isTypeLiteralNode(responses.type)) {
    // `responses: components["responses"]["X"]` / a bare alias — present, not enumerable, so we
    // can't pick a 2xx. Don't pretend there's no response; surface it as partial.
    return {
      unresolved: 'responses is a $ref/alias — statuses not enumerable (expand_type at the span)',
    };
  }
  // Pick the lowest 2xx status across ALL response members (inline OR `$ref`), so a `$ref`
  // 200 is never skipped in favour of a higher inline 201 — that would report a wrong
  // status under `certain`. A no-content (204) yields a status with no body ref.
  let best: { status: number; type: ts.TypeNode } | undefined;
  let sawMember = false;
  for (const m of responses.type.members) {
    if (!ts.isPropertySignature(m) || m.type === undefined) continue;
    sawMember = true;
    const code = Number(memberName(m));
    if (!Number.isInteger(code) || code < 200 || code > 299) continue;
    if (best === undefined || code < best.status) best = { status: code, type: m.type };
  }
  if (best !== undefined) {
    const ref = contentRef(best.type, sf, rel);
    return ref !== undefined ? { status: best.status, ref } : { status: best.status };
  }
  // Responses declared but no 2xx integer status resolved — e.g. only `default` / a `2XX` range
  // (`Number(...)` is NaN) or only non-2xx codes. Don't report a `certain` card with a silently
  // missing response; say so (partial). An empty `{}` is genuinely no response.
  return sawMember
    ? {
        unresolved:
          'responses declared but no 2xx status resolved (`default` / range / non-2xx keys)',
      }
    : undefined;
}
