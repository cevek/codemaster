// `summaryOnly` mutation mode (§ spec-refactor-capture-safety §3a / spec-stresstest §3a): a
// mutating op returns the verdict (mode/applied/typecheck/captures/touched) + a per-file diffstat
// (+added/-removed line counts) INSTEAD of the unified diff — for when the agent wants the safety
// verdict, not the bytes. The diff is omitted (not emptied); the safety fields are never dropped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonValue } from '../../src/core/json.ts';
import { project } from '../helpers/project.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"module":"preserve"}}';

type Envelope = {
  diff?: string;
  diffstat?: Record<string, string>;
  touched: string[];
  typecheck: { clean: boolean };
  captures?: { at: string; kind: string; detail: string }[];
};
type Proj = Awaited<ReturnType<typeof project>>;

async function op(
  p: Proj,
  name: string,
  args: JsonValue,
  flags: JsonValue = {},
): Promise<Envelope> {
  const [r] = await p.request([{ name, args, ...(flags as object) }]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.result.data as unknown as Envelope;
}

test('summaryOnly: omits the unified diff, returns a per-file diffstat + keeps the verdict', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/a.ts': 'export const oldName = 1;\nexport const y = oldName + oldName;\n',
  });
  try {
    const full = await op(p, 'rename_symbol', { name: 'oldName', newName: 'newName' });
    const summary = await op(
      p,
      'rename_symbol',
      { name: 'oldName', newName: 'newName' },
      { summaryOnly: true },
    );
    assert.equal(summary.diff, undefined, 'summaryOnly omits the unified diff');
    assert.ok(summary.diffstat !== undefined, 'summaryOnly returns a diffstat');
    assert.match(
      String(summary.diffstat['src/a.ts']),
      /^\+\d+ -\d+$/,
      'diffstat is +added/-removed',
    );
    assert.equal(summary.typecheck.clean, true); // the verdict survives
    assert.deepEqual(summary.touched, full.touched); // same touch-set as the full run
  } finally {
    await p.dispose();
  }
});

test('summaryOnly: still carries captures (the safety verdict is never dropped)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/a.ts':
      'export function slugify(s: string): string {\n  return s.toLowerCase();\n}\n' +
      'export function makeLabel(name: string): string {\n' +
      '  const upper = (s: string): string => s.toUpperCase();\n' +
      '  return slugify(name) + upper(name);\n}\n',
  });
  try {
    const summary = await op(
      p,
      'rename_symbol',
      { name: 'slugify', newName: 'upper' },
      { summaryOnly: true },
    );
    assert.equal(summary.diff, undefined);
    assert.ok(
      summary.captures !== undefined && summary.captures.length > 0,
      'captures survive summaryOnly',
    );
  } finally {
    await p.dispose();
  }
});
