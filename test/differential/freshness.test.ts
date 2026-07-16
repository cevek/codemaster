// §16 invariant 2 — per-plugin freshness honesty, watcher silenced: after a mutate,
// an ADD (the omitted-file case an answer-scoped check would miss), and a
// `git checkout`, every answer must be reindexed-correct or carry a FreshnessNote —
// never silent-stale. The oracle is the file content we just wrote.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, utimesSync } from 'node:fs';
import * as path from 'node:path';
import { project, assertSpansValid } from '../helpers/project.ts';
import { fail } from '../../src/common/result/construct.ts';
import { renderResult } from '../../src/format/render/render-result.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"jsx":"react-jsx"}}';
const I18N_CONFIG =
  `import { defineConfig } from 'codemaster';\n` +
  `export default defineConfig({ i18n: { locales: ['locales/*.json'], functions: ['t'] } });\n`;

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
    p.commit('two modules');
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

test('ts in-place mutation: an edited declaration is reindexed on read (not only adds)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/dto.ts': 'export interface U { a: string }\n',
  });
  try {
    const before = await p.op('expand_type', { name: 'U' });
    assert.ok('result' in before && before.result.ok);
    assert.deepEqual(
      ((before.result.data as { members?: { name: string }[] }).members ?? []).map((m) => m.name),
      ['a'],
    );

    // Edit the SAME file in place (no add, no remove) — the case beyond the existing add test.
    p.write('src/dto.ts', 'export interface U { a: string; b: number }\n');
    const after = await p.op('expand_type', { name: 'U' });
    assert.ok('result' in after && after.result.ok);
    assert.deepEqual(
      ((after.result.data as { members?: { name: string }[] }).members ?? []).map((m) => m.name),
      ['a', 'b'],
      'an in-place edit must be reindexed on read, never served stale',
    );
    assertSpansValid(p.root, after);
  } finally {
    await p.dispose();
  }
});

test('bulk checkout touching many files is picked up wholesale (rebase/stash shape)', async () => {
  const files: Record<string, string> = { 'tsconfig.json': TSCONFIG };
  for (let i = 0; i < 5; i++) files[`src/m${i}.ts`] = `export const v${i} = ${i};\n`;
  const p = await project(files);
  const count = (r: Awaited<ReturnType<typeof p.op>>): number => {
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    return (r.result.data as { matches?: unknown[] }).matches?.length ?? 0;
  };
  try {
    assert.ok(count(await p.op('search_symbol', { query: 'v0' })) >= 1, 'v0 present initially');

    // A second commit that rewrites every file at once, then check it back out — the
    // bulk multi-file swap fs.watch silently drops; the repo-global check must catch it.
    for (let i = 0; i < 5; i++) p.write(`src/m${i}.ts`, `export const w${i} = ${i};\n`);
    p.commit('rename all');
    p.git('checkout', '-q', '-b', 'alt', 'HEAD~1');

    assert.ok(
      count(await p.op('search_symbol', { query: 'v0' })) >= 1,
      'after checkout, the reverted symbols are visible again (bulk change reindexed)',
    );
    assert.equal(
      count(await p.op('search_symbol', { query: 'w0' })),
      0,
      'the checked-out-away symbols are gone (no stale carry-over from the other branch)',
    );
  } finally {
    await p.dispose();
  }
});

test('i18n keys reflect a real git checkout (per-plugin freshness, watcher silenced)', async () => {
  // Initial commit has NO `extra`; a branch adds it. We query on the branch (baseline),
  // then `git checkout` back — the i18n plugin must reindex the locale swap on read.
  const p = await project({
    'codemaster.config.ts': I18N_CONFIG,
    'tsconfig.json': TSCONFIG,
    'locales/en.json': JSON.stringify({ greeting: 'Hi' }, null, 2),
    'src/app.ts': `const t = (k: string): string => k;\nexport const a = t('greeting');\n`,
  });
  const defs = (r: Awaited<ReturnType<typeof p.op>>): number => {
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    return (r.result.data as { defs?: unknown[] }).defs?.length ?? 0;
  };
  try {
    // Branch `withextra` adds the key and commits it.
    p.git('checkout', '-q', '-b', 'withextra');
    p.write('locales/en.json', JSON.stringify({ greeting: 'Hi', extra: 'x' }, null, 2));
    p.commit('add extra');
    assert.ok(
      defs(await p.op('i18n_lookup', { key: 'extra' })) >= 1,
      '`extra` present on the branch',
    );

    // Check the original (no-extra) branch back out — a real checkout, watcher silent.
    p.git('checkout', '-q', '-');
    assert.equal(
      defs(await p.op('i18n_lookup', { key: 'extra' })),
      0,
      'the i18n plugin reindexed the checkout on read — `extra` is gone',
    );
  } finally {
    await p.dispose();
  }
});

