// Spec-kitchensink Stage 2 — move_file over the substrate (the highest blast radius). Failure
// discipline (spec §2): a red test is a real port bug to SURFACE (findings + feedback +
// quarantine for the destructive path), never weakened to match output. Every `expected` is
// HAND-CURATED by reading the fixture (spec §2.1).
//
// Oracles, independent of the warm LS that performed the move (spec §3):
//   · `coldDiagnostics() == []` — a cold full-program compile. A missed/wrong rewrite of a
//     TS/JS specifier (value import, ES `import type`, `import('…').Type` type-query, dynamic
//     `import('./x.ts')`) dangles as "cannot find module" → the compile catches it. NOTE: this
//     gate is BLIND to `.scss`/`.css`/`.sass` specifiers — the fixture's ambient `declare module
//     '*.scss'` (types/styles.d.ts) matches ANY path, backed by a real file or not — so a
//     dangling stylesheet import would NOT fail the compile. Stylesheet carry/rewrite is therefore
//     gated separately, by `existsSync` + the specifier TEXT, never by the compile alone;
//   · the rewritten specifier TEXT (the scss/dynamic specifiers TS can't gate on);
//   · git byte-exact: dry-run writes nothing, diff(dry) === diff(apply), and a folder move is a
//     real `git mv` (staged rename), not delete+add.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
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
}

