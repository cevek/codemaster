// §16 invariants for the `schema` plugin (spec-schema-plugin §4-5). The oracle is a
// HAND-ENUMERATED set of expected endpoint cards (never a second reader sharing the
// plugin's parse logic — that would be circular). Spans are checked against the raw file
// (invariant 1); the "chains into expand_type" purpose (§1) is exercised end-to-end (a
// card's response span → expand_type resolves the schema's members); freshness honesty
// runs with the watcher silenced (invariant 2); op gating is proven through `status`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, assertSpansValid, type TestProject } from '../helpers/project.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true}}';
const CONFIG =
  `import { defineConfig } from 'codemaster';\n` +
  `export default defineConfig({ schema: { entrypoint: 'src/api/openapi.d.ts', generator: 'openapi-typescript' } });\n`;

// A faithful openapi-typescript `openapi.d.ts` (neutral names): the operations indirection,
// a path with params + a 201, a requestBody, a 204 no-content, `?: never` siblings, and a
// path whose method references a MISSING operation (the never-guess trap).
const SCHEMA = `export interface paths {
  "/users": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    get: operations["listUsers"];
    post: operations["createUser"];
    put?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/users/{id}": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    get: operations["getUser"];
    delete: operations["deleteUser"];
    put?: never;
    post?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/health": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    get: operations["healthCheck"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
export interface operations {
  listUsers: {
    parameters: { query: { page?: number; size?: number }; header?: never; path?: never; cookie?: never };
    requestBody?: never;
    responses: {
      200: { headers: { [name: string]: unknown }; content: { "application/json": components["schemas"]["UserPage"] } };
    };
  };
  createUser: {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    requestBody: { content: { "application/json": components["schemas"]["CreateUser"] } };
    responses: {
      201: { headers: { [name: string]: unknown }; content: { "application/json": components["schemas"]["UserDto"] } };
    };
  };
  getUser: {
    parameters: { query?: never; header?: never; path: { id: number }; cookie?: never };
    requestBody?: never;
    responses: {
      200: { headers: { [name: string]: unknown }; content: { "application/json": components["schemas"]["UserDto"] } };
    };
  };
  deleteUser: {
    parameters: { query?: never; header?: never; path: { id: number }; cookie?: never };
    requestBody?: never;
    responses: {
      204: { headers: { [name: string]: unknown }; content?: never };
    };
  };
}
export interface components {
  schemas: {
    UserDto: { id: number; name: string; email?: string };
    CreateUser: { name: string; email?: string };
    UserPage: { content: components["schemas"]["UserDto"][]; total: number };
  };
}
`;

function stdProject(): Promise<TestProject> {
  return project({
    'codemaster.config.ts': CONFIG,
    'tsconfig.json': TSCONFIG,
    'src/api/openapi.d.ts': SCHEMA,
  });
}

type Card = {
  method: string;
  path: string;
  pathParams: string[];
  query?: { text: string };
  body?: { text: string };
  response?: { text: string; span: { line: number; col: number } };
  status?: number;
  confidence: string;
  note?: string;
};

function cardsOf(res: unknown): Card[] {
  const r = res as { result?: { ok: boolean; data: { endpoints?: Card[] } } };
  assert.ok(r.result?.ok, 'op must succeed');
  return r.result.data.endpoints ?? [];
}

const key = (c: Card): string => `${c.method} ${c.path}`;

