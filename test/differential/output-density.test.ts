// Render-contract guard (the output-density umbrella, docs/backlog.md). `condense.ts`
// `collapseKnownShape` is an exact-key-set registry with a `return v` fall-through; a row shape
// with no case silently explodes into render-dense's multi-line `- key=value` block (watery). This
// test runs the at-risk ops over a real fixture and asserts NO result row falls through — so a
// future op (or a row-shape change) that lacks a collapse case fails CI here instead of shipping
// watery output. The oracle is structural: the precise fall-through signature, not "looks long".
//
// Coverage is EVERY reachable read op at terse/normal/FULL — ts+scss via the inline fixture below,
// the config-gated ops (i18n ×3 / css_cascade / react-query / list / list_endpoints) via configured
// fixtures (kitchensink/react-query repos + an inline schema). The full pass is what makes this the
// discriminating density oracle (a row that collapses at normal can still EXPLODE at full when its
// tag is `verbatim`-disposition — the `symbol`/`expand_type` regressions). Beyond no-explosion, the
// targeted asserts below pin the two honesty-sensitive halves: EVIDENCE span text MUST survive at
// full (i18n dynamic key / dotted key) and key INSERTION ORDER (verdict-before-bulk, §12) holds
// where a fix reshaped the envelope.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { projectFromDir } from '../helpers/repo-fixture.ts';
import { renderResult } from '../../src/format/render/render-result.ts';
import { summarizeQueryKey } from '../../src/format/render/condense.ts';
import { renderKey } from '../../src/ops/react-query-invalidations-for.ts';
import { tag } from '../../src/common/shape-tag/tag.ts';
import { fallThrough, leakedTag, renderRows, span, topLevelExplosion } from '../helpers/density.ts';
import type { QueryKeyView } from '../../src/plugins/react-query/views.ts';
import type { JsonValue } from '../../src/core/json.ts';
import type { Result, Verbosity } from '../../src/core/result.ts';
import type { OpResult } from '../../src/ops/contracts.ts';
import type { TestProject } from '../helpers/project.ts';

function resultOf(r: OpResult): Result<JsonValue> {
  assert.ok('result' in r && r.result.ok, `op failed: ${JSON.stringify(r)}`);
  return r.result;
}

const VERBOSITIES: readonly Verbosity[] = ['terse', 'normal', 'full'];

/** The watery-output guard at EVERY verbosity: no bulleted fall-through, no top-level object
 *  explosion, no leaked `~shape` tag. Running it at `full` (not just terse/normal) is what catches a
 *  `verbatim`-disposition row that collapses at normal but explodes at full. */
function assertNoExplosion(result: Result<JsonValue>, name: string): void {
  for (const v of VERBOSITIES) {
    const text = renderResult(result, v);
    assert.equal(
      fallThrough(text),
      undefined,
      `${name} (${v}) fell through condense → watery block:\n${fallThrough(text)}`,
    );
    assert.equal(
      topLevelExplosion(text),
      undefined,
      `${name} (${v}) exploded a top-level nested object:\n${topLevelExplosion(text)}`,
    );
    assert.equal(
      leakedTag(text),
      undefined,
      `${name} (${v}) leaked a shape tag:\n${leakedTag(text)}`,
    );
  }
}

/** Run an op on a project, assert its named rows are non-vacuous, and sweep the explosion guards. */
async function sweepOp(
  p: TestProject,
  name: string,
  args: JsonValue,
  rows: string,
): Promise<Result<JsonValue>> {
  const result = resultOf(await p.op(name, args));
  const data = result.data as Record<string, JsonValue>;
  const cell = data[rows];
  const count = Array.isArray(cell)
    ? cell.length
    : cell !== null && typeof cell === 'object'
      ? Object.keys(cell).length
      : 0;
  assert.ok(count > 0, `${name}: expected ≥1 row in '${rows}', got ${count} (vacuous)`);
  assertNoExplosion(result, name);
  return result;
}

/** A fixture that triggers every at-risk TS-domain op with real, non-empty results: a type with
 *  a construction site, a dead export, and a component rendered from a second module (usages /
 *  importers / impact). No codemaster.config → ts (+ react autodetect) only; the i18n / scss /
 *  react-query ops carry their own collapse cases + tests (i18n-*.test.ts, react-query.test.ts). */
function fixture() {
  return project({
    'tsconfig.json':
      '{"compilerOptions":{"jsx":"react-jsx","strict":true,"module":"ESNext","moduleResolution":"Bundler"},"include":["src"]}',
    'src/types.ts':
      'export type Cfg = { a?: string; b?: number; nested?: { x: number } };\nexport const built: Cfg = { a: "x" };\n',
    'src/dead.ts': 'export const unusedThing = 1;\nexport type DeadType = { x: number };\n',
    'src/a.module.scss': '.used { color: red; }\n.dead { color: blue; }\n',
    'src/widget.tsx':
      "import s from './a.module.scss';\nexport function Widget({label}: {label: string}) {\n  return <button className={s.used}>{label}</button>;\n}\n",
    'src/app.tsx':
      'import {Widget} from "./widget.tsx";\nexport function App() {\n  return <Widget label="a" />;\n}\n',
  });
}

