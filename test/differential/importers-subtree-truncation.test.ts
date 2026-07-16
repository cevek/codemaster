// t-145509: in SUBTREE mode the `internal` and `unconfirmed` importer arrays were capped to `limit`
// but carried only a sibling `*Count` scalar — no per-array {shown,total,hint}, so a consumer
// iterating `internal` saw a short list whose truncation was not in the §3.4 honesty channel. Each
// capped array now co-produces its own inline `*Truncated: {shown,total,hint}` (via common/truncate
// capList), placed with the verdict scalars BEFORE the row bulk.
//
// Oracle: the importer counts are FIXTURE-derived (exactly N files placed of each kind), computed
// here independently of the op's own slicing — so `total` must equal the placed count and `shown`
// must equal the (small) `limit`. Before the fix, `internalTruncated`/`unconfirmedTruncated` were
// absent → this fails; after, they carry the true totals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import type { JsonValue } from '../../src/core/json.ts';

const COMPILER = '{"strict":true,"module":"esnext","moduleResolution":"bundler","jsx":"react-jsx"}';

// A subtree `src/lib` with, independently counted: 3 INTERNAL importers (files inside the tree that
// import under it), 2 EXTERNAL importers (files outside → deletion blockers), and 2 UNCONFIRMED refs
// (an outside file importing a `.scss` that lexically lands under the tree, which TS cannot resolve).
const FIXTURE = {
  'tsconfig.json': `{"compilerOptions":${COMPILER.slice(0, -1)},"baseUrl":"."},"include":["src"]}`,
  'src/lib/a.ts': 'export const a = 1;\n',
  'src/lib/style.scss': '.x { color: red; }\n',
  // 3 internal importers (own file INSIDE src/lib)
  'src/lib/iu1.ts': "import { a } from './a';\nexport const u1 = a;\n",
  'src/lib/iu2.ts': "import { a } from './a';\nexport const u2 = a;\n",
  'src/lib/iu3.ts': "import { a } from './a';\nexport const u3 = a;\n",
  // 2 external importers (own file OUTSIDE src/lib)
  'src/app/e1.ts': "import { a } from '../lib/a';\nexport const e1 = a;\n",
  'src/app/e2.ts': "import { a } from '../lib/a';\nexport const e2 = a;\n",
  // 2 unconfirmed refs (.scss lexically under the tree — unresolvable to a TS file)
  'src/app/u1.tsx': "import '../lib/style.scss';\nexport const c1 = 1;\n",
  'src/app/u2.tsx': "import '../lib/style.scss';\nexport const c2 = 2;\n",
};

interface Trunc {
  shown: number;
  total: number;
  hint: string;
}

test('importers_of subtree: internal/unconfirmed each carry their own §3.4 {shown,total,hint} at the cap (t-145509)', async () => {
  const p = await project(FIXTURE);
  try {
    const r = await p.op('importers_of', { module: 'src/lib', limit: 1 });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const d = r.result.data as Record<string, JsonValue>;
    assert.equal(d['mode'], 'subtree');

    // Fixture-derived ground truth: 3 internal, 2 unconfirmed, 2 external — each capped to limit 1.
    assert.equal(d['internalCount'], 3, 'oracle: 3 internal importers placed');
    assert.equal((d['internal'] as unknown[]).length, 1, 'internal capped to limit');
    assert.deepEqual(
      d['internalTruncated'],
      { shown: 1, total: 3, hint: (d['internalTruncated'] as unknown as Trunc).hint },
      'internal cut co-produces {shown,total,hint}',
    );
    assert.ok(
      typeof (d['internalTruncated'] as unknown as Trunc).hint === 'string' &&
        (d['internalTruncated'] as unknown as Trunc).hint.length > 0,
      'internal hint is a non-empty recovery string',
    );

    assert.equal(d['unconfirmedCount'], 2, 'oracle: 2 unconfirmed refs placed');
    assert.equal((d['unconfirmed'] as unknown[]).length, 1, 'unconfirmed capped to limit');
    assert.equal((d['unconfirmedTruncated'] as unknown as Trunc).shown, 1);
    assert.equal((d['unconfirmedTruncated'] as unknown as Trunc).total, 2, 'unconfirmed total is the true count');

    // The external (blocker) list still rides the ENVELOPE truncation, not an inline field — and the
    // blocker verdict reads the FULL set, so a capped list never weakens `blockers`.
    assert.equal(d['blockers'], 2, 'blockers counts the full external set, not the capped slice');
    assert.ok(r.result.truncated !== undefined, 'external cut rides the envelope Truncation');
    assert.equal(r.result.truncated?.total, 2, 'envelope external total is the true count');
  } finally {
    await p.dispose();
  }
});
