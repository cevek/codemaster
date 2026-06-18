// Index/usage-scanner agreement (backlog scss — index gate): the scss plugin must index every
// stylesheet the TS plugin's `cssModuleUsages` scanner observes imports of — `.module.css` and
// `.sass`, not just `.scss`. If the index lags the scanner, a `.module.css` class is invisible
// to `scss_classes` and a used one cannot be matched, so the index and scanner DISAGREE — the
// seam a false-unused lie grows in (§3). Oracle = an INDEPENDENT cold postcss reparse of each
// stylesheet (a naive selector class scan, distinct from the plugin's CST extractor).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { project } from '../helpers/project.ts';

type ClassRow = { name: string; file: string; confidence: string };
type Unused = { name: string; file: string; confidence: string; note?: string };

/** Cold, independent oracle: parse a stylesheet fresh and collect every `.class` token that
 *  appears as a rule subject. Deliberately NOT the plugin's `parseScssClasses` — a separate
 *  naive scan, so agreement is a real cross-check, not a tautology. */
function coldClassSet(source: string): Set<string> {
  const names = new Set<string>();
  const root = postcss.parse(source);
  root.walkRules((rule) => {
    for (const m of rule.selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
      if (m[1] !== undefined) names.add(m[1]);
    }
  });
  return names;
}

// A `.module.css` module (plain CSS — must parse through plain postcss, not postcss-scss) plus a
// TS consumer that uses ONE of its classes via `s.used`. The other class is genuinely dead. Two
// flat GLOBAL sheets (`app.css`, `legacy.scss` — no `.module.`) carry classes no `s.foo` reaches:
// referenced only via string `className`, so they must NOT read `certain` dead.
const FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/styles.module.css': '.used { color: red; }\n.dead { color: blue; }\n',
  'src/app.css': '.banner { color: green; }\n',
  'src/legacy.scss': '.frame { border: 1px; }\n',
  'src/use.ts':
    "import s from './styles.module.css';\nimport './app.css';\nimport './legacy.scss';\nexport const a = s.used;\n",
};

test('a `.module.css` sheet is indexed — scss_classes lists exactly its cold-reparsed class set', async () => {
  const p = await project(FILES);
  try {
    const r = await p.op('scss_classes', {});
    assert.ok('result' in r && r.result.ok, 'op succeeded');
    const classes = r.result.data as { classes: ClassRow[] };
    const indexed = new Set(
      classes.classes.filter((c) => c.file === 'src/styles.module.css').map((c) => c.name),
    );
    const oracle = coldClassSet(FILES['src/styles.module.css']);
    assert.deepEqual(
      [...indexed].sort(),
      [...oracle].sort(),
      'indexed class set equals the cold reparse (pre-fix this sheet is unindexed → empty)',
    );
  } finally {
    await p.dispose();
  }
});

test('index agrees with the usage scanner: used `.module.css` class omitted, unused reported certain', async () => {
  const p = await project(FILES);
  try {
    const r = await p.op('find_unused_scss_classes', {});
    assert.ok('result' in r && r.result.ok, 'op succeeded');
    const unused = (r.result.data as { unused: Unused[] }).unused;
    const dead = unused.find((u) => u.name === 'dead' && u.file === 'src/styles.module.css');
    // Indexed AND scanned: the genuinely-dead `.module.css` class surfaces (proving the sheet is
    // in the index) at `certain` (proving the usage scanner reached the same sheet).
    assert.ok(dead !== undefined, '`dead` is reported (the sheet IS indexed + scanned)');
    assert.equal(dead.confidence, 'certain', '`dead` is provably dead');
    // The used class is matched by the scanner against the indexed sheet → never reported dead.
    assert.equal(
      unused.find((u) => u.name === 'used' && u.file === 'src/styles.module.css'),
      undefined,
      '`used` is matched against the index — not falsely dead',
    );
  } finally {
    await p.dispose();
  }
});

test('a flat GLOBAL stylesheet class is demoted to partial, never `certain` unused', async () => {
  const p = await project(FILES);
  try {
    const r = await p.op('find_unused_scss_classes', {});
    assert.ok('result' in r && r.result.ok, 'op succeeded');
    const data = r.result.data as { unused: Unused[]; globalModules?: string[] };
    const banner = data.unused.find((u) => u.name === 'banner' && u.file === 'src/app.css');
    // Indexing a flat `.css` would otherwise turn a string-`className` class into a false dead.
    // It IS indexed (so it appears) but demoted: string classNames are unresolvable (§3.3).
    assert.ok(banner !== undefined, '`banner` from the global sheet is indexed + reported');
    assert.equal(banner.confidence, 'partial', '`banner` is NOT certain — global sheet');
    assert.match(banner.note ?? '', /global stylesheet/, 'reason names the global-sheet gap');
    // A flat GLOBAL `.scss` is demoted on the SAME filename-based path (not just `.css`).
    const frame = data.unused.find((u) => u.name === 'frame' && u.file === 'src/legacy.scss');
    assert.equal(frame?.confidence, 'partial', 'a flat .scss global class is partial too');
    // And both global sheets are surfaced in the envelope summary, like dynamicModules.
    const globals = data.globalModules ?? [];
    assert.ok(globals.includes('src/app.css'), 'the global .css is listed in globalModules');
    assert.ok(globals.includes('src/legacy.scss'), 'the global .scss is listed in globalModules');
    // The css-MODULE dead class stays `certain` — the op does not drown in partials.
    const dead = data.unused.find((u) => u.name === 'dead' && u.file === 'src/styles.module.css');
    assert.equal(dead?.confidence, 'certain', 'css-module dead class is still certain');
  } finally {
    await p.dispose();
  }
});
