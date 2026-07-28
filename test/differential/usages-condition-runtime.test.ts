// The RUNTIME oracle for `find_usages {conditions:true}` (t-933867) — the one oracle that cannot
// share a misconception with the implementation, because its ground truth is EXECUTION, not another
// AST walk.
//
// Why it exists: a second traversal written from the same rules (the descent oracle in
// usages-condition-chain.test.ts) discriminates mechanics — a lost level, a bad reversal, a
// blanket-empty degradation — but NOT a wrong rule: when the case-expression hole was found, the
// descent oracle had it too and stayed green. Behaviour cannot be wrong in the same direction as a
// belief about behaviour. So: run the fixture over every combination of its inputs, record which
// sites actually fired, then EVALUATE each site's reported condition chain against the same inputs.
// The claim under test is exactly the claim the annotation makes to an agent —
//
//     the site runs  ⟺  the reported chain is true
//
// — so an inverted polarity, an unnoticed short-circuit (`?.`, `||=`), a fabricated guard, or a
// chain that silently omits a branch all fail here, whatever their cause.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project } from '../helpers/project.ts';
import { fired, sites, type Bag } from '../fixtures/inline/condition-runtime-sites.ts';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'inline',
  'condition-runtime-sites.ts',
);
const SOURCE = readFileSync(FIXTURE, 'utf8');
const MOUNTED = 'src/sites.ts';

/** id → 1-based line, read from the fixture text so the executable file and the analysed file are
 *  provably the same artifact (no hand-maintained table to drift). */
function siteLines(): Map<number, number> {
  const m = new Map<number, number>();
  SOURCE.split('\n').forEach((line, i) => {
    const hit = /\bF\((\d+)\)/.exec(line);
    if (hit?.[1] !== undefined) m.set(Number(hit[1]), i + 1);
  });
  return m;
}

type Combo = { x: boolean; y: boolean; k: string; o: () => Bag };

/** Every input combination the fixture's conditions can discriminate. `o` is a FACTORY: the run
 *  mutates it (`||=` / `&&=`), so the evaluation pass must get an untouched copy. */
function combos(): Combo[] {
  const out: Combo[] = [];
  for (const x of [false, true]) {
    for (const y of [false, true]) {
      for (const k of ['a', 'b', 'c']) {
        for (const v of [undefined, true] as const) {
          for (const w of [undefined, true] as const) {
            for (const z of [undefined, true] as const) {
              for (const hasF of [false, true]) {
                out.push({
                  x,
                  y,
                  k,
                  o: () => ({
                    ...(v !== undefined ? { v } : {}),
                    ...(w !== undefined ? { w } : {}),
                    ...(z !== undefined ? { z } : {}),
                    ...(hasF ? { f: (b: boolean): boolean => b } : {}),
                  }),
                });
              }
            }
          }
        }
      }
    }
  }
  return out;
}

/** Evaluate a reported chain against one combination — the agent's own reading of the annotation,
 *  performed literally. */
function chainHolds(chain: readonly string[], c: Combo): boolean {
  if (chain.length === 0) return true; // no enclosing branch ⇒ reached whenever the body is
  const expr = chain.map((cond) => `(${cond})`).join(' && ');

  const fn = new Function('x', 'y', 'k', 'o', `return Boolean(${expr});`) as (
    x: boolean,
    y: boolean,
    k: string,
    o: Bag,
  ) => boolean;
  return fn(c.x, c.y, c.k, c.o());
}

test('runtime oracle: a site fires EXACTLY when its reported condition chain is true', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true,"target":"es2022"}}',
    [MOUNTED]: SOURCE,
  });
  try {
    const r = await p.op('find_usages', {
      name: 'F',
      file: MOUNTED,
      role: 'call',
      conditions: true,
      limit: 500,
    });
    assert.ok('result' in r && r.result.ok, `find_usages failed: ${JSON.stringify(r)}`);
    const view = r.result.data as {
      usages: {
        span: { file: string; line: number };
        condition?: { conditions?: string[]; partial?: true };
      }[];
    };

    const byLine = new Map(
      view.usages.filter((u) => u.span.file === MOUNTED).map((u) => [u.span.line, u.condition]),
    );
    const lines = siteLines();
    assert.ok(lines.size >= 18, `fixture must expose every site id, got ${lines.size}`);

    // Sanity: the analysis really saw every executable site — otherwise a missing annotation would
    // make the loop below vacuous for that site (a test that passes on a bug).
    for (const [id, line] of lines) {
      assert.ok(byLine.has(line), `site ${id} (line ${line}) carries no reported usage`);
      assert.ok(byLine.get(line) !== undefined, `site ${id} (line ${line}) is not annotated`);
    }

    let checked = 0;
    for (const c of combos()) {
      fired.length = 0;
      sites(c.x, c.y, c.k, c.o());
      const actual = new Set(fired);
      for (const [id, line] of lines) {
        const chain = byLine.get(line);
        if (chain?.partial === true) continue; // a disclosed subset makes no ⟺ claim
        const predicted = chainHolds(chain?.conditions ?? [], c);
        assert.equal(
          predicted,
          actual.has(id),
          `site ${id} (line ${line}) chain [${(chain?.conditions ?? []).join(' && ')}] predicted ${predicted}, ` +
            `runtime ${actual.has(id) ? 'CALLED' : 'did NOT call'} with x=${c.x} y=${c.y} k=${c.k} o=${JSON.stringify(c.o())}`,
        );
        checked++;
      }
    }
    // Guard the guard: a fixture/analysis mismatch that silently emptied the matrix would otherwise
    // pass as green.
    assert.ok(checked > 3000, `expected a broad matrix, only checked ${checked} site×input pairs`);
  } finally {
    await p.dispose();
  }
});
