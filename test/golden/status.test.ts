// spec-status-as-the-doc §3/§4: `status` IS the per-repo documentation, so its full
// render (plugins · ops · per-op notes · concepts · guidance) must stay stable and
// complete. A golden snapshot is acceptable as the sole assertion HERE — it guards
// output STABILITY, not a correctness claim (example-validity is oracle-checked by the
// Stage 1.1 anti-drift test; §16 "never golden-only" applies to correctness, not layout).
//
// Run with UPDATE_GOLDEN=1 to regenerate after an intentional change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project } from '../helpers/project.ts';

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'status.golden.txt');

/** Scrub the only volatile fields (process id + the temp workspace root) so the snapshot
 *  is deterministic; everything else (plugins, ops, notes, concepts, guidance) is fixed. */
function scrub(rendered: string, root: string): string {
  return rendered.replaceAll(root, '<ROOT>').replace(/pid=\d+/, 'pid=<PID>');
}

test('status render is stable & complete on a two-plugin fixture (golden)', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true,"jsx":"react-jsx"}}',
    'src/a.ts': 'export const a = 1;\n',
    'src/a.module.scss': '.x { color: red; }\n',
  });
  try {
    // The golden pins the FULL catalogue (opt-in via `full:true` since t-523883 made status
    // terse-by-default) — status IS the per-repo documentation, so its heavyweight render must
    // stay stable and complete.
    const rendered = scrub(await p.status({ full: true }), p.root);
    // Completeness: both plugins, the concepts block, and per-op notes must be present.
    assert.match(rendered, /plugins: ts@.+ · scss@/);
    assert.match(rendered, /\nconcepts:\n/);
    assert.match(rendered, /camelCase-initials.*NOT arbitrary subsequence/, 'per-op notes render');

    // Only the explicit UPDATE_GOLDEN flag regenerates — a missing/deleted golden must
    // FAIL (readFileSync throws), never silently self-heal green.
    // NB: the `debug topics:` line is deterministic here only because `manualClock` never
    // fires the sweeper that would register the `eviction` namespace; a clock-advancing
    // change near this fixture could shift that line.
    if (process.env['UPDATE_GOLDEN'] === '1') writeFileSync(GOLDEN, rendered);
    assert.equal(rendered, readFileSync(GOLDEN, 'utf8'), 'status render drifted from golden');
  } finally {
    await p.dispose();
  }
});
