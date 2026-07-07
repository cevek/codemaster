// §3.4 completeness: `expand_type` at `verbosity:'full'` must list EVERY member — the default
// 40-cap is a density default, not a truth boundary, so `full` lifts it. Oracle = a fresh-from-cold
// `ts.Program` prop count (§16), asserted through the op FLAG (entry-agnostic: verbosity threads via
// the request → ctx.flags, the SAME orchestrator path the MCP daemon and CLI both use).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { coldMembers } from '../helpers/cold-ls.ts';
import { renderResult } from '../../src/format/render/render-result.ts';

type View = { members?: { name: string }[] };

test('verbosity:full lists ALL members — the default 40-cap is LIFTED (entry-agnostic op flag)', async () => {
  // 45 > the default 40-cap: at terse it truncates (rides Result.truncated); at full it is COMPLETE.
  const N = 45;
  const wide = `export interface Wide { ${Array.from({ length: N }, (_, i) => `f${i}: number;`).join(' ')} }\n`;
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/w.ts': wide,
  });
  try {
    // Reading the flag off the REQUEST proves the op honors it regardless of entry point (MCP/CLI).
    const [full] = await p.request([
      { name: 'expand_type', args: { name: 'Wide' }, verbosity: 'full' },
    ]);
    assert.ok(full !== undefined && 'result' in full && full.result.ok);
    const cold = coldMembers(p.root, 'src/w.ts', 'Wide');
    assert.equal(cold.length, N, 'precondition: oracle sees all 45 props');
    const members = (full.result.data as View).members ?? [];
    assert.equal(members.length, N, 'at full, every member is listed — no cap');
    assert.deepEqual(
      members.map((m) => m.name).sort(),
      cold.map((m) => m.name),
      'full member set equals the cold oracle',
    );
    assert.equal(full.result.truncated, undefined, 'full is complete — no truncation');
    // The RENDER must emit all N members too (guards an independent render-layer list cap).
    const rendered = renderResult(full.result, 'full');
    for (let i = 0; i < N; i++) {
      assert.ok(rendered.includes(`f${i}:`), `full render omits member f${i}`);
    }
    assert.ok(!/OUTPUT CAPPED/.test(rendered), 'small type: no char-cap either');

    // Same type at the terse default: capped at 40, the overflow on the truncation channel.
    const [terse] = await p.request([{ name: 'expand_type', args: { name: 'Wide' } }]);
    assert.ok(terse !== undefined && 'result' in terse && terse.result.ok);
    assert.equal((terse.result.data as View).members?.length, 40, 'terse caps at the default 40');
    assert.deepEqual(
      { shown: terse.result.truncated?.shown, total: terse.result.truncated?.total },
      { shown: 40, total: N },
      'the 5 hidden members ride Result.truncated at the default density',
    );
  } finally {
    await p.dispose();
  }
});
