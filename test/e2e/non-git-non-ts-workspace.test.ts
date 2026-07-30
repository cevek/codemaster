// t-810757: the two ops whose job is to work where the normal path does not — `symbols_overview`
// (the OOM-safe first-contact browse other ops' refusals redirect to) and `feedback` (the channel
// for "this tool does not work here") — must answer in a workspace that is not git, not TS, or
// neither. Each would otherwise fail through the normal path's own precondition.
//
// ORACLE = the workspaces themselves, on disk: what a directory declares, and what git can and
// cannot say about it. Never another codemaster answer. Three shapes, each asserted for what the op
// MUST return and why that is not a lie:
//   A  non-git + TS   → the catalogue names the declaration that is really there, and states the
//                       walk surface it used (the git wording would be false).
//   B  git + non-TS   → `feedback` records (and records that the root is unsupported); every
//                       workspace-NEEDING op is still refused — an honest capability statement.
//   C  neither        → both answer.
// Plus the no-regression control: in a git workspace nothing about the answer changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { bareWorkspaces } from '../helpers/bare-workspace.ts';
import type { OpResult } from '../../src/ops/contracts.ts';
import { renderResult } from '../../src/format/render/render-result.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true}}';
const SRC = 'export const alphaWidget = 1;\nexport interface BetaShape { n: number }\n';

const WALK_MARK = 'SURFACE = FILESYSTEM WALK';
/** The claim the walk surface may NOT make — asserted absent, so a fallback that kept the git
 *  wording fails here even though it answers. */
const GIT_CLAIM = /scanned all git-tracked/;

function only(results: readonly OpResult[]): OpResult {
  const r = results[0];
  assert.ok(r !== undefined, 'expected exactly one result');
  return r;
}
function okData<T>(results: readonly OpResult[]): T {
  const r = only(results);
  assert.ok('result' in r && r.result.ok, `expected ok: ${JSON.stringify(r)}`);
  return r.result.data as T;
}
function errorMessage(results: readonly OpResult[]): string {
  const r = only(results);
  assert.ok('error' in r, `expected an error result: ${JSON.stringify(r)}`);
  return r.error.message;
}

function workspaces() {
  return bareWorkspaces({
    // A — real TS source, no `.git` anywhere.
    nogit: { git: false, files: { 'tsconfig.json': TSCONFIG, 'src/a.ts': SRC } },
    // B — a git repo with nothing codemaster inspects.
    nots: { git: true, files: { 'A.java': 'public class A {}\n', 'README.md': 'hi\n' } },
    // C — neither.
    neither: { git: false, files: { 'notes.txt': 'hello\n' } },
    // The control: the ordinary, fully-supported shape.
    normal: { git: true, files: { 'tsconfig.json': TSCONFIG, 'src/a.ts': SRC } },
  });
}

test('A (non-git + TS): symbols_overview catalogues the real declarations and states the walk surface', async () => {
  const w = await workspaces();
  try {
    const data = okData<{ names: number; surface?: string; note: string; catalogue: unknown[] }>(
      await w.request('nogit', [{ name: 'symbols_overview', args: {} }]),
    );
    // The declarations really in the directory — not merely `ok`, which an empty catalogue satisfies.
    const rendered = JSON.stringify(data);
    assert.match(rendered, /alphaWidget/, 'the exported const is catalogued');
    assert.match(rendered, /BetaShape/, 'the exported interface is catalogued');
    assert.equal(data.names, 2);

    // The scope claim moved with the mechanism: the walk is named, the git claim is not made.
    assert.ok(data.surface !== undefined, 'a non-default surface must be stated');
    assert.match(data.surface, new RegExp(WALK_MARK));
    assert.match(data.surface, /\.gitignore is NOT/, 'the WIDER axis is stated');
    assert.match(
      data.surface,
      /MISSING here while it would be present in a git workspace/,
      'the NARROWER axis (the §3.4 miss) is stated, not smoothed away',
    );
    assert.doesNotMatch(data.surface, GIT_CLAIM);
    // …and neither may the note BESIDE it. An answer that asserts a git scan and prints its own
    // correction two lines down leaves the reader to pick which half to believe; the assertion is
    // the lie, the correction does not cancel it.
    assert.doesNotMatch(data.note, GIT_CLAIM);
    assert.doesNotMatch(
      data.note,
      /Scope: git-tracked source/,
      'the note may name git as the DEFAULT listing, never as the one that ran here',
    );
  } finally {
    await w.dispose();
  }
});

