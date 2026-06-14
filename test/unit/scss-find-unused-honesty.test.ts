// Stage 1 oracle (spec-scss-css-honesty §3.3/§3.4): find_unused_scss_classes must not report a
// not-provably-dead class as `certain` unused. A class living only in a contextual/compound
// selector, or reachable via `composes:`, is `partial` ("could not prove dead"); a genuinely
// simple, cleanly-owned, unreferenced class stays `certain`; duplicate rows collapse to one.
// Oracle = hand-built expectations over a VFS fixture (no dynamic access, so claims are crisp).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';

type Unused = { name: string; file: string; confidence: string; note?: string };
type View = { unused: Unused[] };

const FIXTURE = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/m.module.scss':
    '.simple { color: red; }\n' + // cleanly-owned, unreferenced → certain
    '.card { display: block; }\n' + // used in TS
    '.card .row { padding: 1px; }\n' + // `row` only contextual
    '.row + .row { margin: 0; }\n' + // `row` again (dedup target)
    '.base { font-weight: 600; }\n' + // reachable via composes from consumer
    '.consumer { composes: base; padding: 1px; }\n' + // used in TS
    '.placeholder { color: gray; }\n' + // reachable via @extend from extender
    '.extender { @extend .placeholder; }\n', // used in TS
  'src/use.ts':
    "import s from './m.module.scss';\n" +
    'export const a = s.card;\nexport const b = s.consumer;\nexport const c = s.extender;\n',
};

test('contextual-only + composes-reachable classes are partial; simple stays certain; dedup', async () => {
  const p = await project(FIXTURE);
  try {
    const r = await p.op('find_unused_scss_classes', {});
    assert.ok('result' in r && r.result.ok);
    const unused = (r.result.data as View).unused;
    const row = (name: string): Unused | undefined => unused.find((u) => u.name === name);

    // A genuinely simple, unreferenced, cleanly-owned class IS provably dead.
    assert.equal(row('simple')?.confidence, 'certain', '`simple` is cleanly dead');

    // A class that exists ONLY inside contextual selectors can't be proven dead → partial,
    // and the two declaring selectors collapse to a SINGLE row.
    assert.equal(row('row')?.confidence, 'partial', '`row` is contextual-only → partial');
    assert.equal(
      unused.filter((u) => u.name === 'row').length,
      1,
      'duplicate contextual rows collapse to one',
    );

    // A class pulled in only by another rule's `composes:` is reachable → never certain dead.
    assert.equal(row('base')?.confidence, 'partial', '`base` is composes-reachable → partial');
    // A class pulled in only by another rule's `@extend` is likewise reachable → partial.
    assert.equal(row('placeholder')?.confidence, 'partial', '`placeholder` is @extend-reachable');

    // Statically-used classes are not unused at all.
    assert.equal(row('card'), undefined, '`card` is used');
    assert.equal(row('consumer'), undefined, '`consumer` is used');
    assert.equal(row('extender'), undefined, '`extender` is used');
  } finally {
    await p.dispose();
  }
});