// op name → args, and the result field whose array must be non-empty (so the guard can never pass
// vacuously on an empty answer). Covers EVERY reachable read op across ts + scss; the config-gated
// i18n / react-query / list / schema ops are swept against configured fixtures below.
const CASES: { name: string; args: JsonValue; rows: string }[] = [
  { name: 'construction_sites', args: { name: 'Cfg' }, rows: 'sites' },
  { name: 'find_unused_exports', args: {}, rows: 'unused' },
  { name: 'find_usages', args: { name: 'Widget' }, rows: 'usages' },
  { name: 'find_usages', args: { name: 'Widget', groupBy: 'enclosing' }, rows: 'enclosers' },
  { name: 'find_usages', args: { name: 'Widget', text: true }, rows: 'usages' },
  { name: 'find_definition', args: { name: 'Widget' }, rows: 'definitions' },
  { name: 'expand_type', args: { name: 'Cfg', depth: 2 }, rows: 'members' },
  { name: 'search_symbol', args: { query: 'Widget' }, rows: 'matches' },
  { name: 'importers_of', args: { module: 'src/widget.tsx' }, rows: 'importers' },
  { name: 'impact', args: { name: 'Widget' }, rows: 'dependents' },
  { name: 'scss_classes', args: {}, rows: 'classes' },
  { name: 'find_unused_scss_classes', args: {}, rows: 'unused' },
  { name: 'css_cascade', args: { file: 'src/a.module.scss', class: 'used' }, rows: 'rules' },
];

test('no ts/scss op result row falls through condense into a watery key=value block (terse/normal/full)', async () => {
  const p = await fixture();
  try {
    for (const c of CASES) await sweepOp(p, c.name, c.args, c.rows);
  } finally {
    await p.dispose();
  }
});

// The config-gated ops — i18n (×3) + css_cascade over the kitchensink repo (ts+scss+i18n), the
// react-query ops over the react-query repo, list_endpoints over an inline openapi schema. These
// close the "live forgot-to-`tag()` guard covers only ts+scss" gap (backlog): an op that forgot to
// tag a row would explode and CI catches it HERE, on the real op pipeline, not just a synthetic row.
test('config-gated i18n / css_cascade ops are dense at terse/normal/full (kitchensink)', async () => {
  const p = await projectFromDir('kitchensink');
  try {
    await sweepOp(p, 'find_unused_i18n_keys', {}, 'unused');
    await sweepOp(p, 'find_missing_i18n_keys', {}, 'missing');
    await sweepOp(p, 'i18n_lookup', { key: 'widget.actions.save' }, 'defs');
    await sweepOp(
      p,
      'css_cascade',
      { file: 'src/features/widget/Widget.module.scss', class: 'title' },
      'rules',
    );
  } finally {
    await p.dispose();
  }
});

test('config-gated react-query ops (list / invalidations_for) are dense at terse/normal/full', async () => {
  const p = await projectFromDir('react-query');
  try {
    await sweepOp(p, 'list', { registry: 'mutations' }, 'entries');
    await sweepOp(p, 'invalidations_for', { mutation: 'useCreateTodo' }, 'mutations');
  } finally {
    await p.dispose();
  }
});

const SCHEMA_FIXTURE = {
  'codemaster.config.ts':
    "import { defineConfig } from 'codemaster';\n" +
    "export default defineConfig({ schema: { entrypoint: 'src/api/openapi.d.ts', generator: 'openapi-typescript' } });\n",
  'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src"]}',
  'src/api/openapi.d.ts':
    'export interface paths {\n' +
    '  "/users/{id}": { get: operations["getUser"] };\n' +
    '}\n' +
    'export interface operations {\n' +
    '  getUser: {\n' +
    '    parameters: { path: { id: number } };\n' +
    '    responses: { 200: { content: { "application/json": components["schemas"]["UserDto"] } } };\n' +
    '  };\n' +
    '}\n' +
    'export interface components { schemas: { UserDto: { id: number; name: string } } }\n',
};

test('list_endpoints (schema plugin) endpoint cards are dense at terse/normal/full', async () => {
  const p = await project(SCHEMA_FIXTURE);
  try {
    await sweepOp(p, 'list_endpoints', {}, 'endpoints');
  } finally {
    await p.dispose();
  }
});