test('A: the other two no-program paths answer too, and say which surface they read', async () => {
  const w = await workspaces();
  try {
    const search = okData<{ surface?: string; matches: { id: string }[] }>(
      await w.request('nogit', [
        { name: 'search_symbol', args: { query: 'alphaWidget', syntactic: true } },
      ]),
    );
    assert.equal(search.matches.length > 0, true, 'the syntactic search finds the declaration');
    assert.match(search.matches[0]?.id ?? '', /alphaWidget/);
    assert.match(search.surface ?? '', new RegExp(WALK_MARK));

    // `source` renders through its own compact-body path — assert on the RENDERED text, since a
    // renderer that emits only the fields it knows would drop the surface line the op did populate.
    const src = only(
      await w.request('nogit', [
        { name: 'source', args: { name: 'alphaWidget', syntactic: true } },
      ]),
    );
    assert.ok('result' in src && src.result.ok, JSON.stringify(src));
    const text = renderResult(src.result);
    assert.match(text, /export const alphaWidget = 1;/, 'the body is printed');
    assert.match(text, new RegExp(WALK_MARK), 'the surface line survives the source renderer');
  } finally {
    await w.dispose();
  }
});

test('A: the surface statement survives sql mode, where producer `data` does not', async () => {
  const w = await workspaces();
  try {
    // A sql join drops producer `data` — only rows, the table's own `notes`, and the envelope's
    // honesty channels cross into it. So the surface statement, which lives in `data` for the text
    // path, has to be re-offered by the table or a `syntactic:true` join over a non-git workspace
    // returns rows scanned from the walk while claiming nothing about it: the pre-fix silence, on
    // the one claim this channel exists to carry.
    const results = await w.request(
      'nogit',
      [{ name: 'search_symbol', args: { query: 'alphaWidget', syntactic: true }, as: 't' }],
      { sql: 'SELECT name, file FROM t' },
    );
    const sql = results[results.length - 1];
    assert.ok(sql !== undefined && 'result' in sql && sql.result.ok, JSON.stringify(sql));
    const payload = JSON.stringify(sql.result.data);
    assert.match(payload, /alphaWidget/, 'the join really produced the row');
    assert.match(payload, new RegExp(WALK_MARK), 'and states the surface those rows came from');
  } finally {
    await w.dispose();
  }
});

test('control (git + TS): the answer carries no surface line and keeps the git scope claim', async () => {
  const w = await workspaces();
  try {
    const data = okData<{ names: number; surface?: string; note: string }>(
      await w.request('normal', [{ name: 'symbols_overview', args: {} }]),
    );
    assert.equal(data.names, 2, 'same declarations as the non-git twin');
    assert.equal(
      data.surface,
      undefined,
      'the documented default holds → no per-response mode line (no token tax, no output drift)',
    );
    // The note names the DEFAULT listing in both modes — that is what makes the absent surface line
    // informative rather than an unspoken assumption. What distinguishes the modes is the line, not
    // a different scope sentence, so this pins the default's presence, not a git-only assertion.
    assert.match(data.note, /git-listed by default/);
  } finally {
    await w.dispose();
  }
});

