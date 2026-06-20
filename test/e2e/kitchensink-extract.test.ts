// Spec-kitchensink Stage 3 — extract_symbol (+ CSS co-extract) over the substrate. Failure
// discipline (spec §2): a red test is a real port behavior to SURFACE — recorded in
// docs/findings-kitchensink.md, filed via feedback, and (where it touches a spec MUST the op
// can't yet deliver) QUARANTINED, never weakened to match output. Expected sets are
// HAND-CURATED by reading the fixture (spec §2.1).
//
// Two findings surfaced here (adjudicated by bug-reviewer as honest LS-limitations the §2.8
// gate correctly REFUSES — nothing is ever written):
//   · KS-2 — extracting the closure-capturing `buildReport` from the T12 monolith: the scope
//     analysis correctly exports the captured local decls (Node/Accumulator/ROOT_WEIGHT), but
//     the stock LS "Move to a new file" emits a VALUE import for the type-only ones, which the
//     fixture's `verbatimModuleSyntax` rejects → gate refuses. The spec §5 MUST ("tsc is
//     clean") is QUARANTINED; the honest refusal is PINNED alongside.
//   · KS-3 — extracting the sole-export `Widget` with css:'copy-safe': the CSS report is
//     correct (independent of apply), but the TS extract leaves the source without a `Widget`
//     export so its importers (incl. the lazy-registry dynamic `m.Widget`) dangle → gate
//     refuses. Spec §5 line 118 asks only for the CSS report dimension, which IS delivered, so
//     this is PINNED green.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { coldDiagnostics } from '../helpers/cold-ls.ts';
import { projectFromDir } from '../helpers/repo-fixture.ts';
import type { TestProject } from '../helpers/project.ts';
import type { JsonValue } from '../../src/core/json.ts';

interface CssReport {
  sourceStylesheet: string;
  targetStylesheet: string;
  moved: string[];
  leftBehind: { class: string; code: string }[];
}
interface Envelope {
  mode: string;
  diff: string;
  touched: string[];
  typecheck: { clean: boolean; introduced?: { message: string }[]; preExisting?: number };
  applied?: boolean;
  reason?: string;
  notes?: string[];
  cssCoExtract?: CssReport[];
}