test('endpoint cards match the hand-enumerated oracle; spans valid', async () => {
  const p = await stdProject();
  try {
    const res = await p.op('list_endpoints', {});
    const cards = cardsOf(res);
    const by = new Map(cards.map((c) => [key(c), c]));

    // Independent oracle — what an openapi-typescript reader SHOULD produce, hand-written.
    assert.deepEqual(
      [...by.keys()].sort(),
      ['DELETE /users/{id}', 'GET /health', 'GET /users', 'GET /users/{id}', 'POST /users'],
      'every method×path that is not `?: never` becomes one card',
    );

    const listUsers = by.get('GET /users');
    assert.equal(listUsers?.confidence, 'certain');
    assert.deepEqual(listUsers?.pathParams, []);
    assert.equal(listUsers?.query?.text, '{ page?: number; size?: number }');
    assert.equal(listUsers?.body, undefined, 'GET has no request body');
    // The response ref anchors at the schema NAME (the chainable token), not the
    // `components["schemas"][…]` openapi-typescript wrapper.
    assert.equal(listUsers?.response?.text, 'UserPage');
    assert.equal(listUsers?.status, 200);

    const createUser = by.get('POST /users');
    assert.equal(createUser?.body?.text, 'CreateUser');
    assert.equal(createUser?.response?.text, 'UserDto');
    assert.equal(createUser?.status, 201, 'the 2xx is selected, not hardcoded 200');

    const getUser = by.get('GET /users/{id}');
    assert.deepEqual(getUser?.pathParams, ['id']);
    assert.equal(getUser?.response?.text, 'UserDto');

    const deleteUser = by.get('DELETE /users/{id}');
    assert.deepEqual(deleteUser?.pathParams, ['id']);
    // 204 no-content: the status IS reported (so it reads as "204 no body", not "no 2xx");
    // the response ref is absent — never a guessed body.
    assert.equal(deleteUser?.status, 204);
    assert.equal(deleteUser?.response, undefined, 'no-content → no response ref, no guess');
    assert.equal(deleteUser?.confidence, 'certain');

    // The never-guess trap: a method pointing at a missing operation is `unresolved`.
    const health = by.get('GET /health');
    assert.equal(health?.confidence, 'unresolved');
    assert.equal(health?.response, undefined, 'never a guessed card for an unresolved op');
    assert.match(health?.note ?? '', /healthCheck/);

    assertSpansValid(p.root, res as never);
  } finally {
    await p.dispose();
  }
});

// (The `$ref` / array-shape coverage lives in schema-refs.test.ts — split for the line cap.)

test('a card chains into expand_type: response span resolves the schema members (§1)', async () => {
  const p = await stdProject();
  try {
    const cards = cardsOf(
      await p.op('list_endpoints', { pathInclude: '/users/{id}', method: 'GET' }),
    );
    const getUser = cards.find((c) => c.method === 'GET');
    const span = getUser?.response?.span;
    assert.ok(span, 'GET /users/{id} carries a response span');

    const expanded = await p.op('expand_type', {
      file: 'src/api/openapi.d.ts',
      line: span.line,
      col: span.col,
    });
    const data = (expanded as { result: { ok: boolean; data: Record<string, unknown> } }).result;
    assert.ok(data.ok, 'expand_type at the response span resolves');
    const members = (data.data['members'] as { name: string }[] | undefined) ?? [];
    const names = members.map((m) => m.name).sort();
    assert.deepEqual(names, ['email', 'id', 'name'], 'UserDto members resolved through the chain');
  } finally {
    await p.dispose();
  }
});

test('list_endpoints joins the SQL post-filter: table columns + row projection (§11)', async () => {
  const p = await stdProject();
  try {
    // Anti-select via the declared TableSpec: the unresolved endpoint, by construction.
    const results = await p.request([{ name: 'list_endpoints', as: 't', args: {} }], {
      sql: "SELECT method, path, status FROM t WHERE confidence = 'unresolved'",
    });
    assert.equal(results.length, 1, 'default return:sql yields only the SQL result');
    const r = results[0];
    assert.ok(r !== undefined && 'result' in r && r.result.ok, 'sql batch succeeded');
    const data = r.result.data as { rows: unknown[][] };
    assert.deepEqual(
      data.rows,
      [['GET', '/health', null]],
      'projection: status null for an unresolved card',
    );

    // A path filter over the projected column proves the row projection is the op's data.
    const filtered = await p.request([{ name: 'list_endpoints', as: 't', args: {} }], {
      sql: "SELECT path FROM t WHERE path_params = 'id' ORDER BY method",
    });
    const fr = filtered[0];
    assert.ok(fr !== undefined && 'result' in fr && fr.result.ok);
    assert.deepEqual(
      (fr.result.data as { rows: unknown[][] }).rows,
      [['/users/{id}'], ['/users/{id}']],
      'path_params projected as a comma-joined string the SQL can match',
    );
  } finally {
    await p.dispose();
  }
});

