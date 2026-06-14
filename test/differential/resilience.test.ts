// §3.6 resilience — an internal tool failing must yield an HONEST outcome and a LIVE
// daemon, never a crash, never a guess. Faults are injected through `project()` seams
// (a faulting `GitRunner`, a throwing `ts` method), never by breaking the host (spec §2).
//
// Two tools, two honesty contracts:
//  · TS LS throws on a read op → the op-level wrap turns it into a `ToolFailure` (tool
//    'ts-ls', empty data), NOT an `op_threw` crash; a later op on the same engine answers.
//  · git fails on the freshness path → the read-time backstop DEGRADES, it does not crash:
//    a fingerprint failure falls back to the mtime walk (the documented fallback); a drift
//    `git diff` failure is surfaced as `unverified` and must NOT stamp a false
//    `indexedAtCommit` — the silent-stale lie §3.5 exists to catch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { runGit } from '../../src/support/git/run.ts';
import { fail } from '../../src/common/result/construct.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"jsx":"react-jsx"}}';
const DTO_A = 'export interface U { a: string }\n';
const DTO_AB = 'export interface U { a: string; b: number }\n';
const BUTTON =
  `export interface Props { size: string }\n` +
  `export const Button = (p: Props) => <button>{p.size}</button>;\n`;
const APP =
  `import { Button } from './Button';\n` + `export const App = () => <Button size="lg" />;\n`;

function isToolFailure(r: OpResult): r is OpResult & { result: { ok: false; failure: unknown } } {
  return 'result' in r && !r.result.ok;
}

for (const method of ['findUsages', 'expandType'] as const) {
  const op = method === 'findUsages' ? 'find_usages' : 'expand_type';
  test(`LS throw in ${op} → ToolFailure(ts-ls), not op_threw; daemon stays live`, async () => {
    const p = await project(
      { 'tsconfig.json': TSCONFIG, 'src/Button.tsx': BUTTON, 'src/App.tsx': APP },
      { faultTsMethod: method },
    );
    try {
      const r = await p.op(op, { name: 'Button' });
      // The wrap caught the throw: an honest failure Result, never the `op_threw` bug path.
      assert.ok(
        !('error' in r),
        `surfaced as op_threw, not a wrapped ToolFailure: ${JSON.stringify(r)}`,
      );
      assert.ok(isToolFailure(r), `expected a ToolFailure result: ${JSON.stringify(r)}`);
      assert.equal(r.result.failure.tool, 'ts-ls');
      assert.equal(r.result.ok, false);
      assert.equal('data' in r.result ? r.result.data : undefined, undefined, 'no guessed data');

      // Liveness: a different op on the SAME engine still answers (daemon did not die).
      const live = await p.op('search_symbol', { query: 'Button' });
      assert.ok(
        'result' in live && live.result.ok,
        `engine died after the fault: ${JSON.stringify(live)}`,
      );
    } finally {
      await p.dispose();
    }
  });
}

test('git fingerprint failure → mtime-walk fallback; op still answers, no crash', async () => {
  // Every git call fails → `checkGit` can't fingerprint → the guard falls back to the
  // mtime walk (§3.5 non-git fallback). The op must answer, not crash.
  const p = await project(
    { 'tsconfig.json': TSCONFIG, 'src/Button.tsx': BUTTON, 'src/App.tsx': APP },
    { gitRunner: (_cwd, _args) => Promise.resolve(fail({ tool: 'git', message: 'injected' })) },
  );
  try {
    const r = await p.op('find_definition', { name: 'Button' });
    assert.ok('result' in r && r.result.ok, `degraded path did not answer: ${JSON.stringify(r)}`);
    // And it never claims a git commit anchor it could not read.
    assert.equal(r.result.freshness?.indexedAtCommit, undefined);
    const live = await p.op('search_symbol', { query: 'Button' });
    assert.ok('result' in live && live.result.ok);
  } finally {
    await p.dispose();
  }
});

test('drift `git diff` failure on a clean checkout → unverified, never a false indexedAtCommit', async () => {
  // diff faults; rev-parse/status run for real, so a moved HEAD IS detected as drift but
  // the changed set cannot be computed. The honest outcome: surface `unverified` and
  // suppress the commit anchor — stamping `indexedAtCommit` here would claim freshness at
  // a commit whose changes were never confirmed applied (the §3.5 bulk-checkout lie).
  const p = await project(
    { 'tsconfig.json': TSCONFIG, 'src/Button.tsx': BUTTON, 'src/App.tsx': APP },
    {
      gitRunner: (cwd, args) =>
        args[0] === 'diff'
          ? Promise.resolve(fail({ tool: 'git', message: 'injected diff failure' }))
          : runGit(cwd, args),
    },
  );
  try {
    // First op pins freshness at commit 1 (clean tree, git mode).
    const first = await p.op('find_definition', { name: 'Button' });
    assert.ok('result' in first && first.result.ok);

    // Move HEAD with a clean tree (empty commit) — the bulk-checkout shape: HEAD differs,
    // working tree pristine, so ONLY the diff knows what changed.
    p.git('commit', '-q', '--allow-empty', '-m', 'c2');

    const second = await p.op('find_definition', { name: 'Button' });
    assert.ok('result' in second && second.result.ok, JSON.stringify(second));
    const fresh = second.result.freshness;
    assert.ok(fresh !== undefined, 'a drift-failure must surface a freshness note');
    assert.ok(
      fresh.unverified !== undefined,
      'freshness verification failed but was not signalled',
    );
    assert.equal(fresh.unverified.tool, 'git');
    assert.equal(
      fresh.indexedAtCommit,
      undefined,
      'must NOT stamp a commit anchor whose changes could not be verified (silent-stale lie)',
    );

    // Liveness.
    const live = await p.op('search_symbol', { query: 'Button' });
    assert.ok('result' in live && live.result.ok);
  } finally {
    await p.dispose();
  }
});

