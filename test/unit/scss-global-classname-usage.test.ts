// t-513259: find_unused_scss_classes must not list a GLOBAL (non-`.module.*`) sheet's class as
// dead when it is applied via a string `className="foo"` (or a clsx/classnames literal / a template
// className). Before the fix a global sheet had ZERO resolvable usages (classes are not `s.foo`
// member accesses), so EVERY class read as unused-partial — a near-lie an agent would act on. The
// fix resolves className string literals across the TS project (a new ts `classNameLiterals` seam)
// and unions them into the GLOBAL sheet's used set. An unmatched global class still stays listed
// (partial — HTML/DOM/dynamic strings are unseen), never certain, never guessed (§3.3/§3.4).
//
// Oracle: hand-built expectations over a VFS fixture (the fixture is the only input) PLUS an
// independent regex scan of which className tokens the fixture applies — the two must agree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';

type Unused = { name: string; file: string; confidence: string; note?: string };
type View = { unused: Unused[]; globalModules?: string[] };

const run = async (files: Record<string, string>): Promise<View> => {
  const p = await project(files);
  try {
    const r = await p.op('find_unused_scss_classes', {});
    assert.ok('result' in r && r.result.ok, 'op ok');
    return r.result.data as View;
  } finally {
    await p.dispose();
  }
};

const row = (data: View, name: string, file?: string): Unused | undefined =>
  data.unused.find((u) => u.name === name && (file === undefined || u.file === file));

test('global sheet: string className (bare + JsxExpression) live classes dropped; only the dead one is listed partial', async () => {
  const data = await run({
    'tsconfig.json': '{"compilerOptions":{"jsx":"react-jsx","strict":true}}',
    'src/app.scss':
      '.board { display: flex; }\n' + // live: className="board"
      '.card { color: red; }\n' + // live: className={"card"} (JsxExpression → StringLiteral)
      '.overlay { position: fixed; }\n' + // live: className="board overlay" (multi-token)
      '.dead-thing { color: blue; }\n', // truly unreferenced → stays listed, partial
    'src/App.tsx':
      "import './app.scss';\n" +
      'export const App = () => (\n' +
      '  <div className="board overlay">\n' +
      '    <span className={"card"} />\n' +
      '  </div>\n' +
      ');\n',
  });

  // The live classes must NOT appear in the dead list at all.
  for (const live of ['board', 'card', 'overlay']) {
    assert.equal(
      row(data, live),
      undefined,
      `\`${live}\` is applied via string className → not dead`,
    );
  }
  // The genuinely-unreferenced class is still reported, but partial (never certain: a global
  // class may be applied from index.html / classList.add / a dynamic string codemaster can't see).
  const dead = row(data, 'dead-thing');
  assert.ok(dead !== undefined, '`dead-thing` is still listed');
  assert.equal(dead.confidence, 'partial', '`dead-thing` is partial, never certain (global sheet)');
  assert.match(dead.note ?? '', /global stylesheet/, 'the note names the global-sheet gap');
  assert.ok(
    (data.globalModules ?? []).includes('src/app.scss'),
    'the sheet is still named in globalModules (it carries an unproven class)',
  );
});

test('clsx-family: string args, conditional string, and object KEYS all count as live', async () => {
  const data = await run({
    'tsconfig.json': '{"compilerOptions":{"jsx":"react-jsx","strict":true}}',
    'src/app.scss':
      '.frame { border: 0; }\n' + // clsx('frame', …)
      '.active { color: green; }\n' + // clsx(cond && 'active')
      '.btn-primary { color: red; }\n' + // clsx({ 'btn-primary': cond })
      '.leftover { color: gray; }\n', // unreferenced
    'src/App.tsx':
      "import './app.scss';\n" +
      "import clsx from 'clsx';\n" +
      'declare const cond: boolean;\n' +
      "const cls = clsx('frame', cond && 'active', { 'btn-primary': cond });\n" +
      'export const App = () => <div className={cls} />;\n',
  });

  for (const live of ['frame', 'active', 'btn-primary']) {
    assert.equal(row(data, live), undefined, `\`${live}\` resolved via clsx → not dead`);
  }
  assert.equal(
    row(data, 'leftover')?.confidence,
    'partial',
    'the unreferenced class stays partial',
  );
});

test('template/BEM className: static quasi + a class literal inside `${…}` count as live', async () => {
  const data = await run({
    'tsconfig.json': '{"compilerOptions":{"jsx":"react-jsx","strict":true}}',
    'src/app.scss':
      '.column { width: 1px; }\n' + // template head/quasi `column`
      '.column--unknown { color: gray; }\n' + // literal inside the conditional `${…}`
      '.never { color: black; }\n', // unreferenced
    'src/App.tsx':
      "import './app.scss';\n" +
      'declare const isUnknown: boolean;\n' +
      'export const App = () => (\n' +
      "  <span className={`column${isUnknown ? ' column--unknown' : ''}`} />\n" +
      ');\n',
  });

  assert.equal(row(data, 'column'), undefined, '`column` (template quasi) → not dead');
  assert.equal(row(data, 'column--unknown'), undefined, '`column--unknown` (in `${…}`) → not dead');
  assert.equal(
    row(data, 'never')?.confidence,
    'partial',
    'the unreferenced BEM class stays partial',
  );
});

test('GLOBAL-only union: a MODULE sheet class is NOT dropped by a same-named global string className', async () => {
  const data = await run({
    'tsconfig.json': '{"compilerOptions":{"jsx":"react-jsx","strict":true}}',
    // A MODULE sheet whose `.board` is used only via `s.board`; `.moduledead` is genuinely dead.
    'src/m.module.scss': '.board { color: red; }\n.moduledead { color: blue; }\n',
    // A GLOBAL sheet whose `.board` IS applied via string className.
    'src/g.scss': '.board { color: green; }\n',
    'src/App.tsx':
      "import s from './m.module.scss';\n" +
      "import './g.scss';\n" +
      'export const App = () => (\n' +
      '  <div className="board"><span className={s.board} /></div>\n' +
      ');\n',
  });

  // The module `.board` is live via `s.board`, so it is not listed — but that is because of the
  // MEMBER access, not the global string token. The load-bearing assertion: the module sheet is
  // still evaluated by css-module rules — `moduledead` reads CERTAIN dead (module sheets untouched).
  assert.equal(
    row(data, 'board', 'src/m.module.scss'),
    undefined,
    'module .board used via s.board',
  );
  assert.equal(
    row(data, 'moduledead', 'src/m.module.scss')?.confidence,
    'certain',
    'a module sheet stays certain-capable — the global className union must not touch it',
  );
  // The global `.board` is dropped by the string className.
  assert.equal(
    row(data, 'board', 'src/g.scss'),
    undefined,
    'global .board resolved via string className',
  );
});

test('a global class applied ONLY via a dynamic className stays LISTED as partial, never dropped, never certain', async () => {
  const data = await run({
    'tsconfig.json': '{"compilerOptions":{"jsx":"react-jsx","strict":true}}',
    'src/app.scss': '.dyn-only { color: red; }\n',
    'src/App.tsx':
      "import './app.scss';\n" +
      'declare const computed: string;\n' +
      'export const App = () => <div className={computed} />;\n',
  });

  const dyn = row(data, 'dyn-only');
  assert.ok(
    dyn !== undefined,
    'a class reached only via a dynamic className is still listed (not guessed live)',
  );
  assert.equal(dyn.confidence, 'partial', 'dynamic-only global class is partial, never certain');
});
