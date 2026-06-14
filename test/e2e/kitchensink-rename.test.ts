// Spec-kitchensink Stage 1 — rename_symbol over the dense substrate (the port's first
// high-fan-in workout). Failure discipline (spec §2): a red test here is a real port bug to
// SURFACE (record in docs/findings-kitchensink.md, file via feedback, quarantine if it touches
// the destructive path) — NEVER weakened to match buggy output. Every `expected` set below is
// HAND-CURATED by reading the fixture, never pasted from the op's output (spec §2.1).
//
// Oracles, all independent of the warm LS that performed the rename (spec §3):
//   · hand-curated touched-set, asserted by EQUALITY (not inclusion);
//   · `coldDiagnostics() == []` — a cold tsc compile of the result; a missed import/usage
//     rewrite surfaces as "no exported member" / "cannot find name", so a clean compile IS the
//     completeness proof (the strong gate);
//   · `coldFindReferences()` on the NEW name resolves the same file set (secondary cross-check);
//   · the OLD name is textually `gone` across src/ (no orphaned identifier);
//   · git byte-exact: dry-run writes nothing, diff(dry) === diff(apply).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { coldDiagnostics, coldFindReferences } from '../helpers/cold-ls.ts';
import { projectFromDir } from '../helpers/repo-fixture.ts';
import type { TestProject } from '../helpers/project.ts';
import type { JsonValue } from '../../src/core/json.ts';

interface Envelope {
  mode: string;
  diff: string;
  touched: string[];
  typecheck: { clean: boolean };
  applied?: boolean;
  rollback?: { performed: boolean };
}

async function rename(p: TestProject, args: JsonValue, apply = false): Promise<Envelope> {
  const [r] = await p.request([{ name: 'rename_symbol', args, ...(apply ? { apply: true } : {}) }]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.result.data as unknown as Envelope;
}

/** Every `.ts`/`.tsx` file under the repo's src/, repo-relative — the universe a "the old
 *  identifier is gone" check must scan (independent of the op's own touch-set). */
function srcFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (/\.tsx?$/.test(e.name)) out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  };
  walk(path.join(root, 'src'));
  return out;
}

/** The files where `name` still appears as a CODE IDENTIFIER — used to prove the OLD name is
 *  `gone` after a rename. Parses with TS and inspects `ts.Identifier` nodes only, so the
 *  fixture's trap-doc COMMENTS (which legitimately still mention the old name — rename rewrites
 *  identifiers, not prose) and string literals never produce a false positive. */
function filesContaining(root: string, name: string): string[] {
  return srcFiles(root).filter((rel) => {
    const sf = ts.createSourceFile(
      rel,
      readFileSync(path.join(root, rel), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    let found = false;
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n.text === name) found = true;
      if (!found) ts.forEachChild(n, visit);
    };
    visit(sf);
    return found;
  });
}

