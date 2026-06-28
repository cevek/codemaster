// Per-op MCP tool descriptors (§11). Two oracles, both structural:
//  1) Every builtin op generates a valid `inputSchema` (object, non-empty description) — so a
//     newly added op can't ship a broken or crashing tool (z.toJSONSchema degrade is wrapped).
//  2) The facade-blind-extract guard: NO op's canonical arg keys may collide with the reserved
//     request/flag keys, or the facade would silently route a real arg to a flag (the §3 lie the
//     plan's blind extraction relies on this test to prevent). Iterates `builtinOps()` so a future
//     op adding e.g. a `format` arg fails here until the collision is resolved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinOps } from '../../src/ops/builtins.ts';
import { canonicalKeys } from '../../src/ops/intake/shape-keys.ts';
import { buildOpToolDescriptor, OP_TOOL_RESERVED_KEYS } from '../../src/mcp/op-tools.ts';

test('every op generates a valid per-op tool descriptor', () => {
  for (const op of builtinOps()) {
    const d = buildOpToolDescriptor(op);
    assert.equal(d.name, op.name);
    assert.ok(d.description.length > 0, `op '${op.name}' has an empty description`);
    assert.equal(d.inputSchema.type, 'object', `op '${op.name}' inputSchema is not an object`);
    // The output-shape flags are always advertised; verbosity is on every op.
    const props = Object.keys(d.inputSchema.properties ?? {});
    assert.ok(props.includes('verbosity'), `op '${op.name}' is missing the verbosity flag`);
    if (op.mutating) {
      assert.ok(props.includes('apply'), `mutating op '${op.name}' is missing the apply flag`);
    }
    // sql sugar is advertised ONLY where there's a table (capability-honesty §3.6).
    assert.equal(
      props.includes('sql'),
      op.table !== undefined,
      `op '${op.name}' sql-flag advertisement must match table presence`,
    );
  }
});

test('every op argsSchema exposes a readable object shape — the collision guard is never blind', () => {
  // `canonicalKeys` reads `.shape` (through a `.refine` wrapper); a union / non-object schema has
  // NO `.shape`, so canonicalKeys returns EMPTY and the reserved-collision guard below silently
  // passes while `splitReserved` could still strip a colliding arg from the union's arms (§3
  // silent-input-loss). Fail LOUD here so a future union-shaped argsSchema is caught at the source,
  // not after a real arg is eaten. An arg-less `strictObject({})` has `.shape === {}` (readable) and
  // is fine; only an unreadable shape fails.
  for (const op of builtinOps()) {
    const hasShape = (op.argsSchema as { shape?: unknown }).shape !== undefined;
    assert.ok(
      hasShape,
      `op '${op.name}' argsSchema has no readable .shape (a union / non-object) — canonicalKeys() ` +
        `is blind to its keys, so the reserved-collision guard can't protect it. Use a (refined) ` +
        `strictObject so every arg key is enumerable.`,
    );
  }
});

test('no op arg OR intake-alias collides with a reserved request/flag key (facade-blind-extract guard)', () => {
  const reserved = new Set<string>(OP_TOOL_RESERVED_KEYS);
  for (const op of builtinOps()) {
    // `splitReserved` runs BEFORE intake, so an off-canonical alias/targetArray key an agent
    // passes is also subject to the blind extraction — it must not collide either, or the input
    // is silently stripped as a route key before intake sees it (the §3 input-lost lie). The
    // scalar→array coerced fields are schema fields (covered by `canonicalKeys`), not a separate
    // allowlist, so they need no extra entry here.
    const keys = new Set<string>([
      ...canonicalKeys(op.argsSchema),
      ...Object.keys(op.intake?.aliases ?? {}),
      ...(op.intake?.targetArray !== undefined ? [op.intake.targetArray] : []),
    ]);
    const collisions = [...keys].filter((k) => reserved.has(k));
    assert.deepEqual(
      collisions,
      [],
      `op '${op.name}' has arg/alias key(s) colliding with reserved keys ${collisions.join(',')} — ` +
        `the facade would route them to flags. Rename the key or revisit the reserved set.`,
    );
  }
});
