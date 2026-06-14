// Stage 4 end-to-end oracle (spec-css-coextract §4) — extract a component whose sibling
// stylesheet mixes provably-safe classes with unsafe ones (compound, @extend, nested) and a
// class still used by the source remainder. Oracles are INDEPENDENT of the code under test:
//   - the moved set is EXACTLY the provably-safe classes (cold reparse of both sheets);
//   - the new sheet holds them, the source sheet keeps the rest;
//   - the extracted .tsx imports both `s` (new sheet) and `sLegacy` (old) with left refs on it;
//   - the project's own TS compiles the result clean (post-apply), since scss is type-blind;
//   - the per-class report codes match a hand classification.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import type { JsonValue } from '../../src/core/json.ts';
import { project } from '../helpers/project.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"module":"preserve","jsx":"preserve"}}';
const SCSS_D =
  "declare module '*.module.scss' { const s: { [k: string]: string }; export default s; }";
const JSX_D =
  'declare namespace JSX { interface Element {} interface IntrinsicElements { [e: string]: unknown } }';

function coldTscErrors(root: string): string[] {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  if (configPath === undefined) return ['no tsconfig'];
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, ts.sys.readFile).config,
    ts.sys,
    path.dirname(configPath),
  );
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

type SpanLike = {
  file: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  text: string;
};
type Report = {
  sourceStylesheet: string;
  targetStylesheet: string;
  moved: string[];
  leftBehind: { class: string; code: string; span?: SpanLike }[];
};

// Independent span oracle (§16 inv.1 / spec-scss-css-honesty Stage 4): the source substring at
// the span's [line,col]→[endLine,endCol] (1-based, end-exclusive) must equal span.text.
function spanIsValid(source: string, span: SpanLike): boolean {
  const lines = source.split('\n');
  if (span.endLine !== span.line) return false;
  return (lines[span.line - 1] ?? '').slice(span.col - 1, span.endCol - 1) === span.text;
}
type Envelope = {
  mode: string;
  applied?: boolean;
  typecheck: { clean: boolean };
  cssCoExtract?: Report[];
};

