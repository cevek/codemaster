// Task J #3 — REVERSE import-capture + emptied-dir tombstoning for move/extract (closing the two
// honest residual gaps in `capture/imports.ts`). A move can silently re-bind a PRE-EXISTING,
// non-rewritten import: when the move introduces a file that wins module resolution over the path
// the import used to reach (e.g. a `shared.ts` file now beating a `shared/index.ts` dir). Both
// targets export a same-named, type-compatible symbol → the §2.8 typecheck waves it through → the
// import silently points at the wrong module. The reverse-capture gate catches it and REFUSES.
//
// Oracles are independent of the code under test: the over-refusal guard proves a CLEAN move
// (no shadow) still applies + cold-compiles; the capture repro proves the §2.8 typecheck is clean
// (so the gate is doing real work, not duplicating the typecheck).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { coldDiagnostics as coldTscErrors } from '../helpers/cold-ls.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { project } from '../helpers/project.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"module":"preserve"}}';

type Envelope = {
  mode: string;
  applied?: boolean;
  reason?: string;
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

test('move REVERSE capture: a new file shadows a pre-existing dir-index import → REFUSED', async () => {
  // `bar.ts` imports `./shared` → the directory `shared/index.ts` (pre-move). Moving `orphan.ts`
  // to `shared.ts` makes a FILE that wins resolution over the directory, so `./shared` silently
  // re-binds to the moved file. Both export `x: string` → tsc stays clean → only the reverse
  // capture gate can catch the shadow.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/lib/shared/index.ts': "export const x: string = 'from-dir';\n",
    'src/lib/bar.ts': "import { x } from './shared';\nexport const useBar: string = x;\n",
    'src/orphan.ts': "export const x: string = 'from-moved-file';\n",
  });
  try {
    const dry = await op(p, 'move_file', { source: 'src/orphan.ts', dest: 'src/lib/shared.ts' });
    const reverse = (dry.captures ?? []).filter((c) => c.kind === 'reverse');
    assert.ok(
      reverse.length > 0,
      `expected a reverse capture, got ${JSON.stringify(dry.captures)}`,
    );
    const cap = reverse[0];
    assert.ok(
      cap !== undefined && cap.at.startsWith('src/lib/bar.ts:'),
      `capture at bar: ${cap?.at}`,
    );
    assert.match(cap.detail, /shadow/i);
    assert.match(cap.detail, /shared\.ts/); // names the move-introduced file it now binds to

    // Apply is REFUSED while a capture stands — and nothing is written.
    const ap = await op(
      p,
      'move_file',
      { source: 'src/orphan.ts', dest: 'src/lib/shared.ts' },
      { apply: true },
    );
    assert.notEqual(ap.mode, 'applied');
    assert.equal(ap.applied ?? false, false);
    assert.equal(existsSync(path.join(p.root, 'src/lib/shared.ts')), false, 'no half-write');
    assert.equal(existsSync(path.join(p.root, 'src/orphan.ts')), true, 'source untouched');
  } finally {
    await p.dispose();
  }
});

test('move over-refusal guard: a clean move with NO shadow applies + cold-compiles', async () => {
  // Same machinery, no shadow: `orphan.ts` moves to a fresh path nothing resolves to differently.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/lib/shared/index.ts': "export const x: string = 'from-dir';\n",
    'src/lib/bar.ts': "import { x } from './shared';\nexport const useBar: string = x;\n",
    'src/orphan.ts': "export const y: string = 'orphan';\n",
  });
  try {
    const dry = await op(p, 'move_file', { source: 'src/orphan.ts', dest: 'src/util/orphan.ts' });
    assert.deepEqual(
      dry.captures ?? [],
      [],
      `no captures expected, got ${JSON.stringify(dry.captures)}`,
    );
    const ap = await op(
      p,
      'move_file',
      { source: 'src/orphan.ts', dest: 'src/util/orphan.ts' },
      { apply: true },
    );
    assert.equal(ap.applied, true);
    assert.equal(ap.typecheck.clean, true);
    // bar's `./shared` still resolves to the (untouched) dir index — not re-bound.
    assert.match(readFileSync(path.join(p.root, 'src/lib/bar.ts'), 'utf8'), /from '\.\/shared'/);
    assert.deepEqual(coldTscErrors(p.root), []);
  } finally {
    await p.dispose();
  }
});

