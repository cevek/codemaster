// Task J #2 — CSS co-extract must resolve tsconfig-`paths` ALIASED (`@/…`) importers of a shared
// sheet, not just relative ones. A THIRD file reaching the sheet via `@/…` and using a class the
// extracted block also uses must KEEP that class (don't move what an aliased sibling still reads) —
// else the move empties the class out of the source sheet and the aliased sibling silently renders
// unstyled (scss is type-blind; the §2.8 typecheck stays clean). Oracle: cold full-program tsc +
// class-reachability over both sheets, independent of the report.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCSS_D, JSX_D, coldTscErrors, run } from '../helpers/coextract.ts';

// `paths` is given relative (`./src/*`) so it needs no (TS7-deprecated) `baseUrl`.
const TSCONFIG_ALIAS =
  '{"compilerOptions":{"strict":true,"module":"preserve","jsx":"preserve","paths":{"@/*":["./src/*"]}}}';

test('co-extract: a class an @/-ALIASED sibling still uses is KEPT, not silently moved', async () => {
  const scss = '.card { color: red; }\n.solo { color: blue; }\n.shared { margin: 0; }\n';
  const panel =
    "import s from './Panel.module.scss';\n" +
    'export const Card = (): JSX.Element => (\n' +
    '  <div className={s.card}><span className={s.solo} /></div>\n' +
    ');\n' +
    'export const Panel = (): JSX.Element => <section className={s.shared} />;\n';
  // The sibling reaches the SAME sheet via the `@/` alias and uses `.card`.
  const sibling =
    "import s from '@/feature/Panel.module.scss';\n" +
    'export const Sibling = (): JSX.Element => <i className={s.card} />;\n';
  const { env, root, read, dispose } = await run(
    {
      'tsconfig.json': TSCONFIG_ALIAS,
      'src/scss.d.ts': SCSS_D,
      'src/jsx.d.ts': JSX_D,
      'src/feature/Panel.module.scss': scss,
      'src/feature/Panel.tsx': panel,
      'src/other/Sibling.tsx': sibling,
    },
    { name: 'Card', dest: 'src/widgets/Card.tsx', css: 'copy-safe' },
  );
  try {
    assert.equal(env.applied, true);
    assert.equal(env.typecheck.clean, true);
    const report = (env.cssCoExtract ?? []).find((r) =>
      r.sourceStylesheet.endsWith('Panel.module.scss'),
    );
    assert.ok(report !== undefined, `expected a report, got ${JSON.stringify(env.cssCoExtract)}`);
    // `.solo` moves (no other reader); `.card` is KEPT because the aliased sibling still uses it.
    assert.deepEqual(report.moved, ['solo']);
    const cardEntry = report.leftBehind.find((l) => l.class === 'card');
    assert.equal(cardEntry?.code, 'USED', 'card kept as still-USED (by the aliased sibling)');

    // Class-reachability oracle (independent of the report): the source sheet RETAINS `.card`
    // and DROPS the moved `.solo`; the new sheet is the mirror image.
    const srcSheet = read('src/feature/Panel.module.scss');
    assert.match(srcSheet, /\.card/);
    assert.doesNotMatch(srcSheet, /\.solo/);
    const newSheet = read('src/widgets/Card.module.scss');
    assert.match(newSheet, /\.solo/);
    assert.doesNotMatch(newSheet, /\.card/);

    // The aliased sibling is untouched; the extracted file moved `.solo` (on `s`) and references
    // the kept `.card` via `sLegacy`. cold tsc proves the result compiles.
    assert.equal(read('src/other/Sibling.tsx'), sibling);
    const card = read('src/widgets/Card.tsx');
    assert.match(card, /s\.solo/);
    assert.match(card, /sLegacy\.card/);
    assert.deepEqual(coldTscErrors(root), []);
  } finally {
    await dispose();
  }
});
