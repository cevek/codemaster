// t-751003 — the intersection-scrutinee honesty note. An intersection scrutinee `T & X` distributes
// to `(A&X) | (B&X)` — a union whose arms are intersections of T's CONSTITUENTS, never T itself — so
// the identity gate cannot recover T and the site is MISSED. Structural recovery is exactly the
// flood-risk the identity gate exists to avoid (and > the task's scope), so this is by-design honest
// under-coverage. The invariant tested here: a 0-site answer must NOT dress this genuine miss as a
// "correctly excluded" structural supertype — the empty-note must DISCLOSE the intersection
// under-coverage, so an agent knows a `T & X` switch was missed, not proven absent (§3.6). Oracle =
// the hand-curated expectation (the fixture is input; ground truth is written here).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';

type DView = { sites: { span: { line: number } }[]; notes?: string[] };

test('intersection scrutinee `T & X` is missed, and the empty-note honestly discloses it', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/x.ts': `export type Shape = { kind: 'a'; x: number } | { kind: 'b'; y: number };
export function f(s: Shape & { traceId?: string }): void {
  switch (s.kind) { case 'a': break; }
}
`,
  });
  try {
    const r = await p.op('discrimination_sites', { name: 'Shape' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const view = r.result.data as DView;
    // The under-coverage itself: `Shape & { traceId? }` distributes → identity gate misses it.
    assert.equal(view.sites.length, 0, 'intersection scrutinee is under-covered (identity gate)');
    const notes = view.notes ?? [];
    assert.ok(
      notes.some((n) => /under-coverage/i.test(n) && /intersection/i.test(n)),
      'the empty-note DISCLOSES the intersection under-coverage (a genuine miss, not a proven absence)',
    );
    assert.ok(
      !notes.some((n) => /is correctly excluded; widen/i.test(n)),
      'the old text that dressed the miss as a correct exclusion is gone (§3.6)',
    );
  } finally {
    await p.dispose();
  }
});