test('unverified is STICKY across ops until a diff succeeds, then recovers (no silent-stale)', async () => {
  // The dangerous variant of the case above: a REAL committed delta whose diff fails. The
  // backstop must NOT advance its baseline past an un-diffed drift — else the *next* op
  // sees an equal fingerprint, reports clean, and stamps an anchor over stale plugin data.
  // unverified must persist on every op until the diff finally succeeds and reindexes.
  let failDiff = true;
  const p = await project(
    { 'tsconfig.json': TSCONFIG, 'src/Button.tsx': BUTTON, 'src/App.tsx': APP },
    {
      gitRunner: (cwd, args) =>
        args[0] === 'diff' && failDiff
          ? Promise.resolve(fail({ tool: 'git', message: 'injected diff failure' }))
          : runGit(cwd, args),
    },
  );
  const unverifiedOf = (r: OpResult): { tool: string } | undefined =>
    'result' in r && r.result.ok ? r.result.freshness?.unverified : undefined;
  const anchorOf = (r: OpResult): string | undefined =>
    'result' in r && r.result.ok ? r.result.freshness?.indexedAtCommit : undefined;
  try {
    const op1 = await p.op('find_definition', { name: 'Button' });
    assert.ok('result' in op1 && op1.result.ok);

    // A real content change, committed → clean tree, HEAD moved, only the diff knows it.
    p.write('src/Button.tsx', BUTTON.replace('size: string', 'size: number'));
    p.commit('c2');

    // OP2 and OP3: diff keeps failing. BOTH must be unverified with NO false anchor — the
    // stickiness BUG 1 regression (OP3 is where the lost-delta lie used to surface).
    const op2 = await p.op('find_definition', { name: 'Button' });
    const op3 = await p.op('find_definition', { name: 'Button' });
    assert.ok(unverifiedOf(op2) !== undefined, 'OP2 must be unverified');
    assert.ok(unverifiedOf(op3) !== undefined, 'OP3 must STILL be unverified (sticky, not lost)');
    assert.equal(anchorOf(op2), undefined);
    assert.equal(anchorOf(op3), undefined, 'OP3 must not stamp a commit anchor over stale data');

    // git recovers → the next op retries the diff, resolves the delta, reindexes.
    failDiff = false;
    const op4 = await p.op('expand_type', { name: 'Props' });
    assert.ok('result' in op4 && op4.result.ok, JSON.stringify(op4));
    assert.equal(unverifiedOf(op4), undefined, 'recovered: no longer unverified');
    // The reindex picked up c2 — the member type now reflects the committed change.
    const members =
      (op4.result.data as { members?: { name: string; type: string }[] }).members ?? [];
    assert.equal(
      members.find((m) => m.name === 'size')?.type,
      'number',
      'stale c1 data was reindexed to c2',
    );
  } finally {
    await p.dispose();
  }
});

const membersOf = (r: OpResult): string[] => {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return ((r.result.data as { members?: { name: string }[] }).members ?? []).map((m) => m.name);
};

test('freshness MODE TRANSITION (walk→git, git recovers) forces a reindex — never serves stale', async () => {
  // git down at op1 → walk baseline. A file changes + commits while git is down. git
  // recovers → op2 crosses walk→git. The two baselines are incomparable, so the backstop
  // must NOT report `changed:[]` (that would serve the walk-era stale state dressed as
  // `current @<commit>` — the §3.5 lie). It must reindex and reflect the new content.
  let gitUp = false;
  const p = await project(
    { 'tsconfig.json': TSCONFIG, 'src/dto.ts': DTO_A },
    {
      gitRunner: (cwd, args) =>
        gitUp ? runGit(cwd, args) : Promise.resolve(fail({ tool: 'git', message: 'down' })),
    },
  );
  try {
    assert.deepEqual(
      membersOf(await p.op('expand_type', { name: 'U' })),
      ['a'],
      'op1 walk baseline',
    );

    p.write('src/dto.ts', DTO_AB);
    p.commit('add b'); // committed while git was "down" for the engine's runner
    gitUp = true; // git recovers — op2 crosses walk→git

    assert.deepEqual(
      membersOf(await p.op('expand_type', { name: 'U' })),
      ['a', 'b'],
      'walk→git transition reindexed the tree — the edit is reflected, not served stale',
    );
  } finally {
    await p.dispose();
  }
});

test('freshness MODE TRANSITION (git→walk, git goes down) forces a reindex — never serves stale', async () => {
  let gitUp = true;
  const p = await project(
    { 'tsconfig.json': TSCONFIG, 'src/dto.ts': DTO_A },
    {
      gitRunner: (cwd, args) =>
        gitUp ? runGit(cwd, args) : Promise.resolve(fail({ tool: 'git', message: 'down' })),
    },
  );
  try {
    assert.deepEqual(
      membersOf(await p.op('expand_type', { name: 'U' })),
      ['a'],
      'op1 git baseline',
    );

    p.write('src/dto.ts', DTO_AB); // a dirty edit
    gitUp = false; // git goes down — op2 crosses git→walk

    assert.deepEqual(
      membersOf(await p.op('expand_type', { name: 'U' })),
      ['a', 'b'],
      'git→walk transition reindexed the tree — the edit is reflected, not served stale',
    );
  } finally {
    await p.dispose();
  }
});
