// The ADVERTISED contract, checked against what actually leaves the server (§11, t-029489/t-527994/
// t-568278/t-981812). The oracle is deliberately the REAL `tools/list` response read back through an
// MCP client — not `buildOpToolDescriptors` — because a schema defect fixed in the builder would
// otherwise be "verified" by the very code that produced it. The schema-vs-zod checks then run the
// op's OWN canonical `argsSchema` as the second, independent oracle: an advertised constraint that
// the gate does not enforce (or enforces differently) is the §11 drift this file exists to forbid.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { serveMcp } from '../../src/mcp/server.ts';
import { builtinOps } from '../../src/ops/builtins.ts';
import { project, type TestProject } from '../helpers/project.ts';

process.setMaxListeners(50);

const FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/a.ts': 'export const Alpha = 1;\n',
};

/** The §11 token budget, made structural: the tool-list is re-loaded into every agent's context
 *  every session, so its size is a deliberate, BOUNDED price — a silent creep past this ceiling is
 *  a decision nobody made. Raise it consciously (and say why) when a real capability needs it. */
const TOOLS_LIST_MAX_BYTES = 56_000;

async function wire(p: TestProject): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await serveMcp(p.orchestrator, 'test', { transport: serverT });
  const client = new Client({ name: 'test-client', version: '0' });
  await client.connect(clientT);
  return client;
}

type Json = Record<string, unknown>;

/** Every `$ref` string anywhere in the document, with the path it was found at (so a failure names
 *  the offending field instead of just "somewhere"). Recursive on purpose: the known dangling ref
 *  lives at `properties.steps.items.properties.args` — a top-level scan of `properties` reports
 *  green while `transaction` ships a broken schema. */
function collectRefs(node: unknown, at: string, out: { ref: string; at: string }[]): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectRefs(v, `${at}[${i}]`, out));
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === '$ref' && typeof v === 'string') out.push({ ref: v, at });
    else collectRefs(v, `${at}.${k}`, out);
  }
}

/** Resolve a `#/a/b` JSON pointer against the document root. Resolution — not a `$defs` key-name
 *  check — is what makes this robust to zod emitting `definitions` instead. */
function resolvePointer(root: Json, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let cur: unknown = root;
  for (const rawSeg of ref.slice(2).split('/')) {
    const seg = rawSeg.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Json)[seg];
    if (cur === undefined) return undefined;
  }
  return cur;
}

test('every advertised inputSchema is self-contained: no $ref escapes the document', async () => {
  const p = await project(FILES);
  try {
    const client = await wire(p);
    const { tools } = await client.listTools();
    assert.ok(tools.length > 30, 'the whole op catalogue is advertised');
    const withRefs: string[] = [];
    for (const tool of tools) {
      const schema = tool.inputSchema as unknown as Json;
      const refs: { ref: string; at: string }[] = [];
      collectRefs(schema, tool.name, refs);
      if (refs.length > 0) withRefs.push(tool.name);
      for (const { ref, at } of refs) {
        assert.notEqual(
          resolvePointer(schema, ref),
          undefined,
          `${at}: '${ref}' does not resolve inside ${tool.name}'s own inputSchema`,
        );
      }
      // The other direction: a definition nothing points at is dead weight in every session.
      const defs = schema['$defs'];
      if (defs !== undefined && defs !== null && typeof defs === 'object') {
        for (const key of Object.keys(defs)) {
          assert.ok(
            refs.some((r) => r.ref === `#/$defs/${key}`),
            `${tool.name}: $defs.${key} is advertised but never referenced`,
          );
        }
      }
    }
    // Discriminating: the two JsonValue-carrying ops MUST be among the ref-bearing schemas — if a
    // future zod inlines them, this test would otherwise pass vacuously on ref-free schemas.
    assert.deepEqual(withRefs.sort(), ['feedback', 'transaction']);
  } finally {
    await p.dispose();
  }
});

test('status {op} advertises the SAME schema object tools/list does', async () => {
  const p = await project(FILES);
  try {
    const client = await wire(p);
    const { tools } = await client.listTools();
    for (const name of ['find_usages', 'transaction', 'rename_symbol']) {
      const advertised = tools.find((t) => t.name === name)?.inputSchema;
      const r = (await client.callTool({
        name: 'status',
        arguments: { op: name, root: p.root },
      })) as CallToolResult;
      const first = r.content[0];
      const text = first !== undefined && first.type === 'text' ? first.text : '';
      const line = text
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('{"type":"object"'));
      assert.ok(line !== undefined, `status {op:"${name}"} prints the schema as parseable JSON`);
      assert.deepEqual(JSON.parse(line), advertised, `${name}: status schema == tools/list schema`);
    }
  } finally {
    await p.dispose();
  }
});