test('B (git + non-TS): feedback records, and the entry says the workspace is unsupported', async () => {
  const w = await workspaces();
  try {
    const data = okData<{ recorded: boolean; at: string }>(
      await w.request('nots', [
        {
          name: 'feedback',
          args: { kind: 'wish', title: 'jvm support', detail: 'lombok builders' },
        },
      ]),
    );
    assert.equal(data.recorded, true);
    assert.equal(
      data.at.startsWith(w.stateDir),
      true,
      'the inbox is the injected state dir, not the user’s real one',
    );
    const inbox = readFileSync(data.at, 'utf8');
    assert.match(inbox, /## \[wish\] jvm support/);
    assert.match(inbox, /lombok builders/);
    assert.match(
      inbox,
      /UNSUPPORTED WORKSPACE: no TS project at /,
      'triage must be able to tell this report from one filed where everything works',
    );
    // By basename: the recorded root is the CANONICAL path, which on darwin resolves the
    // `/var`→`/private/var` symlink the temp dir is handed out under.
    assert.match(
      inbox,
      new RegExp(`repo=\\S*${path.basename(w.root('nots'))}\\b`),
      'the root is named',
    );
  } finally {
    await w.dispose();
  }
});

test('B: workspace-needing ops are still refused — the gate did not open for everything', async () => {
  const w = await workspaces();
  try {
    // Warm an engine on this root through the workspace-INDEPENDENT op first: the refusal must not
    // be bypassable by the slot that call leaves behind.
    await w.request('nots', [
      { name: 'feedback', args: { kind: 'bug', title: 'warm', detail: 'warm the slot' } },
    ]);
    for (const req of [
      { name: 'symbols_overview', args: {} },
      { name: 'find_usages', args: { name: 'A' } },
      { name: 'search_symbol', args: { query: 'A', syntactic: true } },
    ]) {
      assert.match(
        errorMessage(await w.request('nots', [req])),
        /no TS project at /,
        `${req.name} must still be refused on a non-TS root`,
      );
    }
    // A batch MIXING the two fails closed: the group shares one engine, so its strictest member wins.
    const mixed = await w.request('nots', [
      { name: 'feedback', args: { kind: 'bug', title: 'mixed', detail: 'mixed batch' } },
      { name: 'find_usages', args: { name: 'A' } },
    ]);
    assert.match(
      JSON.stringify(mixed),
      /no TS project at /,
      'a workspace-needing op riding along must not be smuggled past the gate',
    );
  } finally {
    await w.dispose();
  }
});

test('multi-root batch: the gate is decided PER dispatch group, not once for the batch', async () => {
  const w = await workspaces();
  try {
    // Two roots in one batch → the grouped (non-fast-path) dispatch. The unsupported root's group is
    // workspace-independent and must record; the supported root's group answers normally.
    const spread = await w.request('normal', [
      {
        name: 'feedback',
        args: { kind: 'wish', title: 'cross-root', detail: 'filed from the unsupported root' },
        root: w.root('nots'),
      },
      { name: 'symbols_overview', args: {} },
    ]);
    const filed = spread[0];
    assert.ok(filed !== undefined && 'result' in filed && filed.result.ok, JSON.stringify(filed));
    assert.equal((filed.result.data as { recorded: boolean }).recorded, true);
    const browsed = spread[1];
    assert.ok(
      browsed !== undefined && 'result' in browsed && browsed.result.ok,
      JSON.stringify(browsed),
    );
    assert.equal((browsed.result.data as { names: number }).names, 2);

    // Now make the unsupported root's group MIXED: its strictest member gates the whole group, while
    // the sibling root's group is unaffected — a per-batch decision would sink one or open the other.
    const mixed = await w.request('normal', [
      { name: 'feedback', args: { kind: 'bug', title: 'x', detail: 'y' }, root: w.root('nots') },
      { name: 'find_usages', args: { name: 'A' }, root: w.root('nots') },
      { name: 'symbols_overview', args: {} },
    ]);
    const gated = mixed[0];
    assert.ok(
      gated !== undefined && 'error' in gated,
      `the mixed group must be refused: ${JSON.stringify(gated)}`,
    );
    assert.match(gated.error.message, /no TS project at /);
    const sibling = mixed[2];
    assert.ok(
      sibling !== undefined && 'result' in sibling && sibling.result.ok,
      JSON.stringify(sibling),
    );
  } finally {
    await w.dispose();
  }
});

test('B: a root that BECOMES a TS project is answered on the next read, not held refused', async () => {
  const w = await workspaces();
  try {
    // Spawn the engine for this unsupported root via the workspace-independent op…
    await w.request('nots', [
      { name: 'feedback', args: { kind: 'bug', title: 'first', detail: 'before' } },
    ]);
    assert.match(
      errorMessage(await w.request('nots', [{ name: 'symbols_overview', args: {} }])),
      /no TS project/,
    );
    // …then make it inspectable. The read path is the freshness guarantee (§3.5): a refusal cached
    // on the warm slot would hold this repo refused until idle eviction.
    w.write('nots', 'tsconfig.json', TSCONFIG);
    w.write('nots', 'src/late.ts', 'export const lateArrival = 1;\n');
    const data = okData<{ names: number }>(
      await w.request('nots', [{ name: 'symbols_overview', args: {} }]),
    );
    assert.equal(data.names >= 1, true, 'the now-inspectable root answers');
    assert.match(
      JSON.stringify(data),
      /lateArrival/,
      'and it answers about the file that made it inspectable',
    );
  } finally {
    await w.dispose();
  }
});

test('C (neither git nor TS): both ops answer', async () => {
  const w = await workspaces();
  try {
    // No `.git` at all — the precondition the surface must not depend on.
    assert.equal(existsSync(path.join(w.root('neither'), '.git')), false);

    const overview = okData<{ names: number; surface?: string }>(
      await w.request('neither', [{ name: 'symbols_overview', args: {} }]),
    );
    // An HONEST empty: the directory genuinely declares no TS symbol, and the answer still states
    // WHICH surface established that — an emptiness whose scope is unstated is the claim we refuse.
    assert.equal(overview.names, 0);
    assert.match(overview.surface ?? '', new RegExp(WALK_MARK));

    const fb = okData<{ recorded: boolean; at: string }>(
      await w.request('neither', [
        { name: 'feedback', args: { kind: 'friction', title: 'bare dir', detail: 'no repo here' } },
      ]),
    );
    assert.equal(fb.recorded, true);
    assert.match(readFileSync(fb.at, 'utf8'), /## \[friction\] bare dir/);
  } finally {
    await w.dispose();
  }
});
