// Density of the mutating-op RENDERED text (§12) — the four wave-2 fixes, each checked on the
// real rendered output of a real op (the CLI front door over a `project()` git tree: warm LS,
// real git, real prettier — the same path MCP uses), not a hand-built envelope or a golden snapshot.
// Each fix asserts BOTH the new compact form AND the absence of the old verbose form.
//
//   1. clean typecheck collapses to `typecheck=clean` (was a `typecheck:`/`clean=true` block).
//   2. summaryOnly returns ONE merged `touched` list (`path · +A -R`, `(removed)` for a moved-away
//      source), no separate `diffstat` key.
//   3. a refused dry-run carries no `applied=false` (mode=dry-run + reason already say it).
//   4. change_signature's non-rewritable-use refusal states the reason ONCE + lists the bare
//      file:line:col sites (was the same sentence repeated per site).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project } from '../helpers/project.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(repoRoot, 'src', 'bin.ts');
const TSCONFIG = '{"compilerOptions":{"strict":true,"module":"preserve"}}';

/** Run a mutating op through the real CLI front door; returns the rendered agent-facing text. */
function cli(root: string, name: string, args: object, flags: string[] = []): string {
  return execFileSync('node', [BIN, 'op', name, JSON.stringify(args), ...flags, '--root', root], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

test('Fix 1: a clean typecheck verdict renders as one `typecheck=clean` token, not a block', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/a.ts': 'export const oldName = 1;\nexport const y = oldName + oldName;\n',
  });
  try {
    const out = cli(p.root, 'rename_symbol', { name: 'oldName', newName: 'newName' });
    assert.match(out, /(^|\n)typecheck=clean(\n|$)/, 'the clean verdict is one line');
    // The old verbose form — a `typecheck:` header with an indented `clean=true` — is gone.
    assert.doesNotMatch(out, /clean=true/, 'no exploded clean=true line');
  } finally {
    await p.dispose();
  }
});

test('Fix 2: summaryOnly renders ONE merged touched list with counts + a (removed) marker', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/old.ts': 'export const v = 1;\n',
    'src/use.ts': "import { v } from './old';\nexport const w = v + 1;\n",
  });
  try {
    const out = cli(p.root, 'move_file', { source: 'src/old.ts', dest: 'src/new.ts' }, [
      '--summaryOnly',
    ]);
    // The moved-away source is explicitly marked (not silently dropped — §3.4)…
    assert.match(out, /src\/old\.ts · \(removed\)/, 'moved-away source marked (removed)');
    // …and written files carry inline +added/-removed counts.
    assert.match(out, /src\/new\.ts · \+\d+ -\d+/, 'destination carries line counts');
    // No separate `diffstat` key, and no bare-then-keyed duplication.
    assert.doesNotMatch(out, /diffstat/, 'the keyed diffstat is folded into touched');
  } finally {
    await p.dispose();
  }
});

test('Fix 3: a refused dry-run carries no redundant applied=false (mode=dry-run + reason say it)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    // rename `add` -> `sum` collides with the existing `sum` → the post-edit typecheck refuses apply.
    'src/a.ts':
      'export const sum = 1;\nexport function add(): number { return 2; }\nexport const z = add();\n',
  });
  try {
    const out = cli(p.root, 'rename_symbol', { name: 'add', newName: 'sum' }, ['--apply']);
    assert.match(out, /mode=dry-run/, 'a refused apply reports mode=dry-run');
    assert.match(out, /reason=/, 'the refusal reason is the signal');
    assert.doesNotMatch(out, /applied=/, 'no redundant applied field in a dry-run envelope');
  } finally {
    await p.dispose();
  }
});

test('Fix 4: change_signature states the refusal reason ONCE + lists bare file:line:col sites', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/api.ts': 'export const greet = (name: string, n: number): string => name + n;\n',
    // TWO non-call value-uses of `greet` — the reason must appear once, both sites listed.
    'src/use.ts':
      "import { greet } from './api';\nconst g = greet;\nconst h = greet;\nexport const a = g('hi', 1) + h('yo', 2);\n",
  });
  try {
    const out = cli(p.root, 'change_signature', { name: 'greet', reorder: [1, 0] });
    assert.match(out, /FAIL/, 'a non-rewritable use refuses the whole op');
    // The shared reason is stated ONCE (count + label), not repeated per site.
    assert.match(
      out,
      /2 non-call use\(s\) \(value\/new\/JSX\):/,
      'one reason header for both sites',
    );
    assert.equal(
      (out.match(/non-call use/g) ?? []).length,
      1,
      'the reason text appears exactly once, not per-site',
    );
    // Each site is a bare file:line:col under that one reason.
    assert.match(
      out,
      /src\/use\.ts:\d+:\d+.*src\/use\.ts:\d+:\d+/,
      'both sites listed with line:col',
    );
  } finally {
    await p.dispose();
  }
});
