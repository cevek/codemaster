// Full-verbosity density sweep (§12). The recurring regression: a list/verdict op rendered at
// `verbosity:'full'` EXPLODES into watery multi-line `key=value` blocks instead of dense one-liners
// (the `css_cascade … --verbosity full` repro). The root fix inverts the default — `FULL_DISPOSITION`
// collapses every tag at full EXCEPT the proof-bearing `symbol` — so this guards the whole live-op
// pipeline at full, not just the synthetic per-tag rows (output-density-tags.test.ts).
//
// Oracle (discriminating, NOT golden): the structural explosion detectors (`fallThrough` /
// `topLevelExplosion` from helpers/density.ts) + a `[object Object]` scan — a renderer that reaches a
// span via raw `String(v['span'])` collapses to one line but stringifies the verbatim span OBJECT as
// `[object Object]`, which the explosion guards alone miss. Plus a positive denseness assertion per
// op (the row's identity is still present, not over-collapsed away). The CONTROL half proves we did
// not collapse the proof body that full EXISTS to show: find_definition / source full still carry the
// verbatim declaration, expand_type full still lists its (dense) signatures.
//
// This test FAILS on the pre-inversion code: css_cascade / find_unused_exports / scss_classes etc.
// passed their rows verbatim at full and exploded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { fallThrough, topLevelExplosion, leakedTag } from '../helpers/density.ts';
import { renderResult } from '../../src/format/render/render-result.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

const FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/button.module.scss':
    '.default {\n  color: red;\n  padding: 4px;\n}\n' +
    '.default:hover {\n  color: blue;\n}\n' +
    '.unusedClass {\n  color: green;\n}\n',
  'src/lib.ts':
    "import styles from './button.module.scss';\n" +
    'export const helper = (x: number) => x + 1;\n' +
    'export const unusedThing = 42;\n' +
    'export const cls = styles.default;\n',
  'src/app.ts':
    "import { helper } from './lib';\nexport const run = () => helper(1) + helper(2);\n",
};

async function renderFull(p: Awaited<ReturnType<typeof project>>, name: string, args: object) {
  const r: OpResult = await p.op(name, args as never);
  assert.ok('result' in r, `${name}: dispatch produced a result (got ${JSON.stringify(r)})`);
  assert.ok(r.result.ok, `${name}: op succeeded`);
  return renderResult(r.result, 'full');
}

/** A collapse-disposition op's full render must carry NO explosion, NO leaked tag, NO `[object
 *  Object]`. Applied to ops whose every row is collapse-disposition (no verbatim `symbol` subfield). */
function assertDense(out: string, name: string): void {
  assert.equal(fallThrough(out), undefined, `${name} full: a bulleted row exploded:\n${out}`);
  assert.equal(
    topLevelExplosion(out),
    undefined,
    `${name} full: a top-level row exploded:\n${out}`,
  );
  assert.equal(leakedTag(out), undefined, `${name} full: a ~shape tag leaked:\n${out}`);
  assert.ok(!out.includes('[object Object]'), `${name} full: stringified an object:\n${out}`);
}

// ── The collapse-disposition ops: dense at full, every tag collapsed. ──────────────────────────
test('css_cascade at full is dense (the repro) — verdict + rules collapse, no key=value explosion', async () => {
  const p = await project(FILES);
  try {
    const out = await renderFull(p, 'css_cascade', {
      file: 'src/button.module.scss',
      class: 'default',
    });
    assertDense(out, 'css_cascade');
    // Positive: the per-property verdict is a one-liner with its winning value, not an exploded block.
    assert.match(out, /color: \[0,2,0\] .*:hover = blue/, 'cascade property verdict one-liner');
    assert.match(out, /padding: \[0,1,0\] .* = 4px/, 'second property one-liner');
    assert.doesNotMatch(out, /\n\s+winner:/, 'no exploded `winner:` block (the repro signature)');
    assert.doesNotMatch(out, /\n\s+specificity=/, 'no exploded `specificity=` field');
  } finally {
    await p.dispose();
  }
});

test('find_unused_exports / scss_classes / find_unused_scss_classes / construction_sites / importers_of are dense at full', async () => {
  const p = await project(FILES);
  try {
    const unused = await renderFull(p, 'find_unused_exports', { pathInclude: ['src/lib.ts'] });
    assertDense(unused, 'find_unused_exports');
    assert.match(unused, /unusedThing@src\/lib\.ts.* · const/, 'unused export one-liner');

    const classes = await renderFull(p, 'scss_classes', { file: 'src/button.module.scss' });
    assertDense(classes, 'scss_classes');
    // Over-collapse guard: the class NAME must survive at full (spanLoc drops the span's `.default`
    // proof text, so the name must come through as its own field — not vanish to a bare loc).
    assert.match(classes, /button\.module\.scss:1:1 · default/, 'scss class name present at full');

    const unusedScss = await renderFull(p, 'find_unused_scss_classes', {});
    assertDense(unusedScss, 'find_unused_scss_classes');
    assert.match(unusedScss, /unusedClass/, 'unused scss class name present');

    const sites = await renderFull(p, 'construction_sites', { name: 'helper' });
    assertDense(sites, 'construction_sites');

    const importers = await renderFull(p, 'importers_of', { module: 'src/lib.ts' });
    assertDense(importers, 'importers_of');
    assert.match(importers, /src\/app\.ts:1 · helper/, 'importer one-liner');
  } finally {
    await p.dispose();
  }
});

// ── find_usages: usages are collapse, the `definition` is the verbatim symbol exception. ────────
test('find_usages at full — usage rows are dense one-liners (the definition body is the only verbatim part)', async () => {
  const p = await project(FILES);
  try {
    const out = await renderFull(p, 'find_usages', { name: 'helper' });
    // Global object-stringify guard holds even though the definition passes verbatim.
    assert.ok(!out.includes('[object Object]'), `find_usages full stringified an object:\n${out}`);
    // The usage LIST is dense: each usage is `loc · role`, never an exploded `role=` / `confidence=`
    // block (the pre-inversion shape). The verbatim `definition` carries no usage `role`, so these
    // negatives can't false-trip on it.
    assert.match(out, /src\/app\.ts:2:\d+ · call/, 'a usage renders as a dense one-liner');
    assert.doesNotMatch(out, /\n\s+role=/, 'no exploded usage `role=` field');
    assert.doesNotMatch(out, /\n\s+confidence=certain/, 'no exploded usage `confidence=` field');
  } finally {
    await p.dispose();
  }
});

// ── CONTROL: the proof body full EXISTS to show must NOT have been collapsed away. ──────────────
test('CONTROL — find_definition / source at full still carry the verbatim declaration body', async () => {
  const p = await project(FILES);
  try {
    const def = await renderFull(p, 'find_definition', { name: 'helper' });
    assert.match(
      def,
      /export const helper = \(x: number\) => x \+ 1;/,
      'find_definition full shows the verbatim decl body',
    );
    const src = await renderFull(p, 'source', { targets: [{ name: 'helper' }] });
    assert.match(
      src,
      /export const helper = \(x: number\) => x \+ 1;/,
      'source full shows the verbatim decl body',
    );
  } finally {
    await p.dispose();
  }
});

test('CONTROL — expand_type at full lists its signatures densely (members present, not collapsed away)', async () => {
  const p = await project(FILES);
  try {
    const out = await renderFull(p, 'expand_type', { name: 'helper' });
    assert.match(out, /\(x: number\): number/, 'the signature is present and dense at full');
  } finally {
    await p.dispose();
  }
});