test('re-dirtied tracked file: the second edit is NOT lost under apply+dirtyOk (git mode, §3.5)', async () => {
  // Warm daemon, watcher silenced, git mode. A tracked+committed file is edited TWICE with no
  // reindex between. `git status --porcelain` shows ` M src/m.ts` BOTH times, so the
  // (head, porcelain) fingerprint is IDENTICAL — the program would stay stale at edit-1. A
  // refactor reads `before` from that warm program and writes `after = before + edits` over the
  // whole file, so apply+dirtyOk silently overwrites edit-2. The fix catches the re-dirty by
  // content and reindexes the path. Oracle: the distinctive marker we wrote in edit-2, far from
  // the renamed symbol — independent of the warm LS that performs the rename.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/m.ts': 'export const oldName = 1;\n// V0\n',
  });
  const onDisk = (): string => readFileSync(path.join(p.root, 'src/m.ts'), 'utf8');
  try {
    // Edit 1 dirties the tracked file (clean → ` M`): the porcelain changes, so this edit IS
    // reindexed on the next read. Warm the program at edit-1.
    p.write('src/m.ts', 'export const oldName = 1;\n// EDIT1\n');
    const warm = await p.op('find_definition', { name: 'oldName' });
    assert.ok('result' in warm && warm.result.ok);

    // Edit 2 re-dirties the SAME file (` M` → ` M`, porcelain UNCHANGED) with a distinctive
    // marker the rename never touches.
    p.write('src/m.ts', 'export const oldName = 1;\n// EDIT2_DISTINCTIVE_MARKER\n');

    // Rename under apply+dirtyOk — the destructive path; the op rewrites the whole file.
    const [r] = await p.request([
      {
        name: 'rename_symbol',
        args: { name: 'oldName', newName: 'newName', dirtyOk: true },
        apply: true,
      },
    ]);
    assert.ok(
      r !== undefined && 'result' in r && r.result.ok,
      `rename apply failed: ${JSON.stringify(r)}`,
    );

    const result = onDisk();
    assert.match(result, /newName/, 'the rename transform was applied');
    assert.match(
      result,
      /EDIT2_DISTINCTIVE_MARKER/,
      'the second edit must survive — never overwritten by a stale-program plan (§3.5 data loss)',
    );
    assert.doesNotMatch(result, /EDIT1\b/, 'the stale edit-1 content must not be resurrected');
  } finally {
    await p.dispose();
  }
});

test('racy-clean mtime tie is resolved by content end-to-end (§19, mtime-walk mode)', async () => {
  // Force the non-git mtime fallback (the only path the racy-clean rule lives on) by
  // failing every git call. Then make a SAME-SIZE edit with the file's mtime pinned so the
  // size+mtime fingerprint is identical across reads — the comparator must answer 'tie' and
  // hash content, catching the change. A 'same' verdict here would be the §19 silent-stale
  // lie (a same-tick edit hiding behind an unchanged stamp on a coarse-mtime filesystem).
  const p = await project(
    { 'tsconfig.json': TSCONFIG, 'src/a.module.scss': '.one { color: red; }\n' },
    {
      gitRunner: (_cwd, _args) =>
        Promise.resolve(fail({ tool: 'git', message: 'forced mtime mode' })),
    },
  );
  const pin = (rel: string): void => {
    // mtime = 1000s = 1_000_000ms, equal to the manual clock's `now` → the record sits
    // exactly inside the resolution window of the mtime, i.e. the racy-clean tie.
    utimesSync(path.join(p.root, rel), 1000, 1000);
  };
  try {
    pin('src/a.module.scss');
    const first = await p.op('scss_classes', {});
    assert.ok('result' in first && first.result.ok);
    assert.deepEqual(
      (first.result.data as { classes: { name: string }[] }).classes.map((c) => c.name),
      ['one'],
    );

    // `.one` → `.two`: identical byte length, so size is unchanged; pin mtime back to the
    // same value → only a content hash can tell them apart.
    p.write('src/a.module.scss', '.two { color: red; }\n');
    pin('src/a.module.scss');
    // The non-git mtime-walk is debounced (§1: no per-op repo-scale re-walk); advance past the
    // window so this op re-walks. The racy-clean tie itself is unaffected — it is fixed by the
    // FIRST walk's recorded-at-vs-mtime distance, not by when the second walk runs (§19).
    p.clock.advance(1001);
    const second = await p.op('scss_classes', {});
    assert.ok('result' in second && second.result.ok);
    assert.deepEqual(
      (second.result.data as { classes: { name: string }[] }).classes.map((c) => c.name),
      ['two'],
      'the same-size, same-mtime edit was caught by hashing on tie — never served stale',
    );
  } finally {
    await p.dispose();
  }
});