async function run(
  files: Record<string, string>,
  args: JsonValue,
): Promise<{
  env: Envelope;
  root: string;
  read: (rel: string) => string;
  dispose: () => Promise<void>;
}> {
  const p = await project(files);
  const [r] = await p.request([{ name: 'extract_symbol', args, apply: true }]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return {
    env: r.result.data as unknown as Envelope,
    root: p.root,
    read: (rel) => readFileSync(path.join(p.root, rel), 'utf8'),
    dispose: () => p.dispose(),
  };
}

test('co-extract moves exactly the provably-safe classes, leaves & reports the rest', async () => {
  const scss =
    '.card { color: red; }\n' + // safe (owned, clean)
    '.title { font-weight: bold; }\n' + // USED by remainder
    '.badge { padding: 2px; }\n' + // safe, but entangled below → COMPOUND
    '.badge.active { padding: 4px; }\n' +
    '.promo { @extend .card; }\n'; // makes .card EXTEND-unsafe
  const tsx =
    "import s from './Panel.module.scss';\n" +
    'export const Card = (): JSX.Element => (\n' +
    '  <div className={s.card}><span className={s.badge} /></div>\n' +
    ');\n' +
    'export const Panel = (): JSX.Element => <h2 className={s.title} />;\n';
  const { env, root, read, dispose } = await run(
    {
      'tsconfig.json': TSCONFIG,
      'src/scss.d.ts': SCSS_D,
      'src/jsx.d.ts': JSX_D,
      'src/feature/Panel.module.scss': scss,
      'src/feature/Panel.tsx': tsx,
    },
    { name: 'Card', dest: 'src/widgets/Card.tsx', css: 'copy-safe' },
  );
  try {
    assert.equal(env.mode, 'applied');
    assert.equal(env.applied, true);
    assert.equal(env.typecheck.clean, true);

    // The extracted block references s.card + s.badge. .card is unsafe (EXTEND), .badge is
    // unsafe (COMPOUND) → nothing is provably safe here, everything stays.
    const report = (env.cssCoExtract ?? []).find((r) =>
      r.sourceStylesheet.endsWith('Panel.module.scss'),
    );
    assert.ok(report !== undefined, `expected a report, got ${JSON.stringify(env.cssCoExtract)}`);
    assert.deepEqual(report.moved.sort(), []);
    const codes = Object.fromEntries(report.leftBehind.map((l) => [l.class, l.code]));
    assert.equal(codes.card, 'EXTEND');
    assert.equal(codes.badge, 'COMPOUND');

    // Stage 4 (§3.2): each spanned left-behind reason carries a proof span into the SOURCE
    // sheet whose text equals the class's declaration there — verifiable without a re-grep.
    const sheet = read('src/feature/Panel.module.scss');
    const byClass = new Map(report.leftBehind.map((l) => [l.class, l]));
    for (const cls of ['card', 'badge']) {
      const entry = byClass.get(cls);
      assert.ok(entry !== undefined, `${cls} must be left behind`);
      const span = entry.span;
      assert.ok(span !== undefined, `${cls} (${entry.code}) must carry a proof span`);
      assert.ok(span.file.endsWith('Panel.module.scss'), 'span points at the source sheet');
      assert.ok(spanIsValid(sheet, span), `${cls} span text must match the source`);
      assert.equal(span.text, `.${cls}`, 'span covers the class declaration token');
    }

    // Type-blind correctness: the compile is clean and the source sheet is untouched.
    assert.deepEqual(coldTscErrors(root), []);
    assert.match(read('src/feature/Panel.module.scss'), /\.card/);
  } finally {
    await dispose();
  }
});

test('co-extract: a clean safe class moves to a new sheet; the extracted file repoints', async () => {
  const scss = '.card { color: red; }\n.shared { margin: 0; }\n'; // both owned & clean
  const tsx =
    "import s from './Panel.module.scss';\n" +
    'export const Card = (): JSX.Element => <div className={s.card} />;\n' +
    'export const Panel = (): JSX.Element => <section className={s.shared} />;\n';
  const { env, root, read, dispose } = await run(
    {
      'tsconfig.json': TSCONFIG,
      'src/scss.d.ts': SCSS_D,
      'src/jsx.d.ts': JSX_D,
      'src/feature/Panel.module.scss': scss,
      'src/feature/Panel.tsx': tsx,
    },
    { name: 'Card', dest: 'src/widgets/Card.tsx', css: 'copy-safe' },
  );
  try {
    assert.equal(env.applied, true);
    assert.equal(env.typecheck.clean, true);

    const report = (env.cssCoExtract ?? [])[0];
    assert.ok(report !== undefined);
    assert.deepEqual(report.moved, ['card']); // only the extracted block's class moves
    assert.match(report.targetStylesheet, /widgets\/Card\.module\.scss$/);

    // New sheet holds .card; source sheet keeps .shared and drops .card (cold reparse oracle).
    const newSheet = read('src/widgets/Card.module.scss');
    const srcSheet = read('src/feature/Panel.module.scss');
    assert.match(newSheet, /\.card/);
    assert.doesNotMatch(newSheet, /\.shared/);
    assert.doesNotMatch(srcSheet, /\.card/);
    assert.match(srcSheet, /\.shared/);

    // The extracted file imports the NEW sheet; no Legacy import needed (nothing left behind).
    const card = read('src/widgets/Card.tsx');
    assert.match(card, /import s from ["']\.\/Card\.module\.scss["']/);
    assert.doesNotMatch(card, /Legacy/);

    assert.deepEqual(coldTscErrors(root), []); // type-blind correctness, verified structurally
  } finally {
    await dispose();
  }
});

test('co-extract: a class still used by the remainder stays behind on an sLegacy import', async () => {
  // The extracted block uses BOTH .card (safe) and .title; .title is ALSO used by the
  // remaining Panel → it must stay, and the extracted file references it via sLegacy.
  const scss = '.card { color: red; }\n.title { font-weight: bold; }\n';
  const tsx =
    "import s from './Panel.module.scss';\n" +
    'export const Card = (): JSX.Element => (\n' +
    '  <div className={s.card}><span className={s.title} /></div>\n' +
    ');\n' +
    'export const Panel = (): JSX.Element => <h2 className={s.title} />;\n';
  const { env, read, dispose } = await run(
    {
      'tsconfig.json': TSCONFIG,
      'src/scss.d.ts': SCSS_D,
      'src/jsx.d.ts': JSX_D,
      'src/feature/Panel.module.scss': scss,
      'src/feature/Panel.tsx': tsx,
    },
    { name: 'Card', dest: 'src/widgets/Card.tsx', css: 'copy-safe' },
  );
  try {
    assert.equal(env.applied, true);
    assert.equal(env.typecheck.clean, true);
    const report = (env.cssCoExtract ?? [])[0];
    assert.ok(report !== undefined);
    assert.deepEqual(report.moved, ['card']);
    const titleEntry = report.leftBehind.find((l) => l.class === 'title');
    assert.equal(titleEntry?.code, 'USED');
    // USED is a TS-usage reason, not a sheet location → no span fabricated (§3.2).
    assert.equal(titleEntry?.span, undefined, 'a USED entry carries no sheet span');

    const card = read('src/widgets/Card.tsx');
    assert.match(card, /import s from ["']\.\/Card\.module\.scss["']/);
    assert.match(card, /import sLegacy from ["']\.\.\/feature\/Panel\.module\.scss["']/);
    assert.match(card, /sLegacy\.title/); // left-behind ref repointed
    assert.match(card, /s\.card/); // moved ref untouched
  } finally {
    await dispose();
  }
});

test('co-extract: a new sheet that would collide with the SOURCE sheet is disambiguated', async () => {
  // Extract `Box` to src/Box.tsx; the source sheet is src/Box.module.scss. The default new
  // sheet name (Box.module.scss, beside Box.tsx) would BE the source sheet → must disambiguate,
  // never clobber it on commit.
  const tsx =
    "import s from './Box.module.scss';\n" +
    'export const Box = (): JSX.Element => <div className={s.inner} />;\n' +
    'export const Panel = (): JSX.Element => <section className={s.outer} />;\n';
  const { env, read, dispose } = await run(
    {
      'tsconfig.json': TSCONFIG,
      'src/scss.d.ts': SCSS_D,
      'src/jsx.d.ts': JSX_D,
      'src/Box.module.scss': '.inner { color: red; }\n.outer { margin: 0; }\n',
      'src/Panel.tsx': tsx,
    },
    { name: 'Box', dest: 'src/Box.tsx', css: 'copy-safe' },
  );
  try {
    assert.equal(env.applied, true);
    assert.equal(env.typecheck.clean, true);
    const report = (env.cssCoExtract ?? [])[0];
    assert.ok(report !== undefined);
    assert.deepEqual(report.moved, ['inner']);
    assert.notEqual(report.targetStylesheet, 'src/Box.module.scss'); // not the source sheet
    // The source sheet survives intact with its remaining class.
    assert.match(read('src/Box.module.scss'), /\.outer/);
    assert.doesNotMatch(read('src/Box.module.scss'), /\.inner/);
  } finally {
    await dispose();
  }
});

test('co-extract: two distinct sibling sheets sharing a class name go to DISTINCT new sheets', async () => {
  // The extracted block uses a.box AND b.box — `box` is declared in BOTH sheets with different
  // styles. Collapsing them into one new file would silently alias the two definitions
  // (type-blind). They must land in two distinct new sheets, each importing its own.
  const tsx =
    "import a from './A.module.scss';\nimport b from './B.module.scss';\n" +
    'export const Card = (): JSX.Element => (\n' +
    '  <div className={a.box}><span className={b.box} /></div>\n' +
    ');\n' +
    'export const Panel = (): JSX.Element => <section />;\n';
  const { env, read, dispose } = await run(
    {
      'tsconfig.json': TSCONFIG,
      'src/scss.d.ts': SCSS_D,
      'src/jsx.d.ts': JSX_D,
      'src/feature/A.module.scss': '.box { color: red; }\n',
      'src/feature/B.module.scss': '.box { color: blue; }\n',
      'src/feature/Panel.tsx': tsx,
    },
    { name: 'Card', dest: 'src/widgets/Card.tsx', css: 'copy-safe' },
  );
  try {
    assert.equal(env.applied, true);
    assert.equal(env.typecheck.clean, true);

    const targets = (env.cssCoExtract ?? []).map((r) => r.targetStylesheet).filter(Boolean);
    assert.equal(targets.length, 2, `expected two new sheets, got ${JSON.stringify(targets)}`);
    assert.equal(new Set(targets).size, 2, `the two new sheets must be DISTINCT: ${targets}`);

    // The extracted file imports each binding from a distinct sheet (no collapse, no aliasing).
    const card = read('src/widgets/Card.tsx');
    const aSpec = /import a from ["'](\.\/[^"']+)["']/.exec(card)?.[1];
    const bSpec = /import b from ["'](\.\/[^"']+)["']/.exec(card)?.[1];
    assert.ok(aSpec !== undefined && bSpec !== undefined, `both imports repointed: ${card}`);
    assert.notEqual(aSpec, bSpec, 'the two imports must resolve to different sheets');
  } finally {
    await dispose();
  }
});
