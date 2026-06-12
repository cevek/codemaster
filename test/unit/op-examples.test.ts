// §1.1 anti-drift: the status cheat-sheet teaches agents the call shape, so a stale
// example is a lie that costs failed calls (a field agent burned ~4 on the old
// `batch([...])` guidance). The oracle is each schema itself — every op's `example.args`
// must validate against the op's own zod `argsSchema`, and every tool's `exampleCall`
// against the corresponding MCP tool schema. A drifted example becomes a failing test,
// permanently. Iterates `builtinOps()` so a newly added op can't skip the check.
//
// §1.2 also lives here: `badArgs` must append a valid example whose JSON parses back
// through the tool's schema — the error message alone enough to author the corrected call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinOps } from '../../src/ops/builtins.ts';
import {
  TOOL_DESCRIPTORS,
  batchToolSchema,
  exampleCallFor,
  opToolSchema,
  statusToolSchema,
} from '../../src/mcp/schema.ts';
import { badArgs } from '../../src/mcp/server.ts';

test('every op example validates against the op’s own argsSchema', () => {
  for (const op of builtinOps()) {
    if (op.example === undefined) continue;
    const parsed = op.argsSchema.safeParse(op.example.args);
    assert.ok(
      parsed.success,
      `op '${op.name}' example.args does not validate: ${parsed.success ? '' : parsed.error.message}`,
    );
  }
});

const TOOL_SCHEMAS = {
  op: opToolSchema,
  status: statusToolSchema,
  batch: batchToolSchema,
} as const;

test('every tool exampleCall validates against its MCP tool schema', () => {
  for (const descriptor of TOOL_DESCRIPTORS) {
    const schema = TOOL_SCHEMAS[descriptor.name as keyof typeof TOOL_SCHEMAS];
    assert.ok(schema !== undefined, `no schema mapped for tool '${descriptor.name}'`);
    const parsed = schema.safeParse(descriptor.exampleCall);
    assert.ok(
      parsed.success,
      `tool '${descriptor.name}' exampleCall does not validate: ${parsed.success ? '' : parsed.error.message}`,
    );
  }
});

test('badArgs appends a valid example that parses back through the tool schema (§1.2)', () => {
  // The batch case from the spec: a malformed call must come back with an example whose
  // JSON, lifted out of the message, validates against batchToolSchema.
  const result = badArgs('batch', 'requests: Required');
  const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
  assert.ok(result.isError === true);
  const marker = ' — valid: ';
  const at = text.indexOf(marker);
  assert.ok(at !== -1, `error carries no example: ${text}`);
  const example: unknown = JSON.parse(text.slice(at + marker.length));
  assert.deepEqual(example, exampleCallFor('batch'));
  assert.ok(
    batchToolSchema.safeParse(example).success,
    'the appended example must itself be a valid batch call',
  );
});