// EVIDENCE survival (the other half of density): a few forms' span TEXT is itself the proof, so the
// full-mode collapse must NOT drop it (that would be the §3 proof-out lie). Positive assertions —
// the explosion guards above can't see a silently-dropped token.
test('i18n evidence span text survives at full (dynamic key expression + dotted key)', async () => {
  const p = await projectFromDir('kitchensink');
  try {
    const missing = renderResult(resultOf(await p.op('find_missing_i18n_keys', {})), 'full');
    // The dynamic t(`…`) template literal IS the evidence the call is dynamic — kept at full.
    assert.match(
      missing,
      /dashboard\.\$\{props\.section/,
      'dynamicUsages template text present at full',
    );
    // A literal missing usage keeps its dotted key (the span renders loc-only at full, so the key
    // must come through as its own token — the i18n-missing-usage echo-drop must not fire).
    assert.match(missing, /absent\.key/, 'missing dotted key present at full');

    const lookup = renderResult(
      resultOf(await p.op('i18n_lookup', { key: 'widget.actions.save' })),
      'full',
    );
    assert.match(lookup, /widget\.actions\.save/, 'i18n_lookup usage key present at full');
  } finally {
    await p.dispose();
  }
});

// WATERY fixes, pinned positively + with key-order (the density guards catch explosion, not order;
// §12 verdict-before-bulk must hold where a fix reshaped the envelope).
test('css_cascade rules do not duplicate the selector (807)', async () => {
  const p = await projectFromDir('kitchensink');
  try {
    const out = renderResult(
      resultOf(
        await p.op('css_cascade', {
          file: 'src/features/widget/Widget.module.scss',
          class: 'title',
        }),
      ),
      'normal',
    );
    // A contributing rule is `[spec] loc · .title… · {decls}` — the selector appears ONCE, never the
    // `… · .title::before · .title::before · …` span-text/selector double (the 807 repro).
    assert.doesNotMatch(out, /· (\.[\w:-]+) · \1 ·/, `selector duplicated in a rule row:\n${out}`);
  } finally {
    await p.dispose();
  }
});

test('expand_type full: name-token span collapses to an `at` loc, order verdict-before-bulk (731)', async () => {
  const p = await fixture();
  try {
    const out = renderResult(
      resultOf(await p.op('expand_type', { name: 'Cfg', depth: 2 })),
      'full',
    );
    assert.doesNotMatch(out, /\n\s+endLine=/, `name-token span exploded into a block:\n${out}`);
    assert.match(out, /^at=src\/types\.ts:\d+:\d+$/m, 'clickable `at` loc present');
    // Verdict (about/type) before the bulky member list; `at` (small loc) before `members` (bulk).
    const iAbout = out.search(/^(about=|type:|type=)/m);
    const iAt = out.indexOf('\nat=');
    const iMembers = out.search(/^members \(/m);
    assert.ok(iAbout >= 0 && iAbout < iMembers, 'type verdict precedes members');
    assert.ok(iAt >= 0 && iAt < iMembers, '`at` loc precedes the bulky members');
  } finally {
    await p.dispose();
  }
});

test('find_usages full: definition collapses (not a verbatim block) and precedes the usage list (774)', async () => {
  const p = await fixture();
  try {
    const out = renderResult(resultOf(await p.op('find_usages', { name: 'Widget' })), 'full');
    // The single `definition` is a name-token symbol REF (no decl body) → one `id · kind` line, never
    // an `id=/name=/kind=/span{…}` block. `symbol` is now collapse-disposition (FULL_DISPOSITION).
    assert.match(
      out,
      /^definition=ts:Widget@[^\n]*· function$/m,
      'definition is a one-liner at full',
    );
    assert.doesNotMatch(out, /^\s+callable=/m, 'definition did not explode into a verbatim block');
    const iDef = out.indexOf('definition=');
    const iUsages = out.search(/^usages \(/m);
    assert.ok(iDef >= 0 && iDef < iUsages, 'definition precedes the usage list');
  } finally {
    await p.dispose();
  }
});

// condense's `summarizeQueryKey` (text render) is an intentional structural twin of the op's
// `renderKey` (sql-table render) — the format layer can't import the react-query op/type, so the
// logic is duplicated. Cross-pin them so the duplication can never silently diverge (text and sql
// showing a different key for the same queryKey). Covers static / dynamic-segment / opaque keys.
test('summarizeQueryKey (text) == renderKey (sql) for every queryKey shape', () => {
  // Structural key literals — the per-segment/key `span` (a branded Span) is omitted and cast away:
  // neither renderer reads it, the comparison is purely over kind/value/shape/opaque.
  const keys = [
    { segments: [{ kind: 'static', value: 'todos' }], confidence: 'certain' },
    {
      segments: [
        { kind: 'static', value: 'todo' },
        { kind: 'dynamic', shape: 'identifier' },
      ],
      confidence: 'partial',
    },
    { segments: [], opaque: 'call', confidence: 'dynamic' },
  ];
  for (const k of keys) {
    assert.equal(
      summarizeQueryKey(k as unknown as JsonValue),
      renderKey(k as unknown as QueryKeyView, false),
      JSON.stringify(k),
    );
  }
});

// The shapes the pipeline fixture above can't reach without plugin config — a mutating-op `captures`
// refusal and `invalidations_for`'s react-query leaves — fed as literal rows through the SAME
// condense→dense path. Locks their collapse cases without needing a capture-triggering or
// react-query fixture.
test('captures + invalidations_for leaf shapes collapse to dense lines', () => {
  // mutating-op capture row { at, kind, detail } — must be one line, not a 3-line block.
  const cap = renderRows([
    tag('capture', { at: 'src/a.ts:1:1', kind: 'shadow', detail: 'rebinds to a local X' }),
  ]);
  assert.equal(fallThrough(cap), undefined, `captures fell through:\n${cap}`);
  // A row that collapses to a STRING renders bulletless (only object items get a `- ` bullet).
  assert.match(cap, /^src\/a\.ts:1:1 · shadow · rebinds to a local X$/m);

  // invalidations_for AffectedQuery { id, name, queryKey, site, confidence } — one line, key summarized.
  const affect = tag('rq-affected', {
    id: 'ts:useTodos@src/h.ts:1:1',
    name: 'useTodos',
    queryKey: {
      segments: [{ kind: 'static', value: 'todos' }],
      confidence: 'certain',
      span: span(2, 'todos'),
    },
    site: span(2, 'todos'),
    confidence: 'certain',
  });
  const aff = renderRows([affect]);
  assert.equal(fallThrough(aff), undefined, `affect fell through:\n${aff}`);
  assert.match(aff, /^ts:useTodos@src\/h\.ts:1:1 · \["todos"\]$/m);

  // invalidations_for edge — the scalar fan folds to one `edge=` line; affects stays a nested list.
  const edge = tag('rq-edge', {
    method: 'invalidate',
    key: {
      segments: [{ kind: 'static', value: 'todos' }],
      confidence: 'certain',
      span: span(3, 'todos'),
    },
    all: false,
    exact: false,
    narrowed: false,
    span: span(3, 'invalidateQueries'),
    affects: [affect],
  });
  const e = renderRows([edge]);
  assert.equal(fallThrough(e), undefined, `edge fell through:\n${e}`);
  assert.match(e, /- edge=invalidate @src\/h\.ts:3:1 \["todos"\] · certain/);
  assert.doesNotMatch(e, /\bmethod=|\ball=|\bnarrowed=/, 'edge scalar fields must not explode');
});

// A negative control: the predicate MUST fire on a genuinely exploded block, or the guard above is
// vacuous. This is the exact shape render-dense emits for an array of un-collapsed objects.
test('fallThrough predicate fires on a real exploded block (anti-vacuity)', () => {
  const exploded = [
    'sites (1):',
    '  - span=src/a.ts:1:1',
    '    confidence=certain',
    '    kind=function',
  ].join('\n');
  assert.notEqual(fallThrough(exploded), undefined, 'predicate failed to catch a known explosion');

  // …and catches the FIRST-FIELD-NESTED explosion (bullet is `- items (N):`, the exploded scalars
  // land at i+2+, never i+1 — the blind spot an `i+1`-only check missed). Uses the real render path
  // on an UNTAGGED object (a forgot-to-tag row), which is exactly what must explode.
  const firstNested = renderRows([{ items: [{ a: 1 }], confidence: 'certain', kind: 'function' }]);
  assert.notEqual(
    fallThrough(firstNested),
    undefined,
    `predicate missed a first-field-nested explosion:\n${firstNested}`,
  );

  // …and does NOT fire on a collapsed one-liner list, nor on a legit hierarchical row (nested arrays
  // only, no scalar pair — the invalidations_for `- id=…` → `edges (N):` → `affects` strings shape).
  const collapsed = ['sites (1):', '  - src/a.ts:1:1 · in ts:f@src/a.ts:1:1 (function)'].join('\n');
  assert.equal(fallThrough(collapsed), undefined, 'predicate false-positived on a collapsed row');
  const hierarchical = [
    'mutations (1):',
    '  - id=ts:useX@src/a.ts:1:1',
    '    edges (1):',
    '      - edge=invalidate @src/a.ts:2:1 ["x"] · certain',
    '        affects (1):',
    '          ts:useY@src/a.ts:3:1 · ["y"] · dynamic',
  ].join('\n');
  assert.equal(fallThrough(hierarchical), undefined, 'predicate false-positived on a legit tree');
});
