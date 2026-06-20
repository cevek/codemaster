// `summaryOnly` mutation mode (§ spec-refactor-capture-safety §3a / spec-stresstest §3a): a
// mutating op returns the verdict (mode/applied/typecheck/captures) + ONE merged `touched` list
// (per-file `{path, added, removed}`, plus `{path, gone:true}` for a moved-away source) INSTEAD of
// the unified diff + the redundant bare-`touched`/keyed-`diffstat` pair — for when the agent wants
// the safety verdict, not the bytes. The diff is omitted (not emptied); the safety fields are
// never dropped, and a moved-away source stays visible (§3.4), never silently dropped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonValue } from '../../src/core/json.ts';
import { project } from '../helpers/project.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"module":"preserve"}}';

type TouchedStat = { path: string; added?: number; removed?: number; gone?: boolean };
type Envelope = {
  diff?: string;
  diffstat?: Record<string, string>;
  touched: TouchedStat[] | string[];
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

test('summaryOnly: omits the unified diff, returns ONE merged touched list + keeps the verdict', async () => {
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
    assert.equal(summary.diffstat, undefined, 'the keyed diffstat is folded into touched');
    // ONE merged list: each written file carries its +added/-removed counts inline.
    const row = (summary.touched as TouchedStat[]).find((t) => t.path === 'src/a.ts');
    assert.ok(row !== undefined, `touched names src/a.ts: ${JSON.stringify(summary.touched)}`);
    assert.equal(typeof row.added, 'number');
    assert.equal(typeof row.removed, 'number');
    assert.equal(summary.typecheck.clean, true); // the verdict survives
    // same touch-SET as the full run (the full run's touched is the bare path list).
    assert.deepEqual(
      (summary.touched as TouchedStat[]).map((t) => t.path).sort(),
      [...(full.touched as string[])].sort(),
    );
  } finally {
    await p.dispose();
  }
});

test('summaryOnly: move_file marks the moved-away source `(removed)` — not silently dropped (§3.4)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/old.ts': 'export const v = 1;\n',
    'src/use.ts': "import { v } from './old';\nexport const w = v + 1;\n",
  });
  try {
    const summary = await op(
      p,
      'move_file',
      { source: 'src/old.ts', dest: 'src/new.ts' },
      { summaryOnly: true },
    );
    assert.equal(summary.diff, undefined);
    assert.equal(summary.diffstat, undefined);
    const rows = summary.touched as TouchedStat[];
    const gone = rows.find((t) => t.path === 'src/old.ts');
    assert.ok(
      gone !== undefined && gone.gone === true,
      `the moved-away source is marked gone: ${JSON.stringify(rows)}`,
    );
    // and the destination + the rewritten importer carry counts.
    assert.ok(rows.some((t) => t.path === 'src/new.ts' && typeof t.added === 'number'));
    assert.ok(rows.some((t) => t.path === 'src/use.ts' && typeof t.added === 'number'));
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