async function move(p: TestProject, args: JsonValue, apply = false): Promise<Envelope> {
  const [r] = await p.request([{ name: 'move_file', args, ...(apply ? { apply: true } : {}) }]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.result.data as unknown as Envelope;
}

const read = (p: TestProject, rel: string): string => readFileSync(path.join(p.root, rel), 'utf8');

void describe('kitchensink move_file (Stage 2 — import-rewrite blast radius)', () => {
  // M11 — the dual-spelling module: src/lib/util.ts is imported WITH the extension
  // (`@/lib/util.ts`, anchors.ts) AND without it (`@/lib/util`, Showcase.tsx). A move must
  // rewrite BOTH spellings or leave half the imports dangling. Both resolve to one node, so both
  // must repoint — and each must KEEP its original extension style (the emit preserves it).
  test('M11 — moving the dual-spelling file rewrites BOTH spellings, each keeping its style', async () => {
    const p = await projectFromDir('kitchensink');
    try {
      const args = { source: 'src/lib/util.ts', dest: 'src/helpers/util.ts' };
      const dry = await move(p, args);
      assert.equal(dry.mode, 'dry-run');
      assert.equal(dry.typecheck.clean, true);
      assert.equal(p.git('status', '--porcelain'), '');

      const applied = await move(p, args, true);
      assert.equal(applied.mode, 'applied');
      assert.equal(applied.diff, dry.diff); // diff(dry) === diff(apply)
      assert.deepEqual(coldDiagnostics(p.root), []); // a half-rewrite would dangle here

      // Spelling A (extension kept): anchors.ts imported `@/lib/util.ts`. coldDiagnostics==[]
      // above already proves no live old-path import dangles (a leftover would fail to resolve);
      // these positive matches prove BOTH spellings repointed, each keeping its extension style.
      assert.match(read(p, 'src/features/misc/anchors.ts'), /from ['"]@\/helpers\/util\.ts['"]/);
      // Spelling B (no extension kept): Showcase.tsx imported `@/lib/util`.
      assert.match(read(p, 'src/features/misc/Showcase.tsx'), /from ['"]@\/helpers\/util['"]/);
      assert.ok(!existsSync(path.join(p.root, 'src/lib/util.ts')));

      // Spec §5 Stage 2 literal oracle — a cold find-references on a symbol IN the moved file
      // resolves the same set (no dangling), proving each spelling's importer rebound to the new
      // home: `clamp` ← anchors.ts (ext spelling), `slug` ← Showcase.tsx (no-ext spelling).
      assert.deepEqual(coldFindReferences(p.root, 'src/helpers/util.ts', 'clamp'), [
        'src/features/misc/anchors.ts',
        'src/helpers/util.ts',
      ]);
      assert.deepEqual(coldFindReferences(p.root, 'src/helpers/util.ts', 'slug'), [
        'src/features/misc/Showcase.tsx',
        'src/helpers/util.ts',
      ]);
    } finally {
      await p.dispose();
    }
  });

  // M12 — the `import('@/data/shapes').Type` type-query operator (NOT an ES import). Moving
  // src/data/shapes.ts must rewrite the embedded path inside each type-query (io.ts ×3,
  // Form.tsx ×1) AND the ES `import type { Foo }` in Form.tsx. ES-import-only rewriting misses
  // the type-query entirely — and TS won't flag a dangling `import('…')` path the way it flags a
  // value import, so the cold compile is the load-bearing gate.
  test('M12 — moving a type-query target rewrites the embedded import() paths + the ES type import', async () => {
    const p = await projectFromDir('kitchensink');
    try {
      const args = { source: 'src/data/shapes.ts', dest: 'src/models/shapes.ts' };
      const dry = await move(p, args);
      assert.equal(dry.typecheck.clean, true);
      const applied = await move(p, args, true);
      assert.equal(applied.diff, dry.diff);
      assert.deepEqual(coldDiagnostics(p.root), []);

      // io.ts: every `import('@/data/shapes').X` type-query repointed (no ES import here at all).
      // (coldDiagnostics==[] proves no live old-path query dangles; comments may still mention it.)
      const io = read(p, 'src/core/io.ts');
      assert.match(io, /import\(['"]@\/models\/shapes['"]\)\.Envelope/);
      assert.match(io, /import\(['"]@\/models\/shapes['"]\)\.Foo/);
      assert.match(io, /import\(['"]@\/models\/shapes['"]\)\.Bar/);
      // Form.tsx: BOTH forms repointed — the ES `import type { Foo }` and the `import().Bar`.
      const form = read(p, 'src/features/forms/Form.tsx');
      assert.match(form, /import type \{ Foo \} from ['"]@\/models\/shapes\.ts['"]/);
      assert.match(form, /import\(['"]@\/models\/shapes['"]\)\.Bar/);
    } finally {
      await p.dispose();
    }
  });

  // M9 (move side) — a module behind a dynamic `import('./X')`. Moving forms/handlers.ts must
  // rewrite the dynamic specifier `await import('./handlers.ts')` in Form.tsx, not just the ES
  // imports. (The string-keyed lazy-registry honest-LIMITATION on RENAME is Stage 4; here the
  // move MUST rewrite the dynamic specifier.)
  test('M9 — moving a dynamically-imported module rewrites the import() specifier + ES imports', async () => {
    const p = await projectFromDir('kitchensink');
    try {
      const args = {
        source: 'src/features/forms/handlers.ts',
        dest: 'src/features/forms/form-handlers.ts',
      };
      const applied = await move(p, args, true);
      assert.equal(applied.applied, true);
      assert.deepEqual(coldDiagnostics(p.root), []);

      const form = read(p, 'src/features/forms/Form.tsx');
      // ES import (default + named) repointed.
      assert.match(
        form,
        /import submit, \{ handle as formHandle, validate \} from ['"]\.\/form-handlers\.ts['"]/,
      );
      // The dynamic specifier — the M9 move case — repointed too (cold compile proves no dangle).
      assert.match(form, /await import\(['"]\.\/form-handlers\.ts['"]\)/);
    } finally {
      await p.dispose();
    }
  });

  // Folder move + sibling carry — moving the whole features/widget/ directory carries its
  // colocated stylesheets (Widget.module.scss AND the bare side-effect w.scss) and rewrites every
  // importer: App.tsx (value import), shared/index.ts (the `Widget as Card` re-export), and
  // lazy.ts (the dynamic `import('@/features/widget/Widget.tsx')`). The moved Widget.tsx's OWN
  // relative sibling imports stay relative (they moved together). History is preserved.
  test('folder move — features/widget → features/card: siblings carried, all importers rewritten', async () => {
    const p = await projectFromDir('kitchensink');
    try {
      const args = { source: 'src/features/widget', dest: 'src/features/card' };
      const dry = await move(p, args);
      assert.equal(dry.mode, 'dry-run');
      assert.equal(p.git('status', '--porcelain'), '');

      // HAND-CURATED touched-set by EQUALITY — the self-contained completeness gate (the cold
      // compile is blind to the .scss carry, see the header). Both old+new paths of the three
      // carried files, plus the three importers (App value import, lazy dynamic, shared re-export).
      assert.deepEqual([...dry.touched].sort(), [
        'src/App.tsx',
        'src/features/card/Widget.module.scss',
        'src/features/card/Widget.tsx',
        'src/features/card/w.scss',
        'src/features/forms/lazy.ts',
        'src/features/widget/Widget.module.scss',
        'src/features/widget/Widget.tsx',
        'src/features/widget/w.scss',
        'src/shared/index.ts',
      ]);

      const applied = await move(p, args, true);
      assert.equal(applied.applied, true);
      assert.equal(applied.diff, dry.diff);
      assert.deepEqual(coldDiagnostics(p.root), []);

      // The whole folder moved, carrying BOTH stylesheets (the .module.scss and the bare w.scss).
      assert.ok(existsSync(path.join(p.root, 'src/features/card/Widget.tsx')));
      assert.ok(existsSync(path.join(p.root, 'src/features/card/Widget.module.scss')));
      assert.ok(existsSync(path.join(p.root, 'src/features/card/w.scss')));
      assert.ok(!existsSync(path.join(p.root, 'src/features/widget')));

      // The moved file's own relative sibling imports stay relative (carried together).
      const widget = read(p, 'src/features/card/Widget.tsx');
      assert.match(widget, /import s from ['"]\.\/Widget\.module\.scss['"]/);
      assert.match(widget, /import ['"]\.\/w\.scss['"]/);

      // Every importer repointed to the new folder — value, re-export, and dynamic forms.
      assert.match(read(p, 'src/App.tsx'), /from ['"]@\/features\/card\/Widget\.tsx['"]/);
      assert.match(
        read(p, 'src/shared/index.ts'),
        /export \{ Widget as Card \} from ['"]@\/features\/card\/Widget\.tsx['"]/,
      );
      assert.match(
        read(p, 'src/features/forms/lazy.ts'),
        /import\(['"]@\/features\/card\/Widget\.tsx['"]\)/,
      );

      // History preserved via `git mv`, NOT delete+add. The staged change must be a RENAME
      // (porcelain `R`), which a delete+add would not produce — `git log --follow` alone can't
      // tell them apart (its rename detection reconstructs history even after a plain rm+write).
      assert.match(
        p.git('status', '--porcelain'),
        /^R.*\bsrc\/features\/widget\/Widget\.tsx -> src\/features\/card\/Widget\.tsx$/m,
        'the moved file must be staged as a git rename (proves git mv, not delete+add)',
      );
      p.commit('moved widget → card');
      assert.match(
        p.git('log', '--follow', '--format=%s', '--', 'src/features/card/Widget.tsx'),
        /fixture/,
      );
    } finally {
      await p.dispose();
    }
  });
});
