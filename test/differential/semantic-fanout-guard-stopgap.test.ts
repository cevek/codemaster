// t-820448 STOPGAP — the SAME semantic fan-out guard on the three ops that were left ungated while
// warming the checker repo-wide (empirically OOM-fatal on a ~6.1k-file repo: each dies in a 1 GB
// process-mode child in ~10 s): `list` of a ts-backed registry, `find_unused_exports`, and the
// scss-FACING but ts-BACKED `find_unused_scss_classes`. Split out of `semantic-fanout-guard.test.ts`
// for the line cap; same harness, same independent oracle — the ts-plugin fingerprint reads 'cold'
// iff the refusal really happened BEFORE any warm.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

const config = (max: number): string =>
  `import { defineConfig } from 'codemaster';\n` +
  `export default defineConfig({ ts: { searchWarmMaxFiles: ${max} } });\n`;

// Two importers of src/a.ts so find_usages/importers_of have real fan-out to do (were the guard off).
const FILES = (max: number): Record<string, string> => ({
  'codemaster.config.ts': config(max),
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/a.ts': 'export const Widget = 1;\n',
  'src/b.ts': "import { Widget } from './a';\nexport const b = Widget + 1;\n",
  'src/c.ts': "import { Widget } from './a';\nexport const c = Widget + 2;\n",
});

const refused = (r: OpResult): boolean =>
  'result' in r && !r.result.ok && r.result.failure.tool === 'size-guard';
const ok = (r: OpResult): boolean => 'result' in r && r.result.ok;

async function tsFingerprint(p: Awaited<ReturnType<typeof project>>): Promise<string | undefined> {
  const status = await p.orchestrator.status(p.root, p.root);
  return status.workspace?.plugins.find((x) => x.id === 'ts')?.fingerprint;
}

// The react / react-query fan-out ops need their plugins ACTIVE (autodetected from package.json
// deps), else the op is `unavailable` rather than refused. The guard still fires at the top of run().
const REACT_FILES = (max: number): Record<string, string> => ({
  'codemaster.config.ts': config(max),
  'package.json': JSON.stringify({
    dependencies: { react: '18', '@tanstack/react-query': '5' },
  }),
  'tsconfig.json': '{"compilerOptions":{"strict":true,"jsx":"react-jsx","module":"preserve"}}',
  'src/App.tsx': 'export const App = ({ userId }: { userId: string }) => <div>{userId}</div>;\n',
});

test('over threshold, in-process: find_unused_exports REFUSES + redirects, LS stays COLD', async () => {
  const p = await project(FILES(1));
  try {
    const res = await p.op('find_unused_exports', {});
    assert.ok(
      refused(res),
      `find_unused_exports must refuse over threshold: ${JSON.stringify(res)}`,
    );
    if ('result' in res && !res.result.ok) {
      const msg = res.result.failure.message;
      assert.match(msg, /IN-PROCESS/, 'names the risky mode');
      assert.match(msg, /process-host factory/, 'names the actual cause (t-754922)');
    }
    assert.equal(await tsFingerprint(p), 'cold', 'a refused dead-export scan must not warm the LS');
  } finally {
    await p.dispose();
  }
});

test('find_unused_exports force:true does NOT bypass the guard over threshold', async () => {
  const p = await project(FILES(1));
  try {
    const res = await p.op('find_unused_exports', { force: true });
    assert.ok(refused(res), `force:true must still refuse: ${JSON.stringify(res)}`);
    assert.equal(await tsFingerprint(p), 'cold', 'a forced refusal must not warm the LS');
  } finally {
    await p.dispose();
  }
});

test('below threshold: find_unused_exports runs normally (no false refusal)', async () => {
  const p = await project(FILES(100));
  try {
    const res = await p.op('find_unused_exports', {});
    assert.ok(ok(res), `under threshold must not refuse: ${JSON.stringify(res)}`);
  } finally {
    await p.dispose();
  }
});

