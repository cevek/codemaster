// §16 invariant 2 — per-plugin freshness honesty, watcher silenced: after a mutate,
// an ADD (the omitted-file case an answer-scoped check would miss), and a
// `git checkout`, every answer must be reindexed-correct or carry a FreshnessNote —
// never silent-stale. The oracle is the file content we just wrote.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, assertSpansValid } from '../helpers/project.ts';
import { renderResult } from '../../src/format/render/render-result.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"jsx":"react-jsx"}}';

test('scss answers reflect on-disk mutations with no watcher (read-time backstop §3.5)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/a.module.scss': '.one { color: red; }\n',
    'src/use.ts': `import s from './a.module.scss'; export const x = s;\n`,
  });
  try {
    const first = await p.op('scss_classes', {});
    assert.ok('result' in first && first.result.ok);
    const names = (first.result.data as { classes: { name: string }[] }).classes.map((c) => c.name);
    assert.deepEqual(names, ['one']);

    // 1) mutate an existing file — silently, no watcher running
    p.write('src/a.module.scss', '.one { color: red; }\n.two { color: blue; }\n');
    const second = await p.op('scss_classes', {});
    assert.ok('result' in second && second.result.ok);
    const names2 = (second.result.data as { classes: { name: string }[] }).classes.map(
      (c) => c.name,
    );
    assert.deepEqual(names2.sort(), ['one', 'two'], 'mutated file must be reindexed on read');

    // 2) ADD a file a find-all answer must include — the omitted-file lie test
    p.write('src/b.module.scss', '.three { color: green; }\n');
    const third = await p.op('scss_classes', {});
    assert.ok('result' in third && third.result.ok);
    const names3 = (third.result.data as { classes: { name: string }[] }).classes.map(
      (c) => c.name,
    );
    assert.ok(names3.includes('three'), 'added file must appear in find-all (no undercount)');
    assertSpansValid(p.root, third);

    // 3) git checkout to a branch with different content — the bulk-change case
    p.git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
    p.git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'two modules');
    p.git('checkout', '-q', '-b', 'alt', 'HEAD~1');
    const fourth = await p.op('scss_classes', {});
    assert.ok('result' in fourth && fourth.result.ok);
    const names4 = (fourth.result.data as { classes: { name: string }[] }).classes.map(
      (c) => c.name,
    );
    assert.deepEqual(names4, ['one'], 'checkout must be picked up by the repo-global check');
  } finally {
    await p.dispose();
  }
});

test('reindex-at-entry is reported even in terse; a clean query stays silent (§1.3)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/a.module.scss': '.one { color: red; }\n',
    'src/use.ts': `import s from './a.module.scss'; export const x = s;\n`,
  });
  try {
    // A clean query reindexes nothing → no freshness line at all in terse (a default
    // filter must never read as completeness, and a clean answer must not invent noise).
    const clean = await p.op('scss_classes', {});
    assert.ok('result' in clean && clean.result.ok);
    assert.equal(clean.result.freshness?.reindexed, undefined, 'clean query reindexes nothing');
    assert.doesNotMatch(
      renderResult(clean.result, 'terse'),
      /freshness:/,
      'a clean terse query carries no freshness line',
    );

    // Mutate silently (watcher is nullWatcher), then query: the read-time backstop catches
    // the drift, reindexes at entry, and must SAY it did — even in terse.
    p.write('src/a.module.scss', '.one { color: red; }\n.two { color: blue; }\n');
    const after = await p.op('scss_classes', {});
    assert.ok('result' in after && after.result.ok);
    assert.ok(
      (after.result.freshness?.reindexed ?? 0) >= 1,
      'a drift-triggered reindex must record a reindexed count',
    );
    assert.match(
      renderResult(after.result, 'terse'),
      /freshness: reindexed \d+ file\(s\) at entry/,
      'the reindex-at-entry line survives terse',
    );
  } finally {
    await p.dispose();
  }
});

test('ts answers reflect mutations: a new usage appears without a watcher', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/util.ts': 'export const twice = (n: number) => n * 2;\n',
    'src/a.ts': `import { twice } from './util.ts';\nexport const a = twice(1);\n`,
  });
  try {
    const before = await p.op('find_usages', { name: 'twice' });
    assert.ok('result' in before && before.result.ok);
    const files = (before.result.data as { usages: { span: { file: string } }[] }).usages.map(
      (u) => u.span.file,
    );
    assert.ok(files.includes('src/a.ts'));
    assert.ok(!files.includes('src/b.ts'));

    p.write('src/b.ts', `import { twice } from './util.ts';\nexport const b = twice(2);\n`);
    const after = await p.op('find_usages', { name: 'twice' });
    assert.ok('result' in after && after.result.ok);
    const filesAfter = (after.result.data as { usages: { span: { file: string } }[] }).usages.map(
      (u) => u.span.file,
    );
    assert.ok(
      filesAfter.includes('src/b.ts'),
      'usage in a file ADDED after warm-up must be found (omitted-file honesty)',
    );
    assertSpansValid(p.root, after);
  } finally {
    await p.dispose();
  }
});
