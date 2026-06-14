// §16 for the `schema` plugin, continued (spec-schema-plugin §2 "the contract"): the
// `$ref` / array shapes openapi-typescript emits for reusable responses, request bodies,
// and list responses. Split from schema.test.ts to keep each file under the 300-line cap.
// Oracle = hand-written expectations: a `$ref`'d response/body must be RESOLVED (never
// dropped — a §3.6 completeness lie), the lowest 2xx must win (never a wrong status under
// `certain`), and a `…["X"][]` list response must keep both its chain anchor and `[]`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, assertSpansValid } from '../helpers/project.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true}}';
const CONFIG =
  `import { defineConfig } from 'codemaster';\n` +
  `export default defineConfig({ schema: { entrypoint: 'src/api/openapi.d.ts' } });\n`;

const REF_SCHEMA = `export interface paths {
  "/things": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    get: operations["listThings"];
    post: operations["createThing"];
    put?: never; delete?: never; options?: never; head?: never; patch?: never; trace?: never;
  };
}
export interface operations {
  listThings: {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    requestBody?: never;
    responses: { 200: { headers: { [name: string]: unknown }; content: { "application/json": components["schemas"]["ThingDto"][] } } };
  };
  createThing: {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    requestBody: components["requestBodies"]["CreateThing"];
    responses: {
      200: components["responses"]["ThingList"];
      201: { headers: { [name: string]: unknown }; content: { "application/json": components["schemas"]["ThingDto"] } };
    };
  };
}
export interface components {
  schemas: { ThingDto: { id: number } };
  responses: { ThingList: { content: { "application/json": components["schemas"]["ThingDto"][] } } };
  requestBodies: { CreateThing: { content: { "application/json": components["schemas"]["ThingDto"] } } };
}
`;

type Card = {
  method: string;
  path: string;
  query?: { text: string };
  body?: { text: string; confidence: string };
  response?: { text: string; confidence: string };
  status?: number;
  confidence?: string;
  note?: string;
};

function cardsOf(res: unknown): Card[] {
  const r = res as { result?: { ok: boolean; data: { endpoints?: Card[] } } };
  assert.ok(r.result?.ok, 'op must succeed');
  return r.result.data.endpoints ?? [];
}

test('$ref responses/bodies are resolved (never dropped); lowest 2xx wins; array anchor kept', async () => {
  const p = await project({
    'codemaster.config.ts': CONFIG,
    'tsconfig.json': TSCONFIG,
    'src/api/openapi.d.ts': REF_SCHEMA,
  });
  try {
    const res = await p.op('list_endpoints', {});
    const by = new Map(cardsOf(res).map((c) => [`${c.method} ${c.path}`, c]));

    // Array response: anchored at the schema name, the `[]` shape preserved in text.
    const list = by.get('GET /things');
    assert.equal(list?.response?.text, 'ThingDto[]');
    assert.equal(list?.status, 200);

    // The $ref'd 200 must win over the inline 201 (no wrong-status proof), and the $ref'd
    // requestBody must be surfaced, not silently dropped.
    const create = by.get('POST /things');
    assert.equal(create?.status, 200, 'lowest 2xx selected even when it is a $ref');
    assert.equal(create?.response?.text, 'ThingList', '$ref response surfaced, not dropped');
    assert.equal(create?.body?.text, 'CreateThing', '$ref requestBody surfaced, not dropped');

    assertSpansValid(p.root, res as never);
  } finally {
    await p.dispose();
  }
});

// A response/body slot whose value is a union or a bare type alias DIRECTLY (non-standard
// generator output) must not be silently dropped — that reads as a no-content 204 and can
// hide a clean sibling. It is surfaced verbatim as a `partial` reference (§3.6).
const ODD_SCHEMA = `export interface paths {
  "/odd": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    post: operations["oddOp"];
    get?: never; put?: never; delete?: never; options?: never; head?: never; patch?: never; trace?: never;
  };
}
export interface operations {
  oddOp: {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    requestBody: BodyAlias;
    responses: {
      200: components["schemas"]["A"] | components["schemas"]["B"];
      201: { headers: { [name: string]: unknown }; content: { "application/json": components["schemas"]["Clean"] } };
    };
  };
}
export interface components { schemas: { A: { a: number }; B: { b: number }; Clean: { c: number } } }
`;