void describe('kitchensink rename_symbol (Stage 1 — high fan-in blast radius)', () => {
  // T2 / M4 — formatLabel: reachable via the DECL directly (App/Panel/Widget/mono), via the
  // import-with-rename `as fmt` (Showcase), via the hub barrel (shared/index), AND via the DEEP
  // 3-hop chain (Dashboard ← chain/a ← chain/b[`export *`] ← chain/c ← decl).
  //
  // The DIRECT-path blast radius the rename fully rewrites to `renderLabel` (HAND-CURATED;
  // asserted by EQUALITY). The `export *` hop (chain/b) carries no identifier (excluded);
  // chain/a + Dashboard are reached ONLY through that star (excluded — see FINDING KS-1).
  const RENAMED_FILES = [
    'src/App.tsx',
    'src/core/format.ts',
    'src/features/misc/Showcase.tsx',
    'src/features/misc/mono.ts',
    'src/features/panel/Panel.tsx',
    'src/features/widget/Widget.tsx',
    'src/shared/chain/c.ts',
    'src/shared/index.ts',
  ];

  // FINDING KS-1 (docs/findings-kitchensink.md) — pinned HONEST behavior, not a bug. The TS LS
  // `findRenameLocations` (with providePrefixAndSuffixTextForRename) preserves a re-exported
  // public name by ALIASING (`export { renderLabel as formatLabel }`) and does NOT traverse an
  // `export *` star to reach downstream NAMED re-exports. So the old name SURVIVES at exactly
  // these four sites: the two direct re-exports it aliased (chain/c, shared/index) and the
  // star-reached deep path it never visited (chain/a re-export + Dashboard import/call). The
  // cold-tsc-clean oracle proves nothing dangles; this set proves the rename is NOT a full
  // purge of the old name — it flips loudly if codemaster ever propagates through the star.
  const OLD_NAME_SURVIVES = [
    'src/features/dashboard/Dashboard.tsx',
    'src/shared/chain/a.ts',
    'src/shared/chain/c.ts',
    'src/shared/index.ts',
  ];

  // The full reference set of the renamed SYMBOL, per a cold find-references (which follows the
  // symbol through alias re-exports, not the spelling): the 8 rewritten files PLUS the two
  // star-reached sites (chain/a, Dashboard) that still SPELL it `formatLabel` but resolve to
  // the same `renderLabel` symbol. Proof the rename kept the symbol coherent across the chain.
  const ALL_REFERENCING = [
    ...RENAMED_FILES,
    'src/features/dashboard/Dashboard.tsx',
    'src/shared/chain/a.ts',
  ].sort();

  test('formatLabel — direct path fully renamed; star-reached deep path keeps old name (KS-1)', async () => {
    const p = await projectFromDir('kitchensink');
    try {
      // Dry-run: zero writes, clean typecheck, EXACT touched-set (equality, not inclusion).
      const dry = await rename(p, { name: 'formatLabel', newName: 'renderLabel' });
      assert.equal(dry.mode, 'dry-run');
      assert.equal(dry.typecheck.clean, true);
      assert.deepEqual([...dry.touched].sort(), RENAMED_FILES);
      assert.equal(p.git('status', '--porcelain'), '');

      // Apply: identical diff, clean typecheck, no rollback.
      const applied = await rename(p, { name: 'formatLabel', newName: 'renderLabel' }, true);
      assert.equal(applied.mode, 'applied');
      assert.equal(applied.typecheck.clean, true);
      assert.equal(applied.rollback?.performed, false);
      assert.equal(applied.diff, dry.diff);

      // STRONG correctness gate: an independent cold full-program compile — a missed/wrong
      // rewrite anywhere (incl. a dangling re-export alias) fails it.
      assert.deepEqual(coldDiagnostics(p.root), []);

      // A cold find-references on the renamed symbol resolves the FULL reference set (10) —
      // including the two star-reached sites that keep the old spelling — proving the symbol
      // stayed coherent across the whole chain (no split into two distinct symbols).
      assert.deepEqual(
        coldFindReferences(p.root, 'src/core/format.ts', 'renderLabel'),
        ALL_REFERENCING,
      );
      assert.match(
        readFileSync(path.join(p.root, 'src/core/format.ts'), 'utf8'),
        /export function renderLabel/,
      );
      assert.match(
        readFileSync(path.join(p.root, 'src/features/dashboard/Dashboard.tsx'), 'utf8'),
        /formatLabel\(/, // KS-1: the deep-path consumer STILL calls the old name (not renderLabel)
      );

      // FINDING KS-1 pin — the old name survives at exactly the alias + star-path sites.
      assert.deepEqual(filesContaining(p.root, 'formatLabel'), OLD_NAME_SURVIVES);
      assert.match(
        readFileSync(path.join(p.root, 'src/shared/chain/c.ts'), 'utf8'),
        /export \{ renderLabel as formatLabel \}/, // the boundary alias TS inserted
      );
    } finally {
      await p.dispose();
    }
  });

  // T3 — Registry, the high-fan-in generic class: instantiated in App / Dashboard / Form /
  // mono / Showcase, declared (+ static `instances`/`create`) in core/registry.ts. The hub
  // barrel re-exports it via `export *` (no identifier → NOT touched). The grep-beating
  // discriminator: forms/lazy.ts contains `lazyRegistry` (a DIFFERENT identifier that merely
  // shares the substring) — a semantic rename must NOT touch it. HAND-CURATED.
  const REGISTRY_FILES = [
    'src/App.tsx',
    'src/core/registry.ts',
    'src/features/dashboard/Dashboard.tsx',
    'src/features/forms/Form.tsx',
    'src/features/misc/Showcase.tsx',
    'src/features/misc/mono.ts',
  ];

  test('Registry — class rename updates every instantiation; lazyRegistry (substring) untouched', async () => {
    const p = await projectFromDir('kitchensink');
    try {
      const dry = await rename(p, { name: 'Registry', newName: 'Catalog' });
      assert.equal(dry.typecheck.clean, true);
      assert.deepEqual([...dry.touched].sort(), REGISTRY_FILES);
      assert.ok(
        !dry.touched.includes('src/features/forms/lazy.ts'),
        'lazyRegistry shares the substring but is a distinct symbol — rename is semantic, not textual',
      );

      const applied = await rename(p, { name: 'Registry', newName: 'Catalog' }, true);
      assert.equal(applied.diff, dry.diff);
      assert.equal(applied.typecheck.clean, true);
      assert.deepEqual(coldDiagnostics(p.root), []);
      assert.deepEqual(coldFindReferences(p.root, 'src/core/registry.ts', 'Catalog'), [
        ...REGISTRY_FILES,
      ]);

      // `lazyRegistry` survives intact (it must still appear — proof rename left it alone).
      assert.match(
        readFileSync(path.join(p.root, 'src/features/forms/lazy.ts'), 'utf8'),
        /lazyRegistry/,
      );
      // No orphaned bare `Registry` identifier remains (lazyRegistry is NOT a `\bRegistry\b` match).
      assert.deepEqual(filesContaining(p.root, 'Registry'), []);
    } finally {
      await p.dispose();
    }
  });

  // T13 (§4 hit-list) — const-enum MEMBER rename. `Code` is a `const enum` (codes.ts); its
  // members are INLINED at each use (no runtime enum object), so a member rename must follow the
  // member refs through inlining. `Code.Ok` is referenced from the decl + handlers.ts +
  // Dashboard.tsx. HAND-CURATED touched set; targeted by file+line+col (the member sits at
  // codes.ts:6:3) so the rename anchors on the declaration, not some other `Ok`.
  const CODE_OK_FILES = [
    'src/core/codes.ts',
    'src/features/dashboard/Dashboard.tsx',
    'src/features/forms/handlers.ts',
  ];

  test('Code.Ok — const-enum member rename follows inlined member refs across files', async () => {
    const p = await projectFromDir('kitchensink');
    try {
      const at = { file: 'src/core/codes.ts', line: 6, col: 3 };
      const dry = await rename(p, { ...at, newName: 'Done' });
      assert.equal(dry.typecheck.clean, true);
      assert.deepEqual([...dry.touched].sort(), CODE_OK_FILES);

      const applied = await rename(p, { ...at, newName: 'Done' }, true);
      assert.equal(applied.diff, dry.diff);
      assert.equal(applied.typecheck.clean, true);
      assert.deepEqual(coldDiagnostics(p.root), []);
      // The new member name resolves from the decl across every inlined ref site.
      assert.deepEqual(coldFindReferences(p.root, 'src/core/codes.ts', 'Done'), CODE_OK_FILES);
      // The old member identifier `Ok` is gone from code (comments are not identifiers).
      assert.deepEqual(filesContaining(p.root, 'Ok'), []);
    } finally {
      await p.dispose();
    }
  });
});