async function extract(p: TestProject, args: JsonValue, apply = false): Promise<Envelope> {
  const [r] = await p.request([
    { name: 'extract_symbol', args, ...(apply ? { apply: true } : {}) },
  ]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected op ok, got ${JSON.stringify(r)}`);
  return r.result.data as unknown as Envelope;
}

const diagText = (e: Envelope): string =>
  (e.typecheck.introduced ?? []).map((d) => d.message).join('\n');

void describe('kitchensink extract_symbol (Stage 3 — scope analysis + CSS co-extract)', () => {
  // T12 / KS-2 — `buildReport` (top-level export in mono.ts) captures the local non-exported
  // decls Node, Accumulator, ROOT_WEIGHT plus the imported formatLabel. The extract's scope
  // analysis MUST carry them; the question the trap poses is whether the moved file resolves
  // them cleanly. It does NOT (yet) under the fixture's verbatimModuleSyntax — see the
  // quarantined sibling test. Here we PIN the honest behavior: the captures ARE identified
  // (the source gains the right exports) and the gate REFUSES the incomplete result.
  test('buildReport — captures identified; extract honestly refused under verbatimModuleSyntax (KS-2)', async () => {
    const p = await projectFromDir('kitchensink');
    try {
      const env = await extract(
        p,
        { name: 'buildReport', dest: 'src/features/misc/report.ts' },
        true,
      );

      // Honest refusal: the §2.8 gate caught a non-clean post-extract typecheck — nothing written.
      assert.notEqual(env.applied, true);
      assert.equal(env.typecheck.clean, false);
      assert.match(String(env.reason), /apply refused/);
      assert.equal(p.git('status', '--porcelain'), ''); // zero writes
      assert.ok(!existsSync(path.join(p.root, 'src/features/misc/report.ts')));

      // The scope analysis DID identify every captured local — the source diff exports them
      // (proof the failure is ONLY the type-only-import emission, not missed capture).
      assert.match(env.diff, /export interface Node/);
      assert.match(env.diff, /export interface Accumulator/);
      assert.match(env.diff, /export const ROOT_WEIGHT/);

      // KS-2 — the precise blocker: a type-only capture imported as a value under verbatimModuleSyntax.
      assert.match(
        diagText(env),
        /must be imported using a type-only import when 'verbatimModuleSyntax'/,
      );
    } finally {
      await p.dispose();
    }
  });

  // QUARANTINE(KS-2): spec §5 line 116 requires the extracted closure-capturing helper to
  // import its captured outer-scope types/vars AND be tsc-clean. codemaster cannot deliver that
  // here — the stock LS "Move to a new file" emits a value import for the type-only captures
  // (Node/Accumulator), which fails verbatimModuleSyntax — and this is a test-writing task (no
  // prod fix, spec §1). Filed as a bug via feedback; pinned-refusal lives in the test above.
  // Un-skip the day extract splits type-only captures into `import type` (then this proves the
  // spec MUST and the sibling pinned-refusal flips loudly).
  test(
    'buildReport — extract is tsc-clean and the new file type-imports its captures (spec §5 MUST)',
    {
      skip: 'QUARANTINE(KS-2): extract emits a value import for type-only captures; fails verbatimModuleSyntax',
    },
    async () => {
      const p = await projectFromDir('kitchensink');
      try {
        const env = await extract(
          p,
          { name: 'buildReport', dest: 'src/features/misc/report.ts' },
          true,
        );
        assert.equal(env.applied, true);
        assert.equal(env.typecheck.clean, true);
        assert.deepEqual(coldDiagnostics(p.root), []);
        const report = readFileSync(path.join(p.root, 'src/features/misc/report.ts'), 'utf8');
        assert.match(report, /import type \{[^}]*\bNode\b/); // type-only capture, type-imported
        assert.match(report, /ROOT_WEIGHT/); // value capture carried
        assert.match(report, /formatLabel/); // the cross-module import preserved
      } finally {
        await p.dispose();
      }
    },
  );

  // S1 / §4.3.1 / KS-3 — co-extract `Widget` (sole export of Widget.tsx) with the selector-zoo
  // sheet. The TS extract is refused (the sole export leaves no `Widget` in the source → its
  // importers, incl. the lazy-registry dynamic `m.Widget`, dangle), but the CSS classification
  // report is computed independent of apply (spec §5 line 118 asks only for THIS dimension).
  //
  // INDEPENDENT hand classification of Widget.module.scss for the classes Widget references
  // (s.card, s.title, s.badge, s['block__el']):
  //   · title, badge — simple single-class owned rules → SAFE → MOVED.
  //   · card        — entangled (`.card .row`, `.card>.head`, `.card{.nested}`, `.card{&.active}`,
  //                   comma group, `:hover`) → unsafe; codemaster reports the NESTED reason.
  //   · block__el   — declared only as the BEM `&__el` concat (not synthesized into a flat
  //                   selector — a separately-known scss gap) → NO-RULE (no flat rule to move).
  test('Widget — CSS co-extract report is correct (moved safe / left unsafe); TS extract refused (KS-3)', async () => {
    const p = await projectFromDir('kitchensink');
    try {
      const env = await extract(
        p,
        { name: 'Widget', dest: 'src/features/card/Widget.tsx', css: 'copy-safe' },
        true,
      );

      // The CSS report dimension (spec §5 line 118), checked against the hand classification.
      const report = (env.cssCoExtract ?? []).find((r) =>
        r.sourceStylesheet.endsWith('widget/Widget.module.scss'),
      );
      assert.ok(
        report !== undefined,
        `expected a css report, got ${JSON.stringify(env.cssCoExtract)}`,
      );
      assert.deepEqual([...report.moved].sort(), ['badge', 'title']); // provably-safe, moved
      const codes = Object.fromEntries(report.leftBehind.map((l) => [l.class, l.code]));
      assert.equal(codes['card'], 'NESTED'); // entangled — left behind
      assert.equal(codes['block__el'], 'NO-RULE'); // BEM concat not synthesized — no flat rule

      // KS-3 — the TS side is honestly refused (sole-export extract dangles its importers).
      assert.notEqual(env.applied, true);
      assert.equal(env.typecheck.clean, false);
      assert.match(diagText(env), /no exported member 'Widget'/);
      assert.equal(p.git('status', '--porcelain'), ''); // zero writes
      assert.ok(!existsSync(path.join(p.root, 'src/features/card/Widget.tsx')));
    } finally {
      await p.dispose();
    }
  });
});