test('a union / bare-type slot is surfaced as a partial ref, never silently dropped', async () => {
  const p = await project({
    'codemaster.config.ts': CONFIG,
    'tsconfig.json': TSCONFIG,
    'src/api/openapi.d.ts': ODD_SCHEMA,
  });
  try {
    const res = await p.op('list_endpoints', {});
    const card = cardsOf(res).find((c) => c.path === '/odd');

    // The lowest 2xx (200) wins and is NOT dropped: surfaced as a partial ref, not a 204.
    assert.equal(card?.status, 200);
    assert.equal(card?.response?.confidence, 'partial', 'unreducible response is honest-partial');
    assert.match(card?.response?.text ?? '', /\bA\b.*\|\s.*\bB\b/, 'the whole union is shown');
    // A bare-type requestBody is likewise surfaced, partial, not dropped.
    assert.equal(card?.body?.text, 'BodyAlias');
    assert.equal(card?.body?.confidence, 'partial');

    assertSpansValid(p.root, res as never);
  } finally {
    await p.dispose();
  }
});

// A slot that is PRESENT but can't be reduced — a whole-`responses` or `parameters` `$ref`,
// or a `responses` with only `default`/range keys — must NOT yield a bare `certain` card with
// that slot silently missing (reads as "no response/query": the §3.4/§3.6 completeness lie).
// It demotes the card to `partial` + a note. (Review finding KS — schema plugin, 8207a55.)
const UNRESOLVED_SCHEMA = `export interface paths {
  "/ref-responses": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    get: operations["refResp"];
    put?: never; post?: never; delete?: never; options?: never; head?: never; patch?: never; trace?: never;
  };
  "/default-only": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    get: operations["defaultOnly"];
    put?: never; post?: never; delete?: never; options?: never; head?: never; patch?: never; trace?: never;
  };
  "/ref-params": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    get: operations["refParams"];
    put?: never; post?: never; delete?: never; options?: never; head?: never; patch?: never; trace?: never;
  };
}
export interface operations {
  refResp: {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    requestBody?: never;
    responses: components["responses"]["Wrapped"];
  };
  defaultOnly: {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    requestBody?: never;
    responses: { default: { headers: { [name: string]: unknown }; content: { "application/json": components["schemas"]["Err"] } } };
  };
  refParams: {
    parameters: components["parameters"]["Shared"];
    requestBody?: never;
    responses: { 200: { headers: { [name: string]: unknown }; content: { "application/json": components["schemas"]["Ok"] } } };
  };
}
export interface components {
  schemas: { Err: { e: number }; Ok: { o: number } };
  responses: { Wrapped: { content: { "application/json": components["schemas"]["Ok"] } } };
  parameters: { Shared: { query: { q?: string } } };
}
`;

test('a present-but-unresolvable slot demotes the card to partial + a note, never silent certain', async () => {
  const p = await project({
    'codemaster.config.ts': CONFIG,
    'tsconfig.json': TSCONFIG,
    'src/api/openapi.d.ts': UNRESOLVED_SCHEMA,
  });
  try {
    const res = await p.op('list_endpoints', {});
    const by = new Map(cardsOf(res).map((c) => [`${c.method} ${c.path}`, c]));

    // (1) whole-`responses` $ref — NOT "no response": partial + note, no fabricated status.
    const refResp = by.get('GET /ref-responses');
    assert.equal(refResp?.confidence, 'partial');
    assert.equal(refResp?.status, undefined, 'no status fabricated for an unenumerable responses');
    assert.match(refResp?.note ?? '', /responses is a \$ref/);

    // (2) responses present but only `default` (no 2xx) — partial, not certain-no-response.
    const def = by.get('GET /default-only');
    assert.equal(def?.confidence, 'partial');
    assert.equal(def?.status, undefined);
    assert.match(def?.note ?? '', /no 2xx status resolved/);

    // (3) parameters is a $ref — query unenumerable: partial + note, but the resolvable 200
    //     response IS still surfaced (a card can be partial on one slot while resolving another).
    const refParams = by.get('GET /ref-params');
    assert.equal(refParams?.confidence, 'partial');
    assert.match(refParams?.note ?? '', /parameters is a \$ref/);
    assert.equal(refParams?.status, 200, 'the resolvable response is still surfaced');
    assert.equal(
      refParams?.query,
      undefined,
      'the unenumerable query is absent (flagged in the note)',
    );

    assertSpansValid(p.root, res as never);
  } finally {
    await p.dispose();
  }
});