test('move REVERSE capture via a WILDCARD alias import → caught', async () => {
  // `bar.ts` imports `@lib/shared` (paths: `@lib/* → src/lib/*`) → the dir `src/lib/shared/index.ts`
  // pre-move. Moving `orphan.ts` to `src/lib/shared.ts` makes a file that wins resolution → the alias
  // silently re-binds. Coverage for a reverse shadow reached through an ALIAS specifier (the existing
  // suite only exercised relative ones). Also a required guard for a future reverse-resolve pre-filter
  // (t-442016): a tail-preserving alias skip must not drop this.
  const p = await project({
    'tsconfig.json':
      '{"compilerOptions":{"strict":true,"module":"preserve","baseUrl":".","paths":{"@lib/*":["src/lib/*"]}}}',
    'src/lib/shared/index.ts': "export const x: string = 'from-dir';\n",
    'src/lib/bar.ts': "import { x } from '@lib/shared';\nexport const useBar: string = x;\n",
    'src/orphan.ts': "export const x: string = 'from-moved-file';\n",
  });
  try {
    const dry = await op(p, 'move_file', { source: 'src/orphan.ts', dest: 'src/lib/shared.ts' });
    const reverse = (dry.captures ?? []).filter((c) => c.kind === 'reverse');
    assert.ok(
      reverse.length > 0,
      `expected a reverse capture on the alias import, got ${JSON.stringify(dry.captures)}`,
    );
    assert.ok(
      reverse[0] !== undefined && reverse[0].at.startsWith('src/lib/bar.ts:'),
      `capture at bar: ${reverse[0]?.at}`,
    );
  } finally {
    await p.dispose();
  }
});

test('move REVERSE capture via a MULTI-TARGET `paths` alias → caught (tail-mismatch)', async () => {
  // A NON-wildcard, multi-target `paths` key whose resolved basename need NOT equal the specifier's
  // tail. `@thing → [a.ts, b.ts]` resolves to `b.ts` pre-move (a.ts absent); moving `orphan.ts` to
  // `src/a.ts` makes the higher-priority target exist, so `@thing` silently re-binds to `a.ts`. The
  // specifier tail (`thing`) does NOT match the arrival basename (`a`). Both export `x: string` → tsc
  // stays clean, so only the reverse-capture gate distinguishes the shadow. A required guard for a
  // future reverse-resolve pre-filter (t-442016): any tail-based skip must resolve this, not drop it.
  const p = await project({
    'tsconfig.json':
      '{"compilerOptions":{"strict":true,"module":"preserve","baseUrl":".","paths":{"@thing":["src/a.ts","src/b.ts"]}}}',
    'src/b.ts': "export const x: string = 'from-b';\n",
    'src/bar.ts': "import { x } from '@thing';\nexport const useBar: string = x;\n",
    'src/orphan.ts': "export const x: string = 'from-moved-a';\n",
  });
  try {
    const dry = await op(p, 'move_file', { source: 'src/orphan.ts', dest: 'src/a.ts' });
    const reverse = (dry.captures ?? []).filter((c) => c.kind === 'reverse');
    assert.ok(
      reverse.length > 0,
      `multi-target paths shadow must be caught despite tail-mismatch, got ${JSON.stringify(dry.captures)}`,
    );
    assert.ok(
      reverse[0] !== undefined && reverse[0].at.startsWith('src/bar.ts:'),
      `capture at bar: ${reverse[0]?.at}`,
    );
    // Prove the gate is doing real work: the §2.8 typecheck itself is CLEAN (both targets are
    // type-compatible), so only the reverse-capture gate distinguishes the shadow.
    assert.equal(dry.typecheck.clean, true, 'typecheck clean → gate not just echoing tsc');
  } finally {
    await p.dispose();
  }
});

test('emptied-dir tombstoning: a move that DRAINS its source dir still applies (no over-refusal)', async () => {
  // Moving the lone file out of `src/solo/` empties that directory. The post-move resolution host
  // tombstones the drained dir (so a stale resolution can't land there and mask a capture); this
  // guards the OTHER direction — the tombstoning must never FABRICATE a capture on a legit move.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/solo/only.ts': 'export const v: number = 1;\n',
    'src/main.ts': "import { v } from './solo/only';\nexport const used: number = v;\n",
  });
  try {
    const dry = await op(p, 'move_file', { source: 'src/solo/only.ts', dest: 'src/moved/only.ts' });
    assert.deepEqual(
      dry.captures ?? [],
      [],
      `drained-dir move must not fabricate a capture: ${JSON.stringify(dry.captures)}`,
    );
    const ap = await op(
      p,
      'move_file',
      { source: 'src/solo/only.ts', dest: 'src/moved/only.ts' },
      { apply: true },
    );
    assert.equal(ap.applied, true);
    assert.equal(ap.typecheck.clean, true);
    // The importer was rewritten to the new home; the moved file lives there now.
    assert.match(
      readFileSync(path.join(p.root, 'src/main.ts'), 'utf8'),
      /\.\.\/moved\/only|\.\/moved\/only/,
    );
    assert.equal(existsSync(path.join(p.root, 'src/moved/only.ts')), true, 'the file moved');
    assert.equal(
      existsSync(path.join(p.root, 'src/solo/only.ts')),
      false,
      'no longer at the source',
    );
    assert.deepEqual(coldTscErrors(p.root), []);
  } finally {
    await p.dispose();
  }
});
