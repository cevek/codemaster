// t-229522 — what a `source { syntactic: true }` REFUSAL is allowed to SAY. Sibling of
// `syntactic-source-boundaries.test.ts` (which pins WHAT the path refuses) and
// `syntactic-source.test.ts` (the invariants of a successful answer); all three drive the one shared
// fixture so they reason about the same declarations.
//
// The defect class these guard is a refusal whose verdict is right and whose EXPLANATION is invented: a
// cause the code never established, a caveat licensed by a different observation, a count that reads as
// something it is not. Each is cheap to get wrong and invisible to any assertion about the verdict alone —
// which is exactly how several of them shipped. So every count and every caveat variant is asserted, not
// inferred from the fact that the call refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import {
  SYNTACTIC_FIXTURE as FILES,
  missReason,
  sourceOf,
} from '../helpers/syntactic-source-fixture.ts';

test('the assignment cause states its own counts and its own caveat', async () => {
  const p = await project(FILES);
  try {
    // Each COUNT and each caveat variant asserted, so neither can be replaced by a constant. The lead
    // must be true of every member: a set containing a plain `const` may not be led by "as property
    // assignments", which contradicting one clause later does not repair.
    const pure = missReason(
      await sourceOf(p, { name: 'tag', file: 'src/merged.ts' }, true),
      'pure',
    );
    assert.match(
      pure,
      /2 declarations named 'tag' as property assignments on 2 distinct objects/,
      pure,
    );
    assert.ok(
      !/not a property assignment at all/.test(pure),
      `no plain member exists here: ${pure}`,
    );
    assert.match(pure, /does not resolve which object each belongs to/, pure);

    const onePlain = missReason(
      await sourceOf(p, { name: 'onePlain', file: 'src/causes.ts' }, true),
      'onePlain',
    );
    assert.match(
      onePlain,
      /on 1 distinct object \(as written\)/,
      `singular, and counted: ${onePlain}`,
    );
    assert.match(onePlain, /at least one not a property assignment at all/, onePlain);
    assert.ok(
      !/^.*'onePlain' as property assignments/.test(onePlain),
      `the lead may not claim all are assignments: ${onePlain}`,
    );
    assert.match(onePlain, /nor whether the others are the same symbol/, 'the plain-case caveat');

    // Three members over TWO objects: `objects` counts distinct OBJECTS, never members.
    const dup = missReason(await sourceOf(p, { name: 'dup', file: 'src/causes.ts' }, true), 'dup');
    assert.match(dup, /3 declarations named 'dup'/, `member count: ${dup}`);
    assert.match(dup, /on 2 distinct objects/, `distinct-object count: ${dup}`);

    const tri = missReason(await sourceOf(p, { name: 'tri', file: 'src/causes.ts' }, true), 'tri');
    assert.match(tri, /3 declarations named 'tri'/, tri);
    assert.match(tri, /on 2 distinct objects/, tri);
    assert.match(tri, /at least one not a property assignment at all/, 'both facts, not one');
  } finally {
    await p.dispose();
  }
});

test('a file arg that is not on the surface names the cause it actually established', async () => {
  const p = await project(FILES);
  try {
    // The lookup only establishes "not a key in the surface map". Attributing that to "gitignored or
    // outside-root" without probing is the wrong-cause-wrong-remedy defect: each case must name its own.
    const cases: Array<[string, RegExp]> = [
      ['src/nope.ts', /no such file/i],
      ['src', /is a directory/i],
      ['tsconfig.json', /not TypeScript source/i],
    ];
    for (const [file, expected] of cases) {
      const data = await sourceOf(p, { name: 'makeWidget', file }, true);
      const reason = missReason(data, file);
      assert.match(reason, expected, `${file}: names its own cause`);
      assert.ok(
        !/gitignored/i.test(reason),
        `${file}: must not attribute an unestablished cause — got: ${reason}`,
      );
    }
  } finally {
    await p.dispose();
  }
});