test('freshness honesty (mutate · add), watcher silenced — read-time backstop', async () => {
  const p = await stdProject();
  try {
    const before = cardsOf(await p.op('list_endpoints', { pathInclude: '/orders' }));
    assert.equal(before.length, 0, 'no /orders endpoint initially');

    // Mutate the entrypoint silently (nullWatcher): add a path + its operation, each
    // inserted just inside its interface so the file stays well-formed TS.
    const withOrders = SCHEMA.replace(
      'export interface paths {',
      `export interface paths {\n` +
        `  "/orders": {\n` +
        `    parameters: { query?: never; header?: never; path?: never; cookie?: never };\n` +
        `    get: operations["listOrders"];\n` +
        `    put?: never; post?: never; delete?: never; options?: never; head?: never; patch?: never; trace?: never;\n` +
        `  };`,
    ).replace(
      'export interface operations {',
      `export interface operations {\n` +
        `  listOrders: {\n` +
        `    parameters: { query?: never; header?: never; path?: never; cookie?: never };\n` +
        `    requestBody?: never;\n` +
        `    responses: { 200: { headers: { [name: string]: unknown }; content: { "application/json": components["schemas"]["UserPage"] } } };\n` +
        `  };`,
    );
    p.write('src/api/openapi.d.ts', withOrders);
    const after = cardsOf(await p.op('list_endpoints', { pathInclude: '/orders' }));
    assert.deepEqual(
      after.map((c) => c.method),
      ['GET'],
      'mutated entrypoint reindexed on read',
    );
  } finally {
    await p.dispose();
  }
});

test('cold == warm after an entrypoint edit (invariant 3)', async () => {
  const finalSchema = SCHEMA.replace('"/health"', '"/healthz"');
  const warm = await stdProject();
  const cold = await project({
    'codemaster.config.ts': CONFIG,
    'tsconfig.json': TSCONFIG,
    'src/api/openapi.d.ts': finalSchema,
  });
  try {
    warm.write('src/api/openapi.d.ts', finalSchema);
    const w = cardsOf(await warm.op('list_endpoints', {}))
      .map(key)
      .sort();
    const c = cardsOf(await cold.op('list_endpoints', {}))
      .map(key)
      .sort();
    assert.deepEqual(w, c, 'warm-after-edit must equal a cold boot of the same state');
  } finally {
    await warm.dispose();
    await cold.dispose();
  }
});

test('parse-failure honesty: a broken entrypoint is reported, daemon stays up', async () => {
  const p = await project({
    'codemaster.config.ts': CONFIG,
    'tsconfig.json': TSCONFIG,
    // Not openapi-typescript shape: no `paths` interface → zero cards, never a guess.
    'src/api/openapi.d.ts': 'export const api = { get: () => 1 };\n',
  });
  try {
    const res = await p.op('list_endpoints', {});
    const r = (res as { result: { ok: boolean; data: { endpoints?: unknown[] } } }).result;
    assert.ok(r.ok, 'a foreign shape does not crash — it yields zero cards honestly');
    assert.deepEqual(r.data.endpoints, []);
  } finally {
    await p.dispose();
  }
});

test('op gated by plugin presence: status hides list_endpoints without config.schema, shows it with', async () => {
  const without = await project({ 'tsconfig.json': TSCONFIG, 'src/api/openapi.d.ts': SCHEMA });
  const withCfg = await stdProject();
  try {
    assert.doesNotMatch(await without.status(), /list_endpoints/, 'no config.schema → op hidden');
    assert.match(await withCfg.status(), /list_endpoints/, 'config.schema → op listed');
  } finally {
    await without.dispose();
    await withCfg.dispose();
  }
});
