// spec-agent-surface-ergonomics §1 + t-523883: `status` is TERSE by default (names + summaries +
// concepts frame) — the per-op arg schemas already ride the MCP tool-list (§11), and a full dump
// overruns the harness output ceiling on a large repo. `full:true` is the opt-in heavyweight
// catalogue; `op` renders one op's detail; `brief` is the back-compat alias of the terse default.
// These assert the CONTRACT (what each mode keeps vs drops), complementing the full-render golden.
// Also guards §11: the codemaster-vs-grep steer ships ONCE per session in the MCP `initialize`
// response, so no `status` render re-emits it — a per-call duplicate of a once-per-session text is
// a pure token tax. That arm is pinned by the steer's OWN words, read from the constant that
// carries them: a marker chosen for its shape instead (an indented `> ` tail) is absent from
// `SERVER_INSTRUCTIONS` too, so pasting the whole steer into `renderStatus` would leave it green.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { SERVER_INSTRUCTIONS } from '../../src/mcp/schema.ts';

/** A phrase unique to the initialize instructions, quoted from `SERVER_INSTRUCTIONS` itself rather
 *  than sliced out of it — a slice would make the positive arm a tautology, while a reword that
 *  keeps the steer and changes its words fails there instead of silently disarming the absence
 *  arms below. */
const INITIALIZE_STEER = 'Use it INSTEAD of grep/file-reading';

const FIXTURE = {
  'tsconfig.json': '{"compilerOptions":{"strict":true,"jsx":"react-jsx"}}',
  'src/a.ts': 'export const a = 1;\n',
  'src/a.module.scss': '.x { color: red; }\n',
};

test('status default is terse (== brief): names + summaries + concepts, no arg schemas / notes / examples', async () => {
  const p = await project(FIXTURE);
  try {
    const full = await p.status({ full: true });
    const terse = await p.status();
    const brief = await p.status({ brief: true });

    // Back-compat: `brief` is an ALIAS of the terse default — byte-identical.
    assert.equal(brief, terse, 'brief == terse default');

    // Frame kept: daemon header, plugins, the ops list, and the load-bearing concepts block.
    assert.match(terse, /^codemaster v/, 'daemon header kept');
    assert.match(terse, /plugins: ts@.+ · scss@/, 'plugins line kept');
    assert.match(terse, /find_unused_exports — TS exports with no importer/, 'name + summary kept');
    assert.match(terse, /\nconcepts:\n/, 'concepts block kept (load-bearing for honesty markers)');

    // Dropped: arg schemas (the `{ … }` argsHint), per-op notes (`· `), columns, examples —
    // the bulk that makes the full catalogue heavy (and redundant with the tool-list schemas).
    assert.ok(!/find_unused_exports \{ pathInclude/.test(terse), 'arg schema dropped');
    assert.ok(!terse.includes('\n    · '), 'per-op notes dropped');
    // Per-op example lines dropped — assert a concrete per-op example is absent (the concepts
    // block carries its own kept sql `e.g.`, so a bare `e.g.`/indentation match won't discriminate).
    assert.ok(!terse.includes('e.g. find_unused_exports'), 'per-op examples dropped');
    assert.match(full, /e.g. find_unused_exports/, 'full DOES carry the per-op example');

    // Terse is materially smaller than full (the whole point — a token tax cut under the ceiling).
    assert.ok(terse.length < full.length / 2, 'terse is well under half of full');
    // §11: the once-per-session `initialize` steer is not re-emitted per call. The positive arm
    // pins the phrase to the constant that owns it — so the absence below is a fact about where the
    // steer lives, not about a string nothing produces.
    assert.ok(
      SERVER_INSTRUCTIONS.includes(INITIALIZE_STEER),
      "the phrase is the initialize steer's own — reword it and re-pin, never drop the arm",
    );
    assert.ok(!full.includes(INITIALIZE_STEER), 'full does not re-emit the initialize steer');
    assert.ok(!terse.includes(INITIALIZE_STEER), 'terse does not re-emit the initialize steer');
  } finally {
    await p.dispose();
  }
});

test('status {op:"<name>"}: one op\'s full block on demand; unknown name self-corrects', async () => {
  const p = await project(FIXTURE);
  try {
    const one = await p.status({ op: 'find_unused_exports' });

    // The full block for exactly that op: summary, arg schema, notes, columns, example.
    assert.match(one, /find_unused_exports \{ pathInclude\?: string\[\]/, 'arg schema present');
    assert.match(one, /· an export reached only via a barrel/, 'per-op notes present');
    assert.match(one, /columns: name,kind,file/, 'columns present');
    assert.match(one, /e.g. find_unused_exports \{/, 'example present (per-op tool form)');
    // ...and ONLY that op — not the rest of the catalogue.
    assert.ok(!one.includes('search_symbol'), 'other ops omitted');
    assert.ok(!one.includes('\nconcepts:\n'), 'concepts omitted in single-op render');
    // §11 holds for EVERY render, and this one has its own assembler (`renderSingleOp`), so the
    // terse/full arms above do not cover it.
    assert.ok(
      !one.includes(INITIALIZE_STEER),
      'the single-op render does not re-emit the initialize steer',
    );

    // An unknown op name lists the catalogue so the agent fixes it without a second round-trip.
    const miss = await p.status({ op: 'no_such_op' });
    assert.match(miss, /op 'no_such_op' not in this repo's catalogue/, 'names the miss');
    assert.match(miss, /find_unused_exports/, 'lists available ops');
  } finally {
    await p.dispose();
  }
});
