// spec-agent-surface-ergonomics §1: `status` gains two token-saver renders on top of the FULL
// default — `brief` (names + summaries only) and `op` (one op's full detail on demand). These
// assert the CONTRACT (what each mode keeps vs drops), complementing the full-render golden.
// Also guards §2: the duplicated `>` GUIDANCE tail is gone from every render (it ships once at
// MCP `initialize`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';

const FIXTURE = {
  'tsconfig.json': '{"compilerOptions":{"strict":true,"jsx":"react-jsx"}}',
  'src/a.ts': 'export const a = 1;\n',
  'src/a.module.scss': '.x { color: red; }\n',
};

test('status {brief}: names + summaries only — no arg schemas, notes, concepts, or guidance', async () => {
  const p = await project(FIXTURE);
  try {
    const full = await p.status();
    const brief = await p.status({ brief: true });

    // Frame kept: daemon header, plugins, the ops list.
    assert.match(brief, /^codemaster v/, 'daemon header kept');
    assert.match(brief, /plugins: ts@.+ · scss@/, 'plugins line kept');
    assert.match(brief, /find_unused_exports — TS exports with no importer/, 'name + summary kept');

    // Dropped: arg schemas (the `{ … }` argsHint), per-op notes (`· `), columns, examples,
    // the concepts block — i.e. the bulk that makes full heavy.
    assert.ok(!/find_unused_exports \{ pathInclude/.test(brief), 'arg schema dropped');
    assert.ok(!brief.includes('\n    · '), 'per-op notes dropped');
    assert.ok(!brief.includes('\nconcepts:\n'), 'concepts block dropped');
    assert.ok(!brief.includes('e.g. '), 'examples dropped');

    // Brief is materially smaller than full (the whole point — a token tax cut).
    assert.ok(brief.length < full.length / 2, 'brief is well under half of full');
    // §2: no GUIDANCE `>` tail in either render.
    assert.ok(!full.includes('\n> '), 'full has no guidance tail');
    assert.ok(!brief.includes('\n> '), 'brief has no guidance tail');
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

    // An unknown op name lists the catalogue so the agent fixes it without a second round-trip.
    const miss = await p.status({ op: 'no_such_op' });
    assert.match(miss, /op 'no_such_op' not in this repo's catalogue/, 'names the miss');
    assert.match(miss, /find_unused_exports/, 'lists available ops');
  } finally {
    await p.dispose();
  }
});