test("over threshold, in-process: list of a ts-DEPENDENT registry ('components') REFUSES, LS stays COLD", async () => {
  const p = await project(REACT_FILES(1));
  try {
    const res = await p.op('list', { registry: 'components' });
    assert.ok(refused(res), `list components must refuse over threshold: ${JSON.stringify(res)}`);
    if ('result' in res && !res.result.ok) {
      assert.match(
        res.result.failure.message,
        /process-host factory/,
        'names the actual cause (t-754922)',
      );
    }
    assert.equal(await tsFingerprint(p), 'cold', 'a refused registry listing must not warm the LS');
  } finally {
    await p.dispose();
  }
});

test('list force:true does NOT bypass the guard; an UNRESOLVED registry still answers before the guard can fire', async () => {
  const p = await project(REACT_FILES(1));
  try {
    const forced = await p.op('list', { registry: 'components', force: true });
    assert.ok(refused(forced), `force:true must still refuse: ${JSON.stringify(forced)}`);
    // Ordering discriminant: the guard sits AFTER owner resolution, so an unowned registry returns
    // the honest available-list even over threshold — a blanket refusal at the top of run() would
    // replace that did-you-mean with a size-guard failure. (Note: every registry SHIPPING today is
    // owned by a ts-DEPENDENT plugin — react / react-query — so the ts-dependence predicate's
    // negative branch has no live registry to exercise; this covers the reachable half.)
    const unowned = await p.op('list', { registry: 'no_such_registry' });
    assert.ok(
      ok(unowned),
      `an unowned registry must answer, not refuse: ${JSON.stringify(unowned)}`,
    );
  } finally {
    await p.dispose();
  }
});

test('below threshold: list components runs normally (no false refusal)', async () => {
  const p = await project(REACT_FILES(100));
  try {
    const res = await p.op('list', { registry: 'components' });
    assert.ok(ok(res), `under threshold must not refuse: ${JSON.stringify(res)}`);
  } finally {
    await p.dispose();
  }
});

// The scss plugin activates on a stylesheet being present; the op `requires: ['ts','scss']`, so the
// fixture needs both a module sheet and a TS importer of it (else the op is `unavailable`, not refused).
const SCSS_FILES = (max: number): Record<string, string> => ({
  'codemaster.config.ts': config(max),
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/a.module.scss': '.used { color: red; }\n.dead { color: blue; }\n',
  'src/a.ts': "import s from './a.module.scss';\nexport const cls = s.used;\n",
});

test('over threshold, in-process: find_unused_scss_classes REFUSES + redirects, LS stays COLD', async () => {
  const p = await project(SCSS_FILES(1));
  try {
    const res = await p.op('find_unused_scss_classes', {});
    assert.ok(
      refused(res),
      `find_unused_scss_classes must refuse over threshold: ${JSON.stringify(res)}`,
    );
    if ('result' in res && !res.result.ok) {
      const msg = res.result.failure.message;
      assert.match(msg, /IN-PROCESS/, 'names the risky mode');
      assert.match(msg, /process-host factory/, 'names the actual cause (t-754922)');
    }
    assert.equal(await tsFingerprint(p), 'cold', 'a refused scss reachability join must not warm');
  } finally {
    await p.dispose();
  }
});

test('find_unused_scss_classes force:true does NOT bypass the guard; below threshold it answers', async () => {
  const forced = await project(SCSS_FILES(1));
  try {
    const res = await forced.op('find_unused_scss_classes', { force: true });
    assert.ok(refused(res), `force:true must still refuse: ${JSON.stringify(res)}`);
  } finally {
    await forced.dispose();
  }
  const under = await project(SCSS_FILES(100));
  try {
    const res = await under.op('find_unused_scss_classes', {});
    assert.ok(ok(res), `under threshold must not refuse: ${JSON.stringify(res)}`);
  } finally {
    await under.dispose();
  }
});

test('below threshold: the remaining ops run normally (no false refusal)', async () => {
  const p = await project(REACT_FILES(100));
  try {
    const res = await p.op('trace_field_to_render', { field: 'userId' });
    assert.ok(!refused(res), `under threshold must not refuse: ${JSON.stringify(res)}`);
  } finally {
    await p.dispose();
  }
});
