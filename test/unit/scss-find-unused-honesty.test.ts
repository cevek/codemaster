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

// Cross-sheet `composes: x from './provider'` — the provider class is reached only through the
// consumer sheet, never directly in TS. It must NOT be reported `certain` unused (deleting it
// breaks the consumer's composition), while a genuinely dead provider class still reads certain.
const CROSS_SHEET_FIXTURE = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/provider.module.scss':
    '.shared { color: red; }\n' + // reached only via consumer's `composes … from` → partial
    '.orphan { color: blue; }\n', // nobody composes or uses it → certain dead
  'src/consumer.module.scss': '.box { composes: shared from "./provider.module.scss"; }\n',
  'src/use.ts': "import s from './consumer.module.scss';\nexport const a = s.box;\n",
};

test('cross-sheet composes-from keeps the provider class partial; a truly orphan one stays certain', async () => {
  const p = await project(CROSS_SHEET_FIXTURE);
  try {
    const r = await p.op('find_unused_scss_classes', {});
    assert.ok('result' in r && r.result.ok);
    const unused = (r.result.data as View).unused;
    const row = (name: string): Unused | undefined => unused.find((u) => u.name === name);

    assert.equal(
      row('shared')?.confidence,
      'partial',
      '`shared` is reached cross-sheet via composes-from → partial, never certain dead',
    );
    assert.equal(row('orphan')?.confidence, 'certain', '`orphan` is genuinely dead → certain');
    assert.equal(row('box'), undefined, '`box` is used in TS');
  } finally {
    await p.dispose();
  }
});

// Regression guard: a `composes … from` whose relative specifier RESOLVES but does not byte-match
// an indexed sheet (here an OMITTED extension — `from "./provider"`) must NOT bypass the demote
// and report the provider class `certain` dead. We can't pin the provider, so we demote the
// composed name everywhere — conservative, never a false certain (the §3 lie).
const EXTLESS_FIXTURE = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/provider.module.scss': '.shared { color: red; }\n',
  'src/consumer.module.scss': '.box { composes: shared from "./provider"; }\n', // no .module.scss
  'src/use.ts': "import s from './consumer.module.scss';\nexport const a = s.box;\n",
};

test('cross-sheet composes-from with an unresolvable/unindexed provider never reports certain dead', async () => {
  const p = await project(EXTLESS_FIXTURE);
  try {
    const r = await p.op('find_unused_scss_classes', {});
    assert.ok('result' in r && r.result.ok);
    const unused = (r.result.data as View).unused;
    const shared = unused.find((u) => u.name === 'shared');
    assert.equal(
      shared?.confidence,
      'partial',
      '`shared` provider reached by an extension-less composes-from → partial, never certain',
    );
  } finally {
    await p.dispose();
  }
});

// pathInclude/pathExclude scope WHICH sheets are reported on (the whole-repo answer caps fast).
// The load-bearing invariant: scoping must NOT fabricate a dead class an EXCLUDED sheet keeps
// alive — cross-sheet `composes:` reachability is resolved over every sheet regardless of scope.
type ScopedView = { unused: Unused[]; scanned: { modules: number; classes: number } };

test('pathInclude scopes the report; cross-sheet composes reachability survives (no scoped-away false dead)', async () => {
  const p = await project(CROSS_SHEET_FIXTURE);
  try {
    // Scope the report to the provider sheet ONLY — the consumer sheet that composes `.shared`
    // is OUT of scope, yet `.shared` must not flip to certain-dead.
    const r = await p.op('find_unused_scss_classes', { pathInclude: ['src/provider.module.scss'] });
    assert.ok('result' in r && r.result.ok);
    const data = r.result.data as ScopedView;
    const row = (name: string): Unused | undefined => data.unused.find((u) => u.name === name);

    assert.equal(data.scanned.modules, 1, 'scanned scope = the one included sheet');
    assert.equal(row('orphan')?.confidence, 'certain', 'in-scope, truly dead → still certain');
    assert.equal(
      row('shared')?.confidence,
      'partial',
      'composed from an EXCLUDED sheet → still partial, never a scoped-away false dead',
    );
    assert.equal(row('box'), undefined, 'the excluded consumer sheet is not reported');
  } finally {
    await p.dispose();
  }
});

test('pathExclude drops a sheet from the report (scanned scope shrinks)', async () => {
  const p = await project(CROSS_SHEET_FIXTURE);
  try {
    const r = await p.op('find_unused_scss_classes', {
      pathExclude: ['**/provider.module.scss'],
    });
    assert.ok('result' in r && r.result.ok);
    const data = r.result.data as ScopedView;
    assert.equal(
      data.unused.find((u) => u.name === 'orphan'),
      undefined,
      'excluded sheet hidden',
    );
    assert.equal(
      data.unused.find((u) => u.name === 'shared'),
      undefined,
      'excluded sheet hidden',
    );
  } finally {
    await p.dispose();
  }
});