test('tools/list stays under the deliberate §11 token budget', async () => {
  const p = await project(FILES);
  try {
    const client = await wire(p);
    const { tools } = await client.listTools();
    const bytes = JSON.stringify(tools).length;
    assert.ok(
      bytes < TOOLS_LIST_MAX_BYTES,
      `tools/list is ${bytes} B — over the ${TOOLS_LIST_MAX_BYTES} B budget (${tools.length} tools)`,
    );
  } finally {
    await p.dispose();
  }
});

test('batch advertises the live op catalogue as an enum (a typo is caught at the boundary)', async () => {
  const p = await project(FILES);
  try {
    const client = await wire(p);
    const { tools } = await client.listTools();
    const batch = tools.find((t) => t.name === 'batch')?.inputSchema as unknown as Json;
    const requests = (batch['properties'] as Json)['requests'] as Json;
    assert.equal(requests['minItems'], 1, 'an empty batch is rejected by the schema too');
    const nameProp = ((requests['items'] as Json)['properties'] as Json)['name'] as Json;
    const names = nameProp['enum'] as unknown[];
    assert.ok(Array.isArray(names) && names.includes('find_usages'), 'op names are enumerated');
    assert.ok(!names.includes('find_usagez'), 'a typo is not a member');
    const advertisedOps = tools.filter((t) => t.name !== 'status' && t.name !== 'batch');
    assert.deepEqual(
      [...names].sort(),
      advertisedOps.map((t) => t.name).sort(),
      'the enum IS the advertised catalogue, not a second hand-maintained list',
    );
  } finally {
    await p.dispose();
  }
});

// ---- schema-vs-zod: the advertised `anyOf` must mean exactly what the gate enforces ----

const TARGET_VALUES: Record<string, unknown> = {
  symbolId: 'ts:Alpha@src/a.ts:v1',
  name: 'Alpha',
  file: 'src/a.ts',
  line: 1,
  col: 1,
  symbols: ['Alpha'],
  class: 'button',
  selector: '.button',
};

test('every advertised requiredOneOf branch is one the canonical zod gate ACCEPTS', () => {
  const ops = builtinOps().filter((o) => o.requiredOneOf !== undefined);
  assert.ok(ops.length >= 14, `the ts-target family declares one-of branches (got ${ops.length})`);
  for (const op of ops) {
    const branches = op.requiredOneOf ?? [];
    const example = (op.example?.args ?? {}) as Record<string, unknown>;
    assert.ok(
      Object.keys(example).length > 0,
      `${op.name}: needs a canonical example to build branch cases from`,
    );
    // Strip EVERY addressing key the example carries, not just this op's branch keys: a leftover
    // `line` from the example would satisfy a `file+line` branch and let a wrong declaration
    // (`['file']` alone) pass — the test would then not discriminate.
    const allBranchKeys = new Set(Object.keys(TARGET_VALUES));
    const base = Object.fromEntries(
      Object.entries(example).filter(([k]) => !allBranchKeys.has(k)),
    ) as Record<string, unknown>;
    for (const branch of branches) {
      const args = { ...base };
      for (const key of branch) {
        const value = TARGET_VALUES[key];
        assert.notEqual(value, undefined, `${op.name}: no sample value for branch key '${key}'`);
        args[key] = value;
      }
      const parsed = op.argsSchema.safeParse(args);
      // An advertised branch the gate rejects is WORSE than the permissiveness it replaced: the
      // harness would let the call through and the agent would be refused after trusting us.
      assert.ok(
        parsed.success,
        `${op.name}: advertised branch [${branch.join('+')}] is REJECTED by argsSchema — ${JSON.stringify(parsed.error?.issues?.[0])}`,
      );
    }
    // …and the converse: satisfying `required` while matching no branch must fail the gate, or the
    // anyOf is advertising a restriction nothing enforces.
    const noBranch = base;
    assert.equal(
      op.argsSchema.safeParse(noBranch).success,
      false,
      `${op.name}: args matching no advertised branch are ACCEPTED by argsSchema`,
    );
  }
});

test('the derived target predicate accepts/rejects exactly what the hand-written one did', async () => {
  const { requireTarget } = await import('../../src/ops/ts-target.ts');
  // Independent oracle: the pre-refactor predicate, transcribed verbatim. The derived form must be
  // behaviorally identical over the whole input lattice — including both-branches-set and the
  // col-without-line / file-without-line degenerates.
  const legacy = (t: Record<string, unknown>): boolean =>
    t['symbolId'] !== undefined ||
    t['name'] !== undefined ||
    (t['file'] !== undefined && t['line'] !== undefined);
  const keys = ['symbolId', 'name', 'file', 'line', 'col'] as const;
  const values: Record<string, unknown> = { ...TARGET_VALUES, col: 1 };
  for (let mask = 0; mask < 1 << keys.length; mask++) {
    const t: Record<string, unknown> = {};
    keys.forEach((k, i) => {
      if (mask & (1 << i)) t[k] = values[k];
    });
    assert.equal(
      requireTarget.predicate(t),
      legacy(t),
      `derived predicate diverges on ${JSON.stringify(t)}`,
    );
  }
});
