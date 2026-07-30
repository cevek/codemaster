// t-959904 — the invariant behind "refusals must be navigational": a refusal may not send the agent
// into another refusal. Asserted STRUCTURALLY, against the guard's real call-site set read off the
// source, rather than against sample refusal strings — a golden of the prose would re-bless the next
// regression, whereas this fails the moment someone adds a guard to an op the table recommends.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cheapCallsFor, navigationFor } from '../../src/ops/guard/navigate.ts';

const OPS_DIR = fileURLToPath(new URL('../../src/ops/', import.meta.url));

type OpFile = { op: string; guarded: boolean; conditional: boolean };

/** Read every op module once: its declared name, whether it calls the fan-out guard, and whether
 *  that call is conditional on `isFanCapableTarget` (so a file-pinned target is NOT guarded).
 *
 *  It no longer reads the op-name literal each site hands the guard, because there is none: the
 *  refusing op comes from `ctx.opName`, stamped by the dispatcher off the `OpDefinition` it ran
 *  (t-166631). A site carrying a neighbour's name is a shape the types no longer admit, so an
 *  oracle for it would be checking that a non-existent parameter is filled correctly. */
function readOps(): OpFile[] {
  const out: OpFile[] = [];
  for (const file of readdirSync(OPS_DIR)) {
    if (!file.endsWith('.ts')) continue;
    const src = readFileSync(`${OPS_DIR}${file}`, 'utf8');
    const declared = /^ {2}name: '([a-z0-9_]+)',$/m.exec(src);
    if (declared?.[1] === undefined) continue;
    out.push({
      op: declared[1],
      guarded: src.includes('semanticFanoutRefusal('),
      conditional: src.includes('isFanCapableTarget('),
    });
  }
  return out;
}

const OPS = readOps();
const GUARDED = new Set(OPS.filter((o) => o.guarded).map((o) => o.op));
const CONDITIONAL = new Set(OPS.filter((o) => o.guarded && o.conditional).map((o) => o.op));

/** The table's keys, read off its source rather than exported: `BY_OP` is an implementation detail
 *  and widening the module's API just to test it would be the tail wagging the dog. */
const BY_OP_KEYS = (() => {
  const src = readFileSync(
    fileURLToPath(new URL('../../src/ops/guard/navigate.ts', import.meta.url)),
    'utf8',
  );
  const body = /const BY_OP[\s\S]*?\[([\s\S]*?)\n\]\);/.exec(src)?.[1] ?? '';
  return [...body.matchAll(/\[\s*'([a-z0-9_]+)',/g)].map((m) => m[1] ?? '');
})();

// Sanity: the oracle is only meaningful if it actually found the call sites it reasons about.
test('the guarded-op set is discovered from source (oracle is not vacuously empty)', () => {
  assert.ok(
    GUARDED.size >= 10,
    `expected the fan-out guard's real call sites, got ${GUARDED.size}`,
  );
  assert.ok(GUARDED.has('find_usages') && GUARDED.has('impact'));
  assert.ok(CONDITIONAL.has('find_definition'), 'find_definition guards only fan-capable targets');
});

const opOf = (call: string) => /^([a-z0-9_]+)\s/.exec(call.trim())?.[1] ?? '';

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

// EVERY op, not just the guarded ones: `daemon/process-host`'s failAll renders a redirect for
// whatever op names a batch carried, so `rename_symbol` / `codemod` / `source` reach the table too.
test('no refusal redirects into another refusal — every op, every arg shape', () => {
  const everyOp = [...new Set([...OPS.map((o) => o.op), ...GUARDED, 'search_symbol'])];
  assert.ok(everyOp.length > GUARDED.size, 'the sweep must reach unguarded ops as well');
  for (const op of everyOp) {
    for (const shape of ARG_SHAPES) {
      for (const c of cheapCallsFor(op, shape.args, 'this-call').calls) {
        assertReachable(c.call, `${op} (${shape.label})`);
      }
    }
  }
});

// A renamed or deleted op would leave a stale BY_OP key: tsc cannot see it (the keys are strings),
// and the sweep above cannot either — a missing entry falls into the legal fallback arm. So the
// table's own keys are checked against the real op catalogue.
test('every BY_OP key names a real op (a stale key would silently degrade to the fallback)', () => {
  // Anchored on a key that must exist, not just a count: a regex that silently stopped matching
  // would otherwise pass this test by reading zero stale keys.
  assert.ok(BY_OP_KEYS.includes('find_usages'), `oracle misread BY_OP: ${BY_OP_KEYS.join(',')}`);
  assert.ok(BY_OP_KEYS.length >= 5, `oracle read too few BY_OP keys (${BY_OP_KEYS.length})`);
  const real = new Set(OPS.map((o) => o.op));
  for (const op of BY_OP_KEYS) {
    assert.ok(real.has(op), `BY_OP has '${op}', which is not a declared op`);
  }
});

