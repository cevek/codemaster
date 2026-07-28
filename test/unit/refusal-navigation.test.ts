// t-959904 — the invariant behind "refusals must be navigational": a refusal may not send the agent
// into another refusal. Asserted STRUCTURALLY, against the guard's real call-site set read off the
// source, rather than against sample refusal strings — a golden of the prose would re-bless the next
// regression, whereas this fails the moment someone adds a guard to an op the table recommends.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cheapCallsFor } from '../../src/ops/guard/navigate.ts';

const OPS_DIR = fileURLToPath(new URL('../../src/ops/', import.meta.url));

type OpFile = { op: string; guarded: boolean; conditional: boolean; passedOp?: string };

/** Read every op module once: its declared name, whether it calls the fan-out guard, whether that
 *  call is conditional on `isFanCapableTarget` (so a file-pinned target is NOT guarded), and the op
 *  name literal it hands the guard. */
function readOps(): OpFile[] {
  const out: OpFile[] = [];
  for (const file of readdirSync(OPS_DIR)) {
    if (!file.endsWith('.ts')) continue;
    const src = readFileSync(`${OPS_DIR}${file}`, 'utf8');
    const declared = /^ {2}name: '([a-z_]+)',$/m.exec(src);
    if (declared?.[1] === undefined) continue;
    const guarded = src.includes('semanticFanoutRefusal(');
    // Formatting-tolerant: prettier wraps the longer call sites across lines, and an oracle that
    // silently stopped matching on reformat would go quietly vacuous — the failure mode it exists
    // to prevent. Anchored on the `op:` literal inside a guard call, whitespace-insensitive.
    const passed = /semanticFanoutRefusal\([\s\S]*?\{\s*op:\s*'([a-z_]+)'/.exec(src);
    out.push({
      op: declared[1],
      guarded,
      conditional: src.includes('isFanCapableTarget('),
      ...(passed?.[1] !== undefined ? { passedOp: passed[1] } : {}),
    });
  }
  return out;
}

const OPS = readOps();
const GUARDED = new Set(OPS.filter((o) => o.guarded).map((o) => o.op));
const CONDITIONAL = new Set(OPS.filter((o) => o.guarded && o.conditional).map((o) => o.op));

// Sanity: the oracle is only meaningful if it actually found the call sites it reasons about.
test('the guarded-op set is discovered from source (oracle is not vacuously empty)', () => {
  assert.ok(
    GUARDED.size >= 10,
    `expected the fan-out guard's real call sites, got ${GUARDED.size}`,
  );
  assert.ok(GUARDED.has('find_usages') && GUARDED.has('impact'));
  assert.ok(CONDITIONAL.has('find_definition'), 'find_definition guards only fan-capable targets');
});

// A wrong literal at a call site would emit a redirect computed for a DIFFERENT question — the
// failure mode of threading an identifier through ~15 sites by hand.
test('every guard call site passes its own declared op name', () => {
  for (const o of OPS.filter((x) => x.guarded)) {
    assert.equal(o.passedOp, o.op, `${o.op} passes '${o.passedOp ?? '<none>'}' to the guard`);
  }
});

const opOf = (call: string) => /^([a-z_]+)\s/.exec(call.trim())?.[1] ?? '';

/** The one rule. A suggested call is legal only if running it cannot land in a guard:
 *   - an unguarded op is always fine;
 *   - `search_symbol` only with `syntactic:true` (the plain path has its own pre-warm size guard);
 *   - a CONDITIONALLY guarded op only with a `file:` pin, which is single-program-exact and never
 *     fans (`isFanCapableTarget`) — a bare-name form would be the exact round trip this forbids.
 */
function assertReachable(suggested: string, from: string) {
  const op = opOf(suggested);
  if (op === 'search_symbol') {
    assert.match(suggested, /syntactic:true/, `${from} → un-guarded search_symbol: ${suggested}`);
    return;
  }
  if (!GUARDED.has(op)) return;
  assert.ok(CONDITIONAL.has(op), `${from} → fully guarded op ${op}: ${suggested}`);
  assert.match(suggested, /\bfile:/, `${from} → fan-capable ${op} (no file pin): ${suggested}`);
}

const ARG_SHAPES = [
  { label: 'bare name', args: { name: 'Button' } },
  { label: 'name+file', args: { name: 'Button', file: 'src/Button.tsx' } },
  { label: 'query', args: { query: 'Button' } },
  { label: 'module', args: { module: 'src/Button.tsx' } },
  { label: 'symbolId only', args: { symbolId: 'ts:Button@src/Button.tsx:1:1~ab' } },
  { label: 'no args', args: {} },
];

test('no refusal redirects into another refusal — every guarded op, every arg shape', () => {
  for (const op of [...GUARDED, 'search_symbol']) {
    for (const shape of ARG_SHAPES) {
      for (const c of cheapCallsFor(op, shape.args).calls) {
        assertReachable(c.call, `${op} (${shape.label})`);
      }
    }
  }
});

// §3.6: with no substitute the orientation calls must not read as the answer — the message has to
// say the question itself is out of reach here, or the agent takes the near-miss for the real thing.
test('an op with no cheap equivalent reports substitute:false rather than a near-equivalent', () => {
  for (const op of ['impact', 'affected', 'importers_of', 'find_unused_exports']) {
    const { calls, substitute } = cheapCallsFor(op, { name: 'Button' });
    assert.equal(substitute, false, `${op} must not claim a substitute`);
    assert.ok(calls.length > 0, `${op} must still name what does work here`);
  }
});

// The redirect only helps if it can be pasted verbatim, which is why the ambiguity error prints
// copy-pasteable SymbolIds. A suggestion carrying no concrete subject is a hint, not a next call.
test('redirects interpolate the refused call subject verbatim', () => {
  for (const op of ['find_usages', 'find_definition', 'search_symbol']) {
    const calls = cheapCallsFor(op, { name: 'Butt"on' }).calls;
    assert.ok(calls.length > 0);
    for (const c of calls) {
      assert.match(c.call, /"Butt\\"on"/, `${op} must JSON-quote the subject: ${c.call}`);
    }
  }
});

// The partial must never be sold as the whole: the syntactic scan finds declarations and import
// sites, which is NOT the per-site usage set find_usages would have returned.
test('the find_usages redirect states what it does NOT give', () => {
  const [first] = cheapCallsFor('find_usages', { name: 'Button' }).calls;
  assert.ok(first !== undefined);
  assert.match(first.gives, /NOT the per-site usage set/);
});

// A subject-less call (module-addressed, or a bare symbolId whose payload is plugin-private and must
// not be parsed here) still has to hand back something runnable, not a placeholder-only string.
test('a subject-less refusal still yields a runnable call', () => {
  for (const args of [{ module: 'src/x.ts' }, {}]) {
    const { calls } = cheapCallsFor('importers_of', args);
    assert.deepEqual(
      calls.map((c) => c.call),
      ['symbols_overview {}'],
    );
  }
});