// §3.6: with no substitute the orientation calls must not read as the answer — the message has to
// say the question itself is out of reach here, or the agent takes the near-miss for the real thing.
test('an op with no cheap equivalent reports substitute:false rather than a near-equivalent', () => {
  for (const op of ['impact', 'affected', 'importers_of', 'find_unused_exports']) {
    const { calls, substitute } = cheapCallsFor(op, { name: 'Button' }, 'this-call');
    assert.equal(substitute, false, `${op} must not claim a substitute`);
    assert.ok(calls.length > 0, `${op} must still name what does work here`);
  }
});

// The redirect only helps if it can be pasted verbatim, which is why the ambiguity error prints
// copy-pasteable SymbolIds. A suggestion carrying no concrete subject is a hint, not a next call.
test('redirects interpolate the refused call subject verbatim', () => {
  for (const op of ['find_usages', 'find_definition', 'search_symbol']) {
    const calls = cheapCallsFor(op, { name: 'Butt"on' }, 'this-call').calls;
    assert.ok(calls.length > 0);
    for (const c of calls) {
      assert.match(c.call, /"Butt\\"on"/, `${op} must JSON-quote the subject: ${c.call}`);
    }
  }
});

// `daemon/process-host` renders redirects ABOVE the child that runs §7 intake, so it hands the table
// raw wire args. Two shapes must survive that: an off-canonical spelling must still yield a subject,
// and a `name` that is really a position must NOT be pasted into a name-matching query — a redirect
// that quietly finds nothing is worse than one that admits it has no subject.
test('raw pre-intake args: alias keeps the subject, a path-shaped name never becomes a query', () => {
  const aliased = cheapCallsFor('find_usages', { symbol: 'Button' }, 'this-call');
  assert.equal(aliased.substitute, true, '`symbol` is the §7 alias of `name`');
  assert.ok(aliased.calls[0]?.call.includes('"Button"'), 'subject survives the alias');

  for (const posed of ['src/x.ts:10:3', 'src/x.ts:10']) {
    for (const c of cheapCallsFor('find_usages', { name: posed }, 'this-call').calls) {
      assert.doesNotMatch(c.call, /query:"src/, `a position leaked into a name query: ${c.call}`);
    }
  }

  // An implausibly long "name" is dropped rather than elided: a call cut with `…` reads as runnable
  // and is not.
  for (const c of cheapCallsFor('find_usages', { name: 'x'.repeat(500) }, 'this-call').calls) {
    assert.doesNotMatch(c.call, /…/, `emitted an un-runnable elided call: ${c.call}`);
  }
});

// `process-host` fails a whole batch BEFORE any op name is validated (`mcp/schema.ts` only checks
// `name` is a non-empty string), so the table is reached with arbitrary strings. On a plain object
// `toString` / `__proto__` resolve to inherited members — a throw here would replace an honest
// `oom`/`timeout` verdict, for every request in the batch, with an internal stack trace.
test('a non-own op name yields a redirect, never a throw', () => {
  for (const op of ['toString', '__proto__', 'constructor', 'hasOwnProperty', 'find_usage']) {
    const line = navigationFor(op, { name: 'Button' }, 'this-call');
    assert.match(
      line,
      /symbols_overview|search_symbol/,
      `${op} must still name something runnable`,
    );
    for (const c of cheapCallsFor(op, { name: 'Button' }, 'this-call').calls)
      assertReachable(c.call, op);
  }
});

// A conditionally guarded op refuses over its ADDRESSING, not its question, so the honest redirect
// is the same op re-pinned — carrying the caller's own args, or the promise "paste this" is false.
test('a trace re-pins itself and keeps its own args, rather than borrowing find_definition', () => {
  const pinned = cheapCallsFor(
    'trace_prop_through_tree',
    {
      name: 'App',
      prop: 'userId',
      file: 'src/App.tsx',
    },
    'this-call',
  );
  assert.equal(pinned.substitute, true);
  const [call] = pinned.calls;
  assert.ok(call !== undefined);
  assert.match(call.call, /^trace_prop_through_tree \{/, 'must re-pin itself, not another op');
  assert.match(call.call, /prop:"userId"/, "the caller's own args must survive");
  assert.match(call.call, /file:"src\/App\.tsx"/);

  // Without a file there is nothing to pin yet: locate first, then re-address — and it must still
  // never present "where is App declared" as an answer to "where does userId flow".
  const unpinned = cheapCallsFor(
    'trace_prop_through_tree',
    { name: 'App', prop: 'userId' },
    'this-call',
  );
  for (const c of unpinned.calls) assertReachable(c.call, 'trace_prop_through_tree (unpinned)');
  assert.ok(
    unpinned.calls.some((c) => c.call.startsWith('trace_prop_through_tree ')),
    'the two-step must end at the op the caller actually asked for',
  );
  assert.ok(
    !unpinned.calls.some((c) => c.call.startsWith('find_definition ')),
    'must not offer a definition lookup as a substitute for a trace',
  );
});

// Subjects live under different keys per op; reading only `name`/`query` silently dropped one that
// was sitting in the args.
test('the subject is found wherever the op keeps it', () => {
  for (const [op, args] of [
    ['trace_invalidation', { mutation: 'updateUser' }],
    ['trace_field_to_render', { field: 'userId' }],
    ['find_unused_props', { component: 'Button' }],
    ['find_usages', { symbols: ['Button'] }],
  ] as const) {
    const { calls } = cheapCallsFor(op, args, 'this-call');
    const subject: unknown = Object.values(args)[0];
    const want: unknown = Array.isArray(subject) ? (subject as readonly unknown[])[0] : subject;
    assert.ok(
      calls.some((c) => c.call.includes(`"${String(want)}"`)),
      `${op} dropped its subject: ${calls.map((c) => c.call).join(' · ')}`,
    );
  }
});

// The sharpest form of this task's defect, and one this table shipped: under `'any-program-build'` the engine
// OOM'd running the op, so re-addressing buys nothing — a file-pinned trace OOMs exactly as its
// bare-name form does (measured on a 6k-file repo). Offering the re-pin there handed the agent back
// the very call that had just failed. Under either engine-death claim, only calls that build no program may be named.
test('a died-engine redirect never names a call that builds a program', () => {
  const everyOp = [...new Set([...OPS.map((o) => o.op), 'search_symbol'])];
  // BOTH engine-death claims, not just the proven one. This is the widest matrix in the tree for
  // the invariant, and covering only `'any-program-build'` would leave the claim a deadline kill
  // actually sets to a single 3-op assertion elsewhere — so re-permitting the re-pin for a timeout
  // would pass right here, in the test named for exactly that defect.
  for (const claim of ['any-program-build', 'unproven-program-build'] as const) {
    for (const op of everyOp) {
      for (const shape of ARG_SHAPES) {
        for (const c of cheapCallsFor(op, shape.args, claim).calls) {
          assert.notEqual(
            c.buildsProgram,
            true,
            `${op} (${shape.label}, ${claim}) offers a program-building call after the engine died: ${c.call}`,
          );
        }
      }
    }
  }
});

test('a died-engine redirect never echoes back the call that just failed', () => {
  const args = { name: 'Button', prop: 'size', file: 'src/Button.tsx' };
  for (const op of ['trace_prop_through_tree', 'find_definition']) {
    const { calls, substitute } = cheapCallsFor(op, args, 'any-program-build');
    for (const c of calls) {
      assert.ok(!c.call.startsWith(`${op} `), `${op} redirects to itself after dying: ${c.call}`);
    }
    // Under the GUARD the very same call IS the right answer — the refusal was about addressing.
    assert.ok(
      cheapCallsFor(op, args, 'this-call').calls.some((c) => c.call.startsWith(`${op} `)),
      `${op} must still re-pin itself when the GUARD refused`,
    );
    // With a file already pinned, the only specific call each of these had was the program-building
    // one, so all three honestly fall back rather than claim a substitute they no longer have.
    assert.equal(substitute, false, `${op} claims a substitute it cannot deliver after dying`);
  }

  // trace_type_widening is the OTHER shape and must not be folded into the loop above: its fan
  // follows the value's DECLARATION (t-467009), so a `file` pin fans identically and a re-pin can
  // never escape the refusal. It therefore offers no self-call under EITHER claim — printing one
  // would be the inert lever this module exists to prevent — and honestly claims no substitute.
  for (const claim of ['this-call', 'any-program-build'] as const) {
    const { calls, substitute } = cheapCallsFor('trace_type_widening', args, claim);
    for (const c of calls) {
      assert.ok(
        !c.call.startsWith('trace_type_widening '),
        `trace_type_widening offers a re-pin that cannot escape its own fan (${claim}): ${c.call}`,
      );
    }
    assert.equal(
      substitute,
      false,
      `trace_type_widening claims a substitute for the widening question (${claim})`,
    );
  }

  // Without a file, find_definition still has a genuine no-build partial (the syntactic scan finds
  // the declaring file), so it may claim one — the filter drops only the program-building step.
  const noFile = cheapCallsFor('find_definition', { name: 'Button' }, 'any-program-build');
  assert.equal(noFile.substitute, true);
  assert.deepEqual(
    noFile.calls.map((c) => c.call),
    ['search_symbol {query:"Button",syntactic:true}'],
  );
});

// The partial must never be sold as the whole: the syntactic scan finds declarations and import
// sites, which is NOT the per-site usage set find_usages would have returned.
test('the find_usages redirect states what it does NOT give', () => {
  const [first] = cheapCallsFor('find_usages', { name: 'Button' }, 'this-call').calls;
  assert.ok(first !== undefined);
  assert.match(first.gives, /NOT the per-site usage set/);
});

// t-229522 — `source`'s own question has a real cheap answer (the same op, AST-only), so it must not be
// sent to ops that answer a different one: `symbols_overview` / `search_symbol` list NAMES and cannot
// print a body, so offering them under a RUN INSTEAD lead would claim an equivalence that does not hold.
test('source redirects to its own AST-only mode, not to ops that cannot print a body', () => {
  for (const claim of ['this-call', 'any-program-build', 'unproven-program-build'] as const) {
    const { calls, substitute } = cheapCallsFor('source', { targets: [{ name: 'Button' }] }, claim);
    assert.equal(substitute, true, `${claim}: source HAS a substitute for its own question`);
    assert.deepEqual(
      calls.map((c) => c.call),
      ['source {targets:[{"name":"Button"}],syntactic:true}'],
      `${claim}: the same call in the AST-only mode, args carried verbatim`,
    );
    // It survives the died-engine filter only because it builds no program — assert that claim is
    // actually made, or the filter would be passing it through for the wrong reason.
    assert.notEqual(calls[0]?.buildsProgram, true, `${claim}: must not be marked program-building`);
    assert.match(calls[0]?.gives ?? '', /not type-verified/, `${claim}: states what it gives up`);
  }
});

// A 20-target call cannot be rendered inside MAX_CALL, so the mode switch degrades to a one-target call.
// It must SAY so: a call answering about 1 of 20 while its `gives` promises "the same bodies" is the
// §3.4 omission in miniature — runnable, and quietly under-delivering.
test('the source mode switch admits how many targets its fallback drops', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `symbolWithAQuiteLongName${i}` }));
  const [only] = cheapCallsFor('source', { targets: many }, 'this-call').calls;
  assert.ok(only !== undefined, 'a fallback call is still offered');
  assert.ok(only.call.length <= 300, 'and it is renderable, not a truncated blob');
  assert.match(only.gives, /FIRST target only \(19 more/, `must state the drop: ${only.gives}`);

  // The exact render fits for a small call, and then nothing is dropped and nothing is claimed to be.
  const [exact] = cheapCallsFor('source', { targets: [{ name: 'Button' }] }, 'this-call').calls;
  assert.equal(exact?.call, 'source {targets:[{"name":"Button"}],syntactic:true}');
  assert.ok(!/FIRST target only/.test(exact?.gives ?? ''), 'no drop claimed when none happened');
});

// The self-referential redirect the module's own header forbids: the flag is already set, so there is
// no mode left to switch to and echoing the call back would hand the agent the one that just failed.
test('source does NOT redirect to syntactic:true when the failed call already carried it', () => {
  const { calls, substitute } = cheapCallsFor(
    'source',
    { targets: [{ name: 'Button' }], syntactic: true },
    'this-call',
  );
  assert.equal(substitute, false, 'no substitute remains once the cheap mode itself failed');
  for (const c of calls) {
    assert.ok(!c.call.startsWith('source '), `echoed the failed call back: ${c.call}`);
  }
  // And it still names what does work — the refusal must not be a dead end.
  assert.ok(calls.length > 0, 'still offers the orientation calls');
});

// A subject-less call (module-addressed, or a bare symbolId whose payload is plugin-private and must
// not be parsed here) still has to hand back something runnable, not a placeholder-only string.
test('a subject-less refusal still yields a runnable call', () => {
  for (const args of [{ module: 'src/x.ts' }, {}]) {
    const { calls } = cheapCallsFor('importers_of', args, 'this-call');
    assert.deepEqual(
      calls.map((c) => c.call),
      ['symbols_overview {}'],
    );
  }
});
