// `impact_type_error` Case B (t-534369): the CLEAN widen-to-`any` masking. A trial edit can collapse
// the edited symbol's OWN inferred type to `any` with NO intra-file error — `any` is assignable
// everywhere, so it produces FEWER downstream errors and the diff-of-diagnostics ("introduced errors
// vs baseline") fundamentally CANNOT see the masked break. The op still reports `clean:true` — HONESTLY,
// since no tsc error was introduced — so the masking can ONLY surface from the overlay TYPE vs baseline
// (`ts.overlaySymbolType`), the `widenedToAny` verdict flag. Split from impact-type-error.test.ts for
// the 300-line cap; the oracle is a cold `ts.Program` compiled with the SAME collapse showing 0
// downstream errors, so the reviewer sees the honesty comes from the FLAG, not the diagnostics (§16).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { coldDiagnosticFilesWithEdit } from '../helpers/cold-ls.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

type Verdict = {
  brokenFiles: number;
  editSiteBroke: boolean;
  widenedToAny: boolean;
  downstreamTrusted: boolean;
  clean: boolean;
};

function verdictOf(r: OpResult): { verdict: Verdict; notes?: string[]; brokenBy?: string[] } {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return r.result.data as { verdict: Verdict; notes?: string[]; brokenBy?: string[] };
}

const FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/model.ts': 'export const model = { a: 1 };\n',
  // Reads `model.a` as a number — baseline clean; goes RED iff `a` is really a string.
  'src/reader.ts': "import { model } from './model';\nexport const r: number = model.a;\n",
};

test('CONTROL: a precise retype genuinely breaks the reader — no widen, downstream trustworthy', async () => {
  const p = await project(FILES);
  try {
    const d = verdictOf(
      await p.op('impact_type_error', {
        name: 'model',
        edit: { replace: "export const model = { a: 'x' };" },
      }),
    );
    assert.equal(d.verdict.widenedToAny, false, 'a precise retype is not a widen to any');
    assert.equal(d.verdict.editSiteBroke, false, 'a well-formed edit does not break the edit site');
    assert.equal(d.verdict.downstreamTrusted, true, 'a precise edit → trustworthy downstream');
    assert.equal(d.verdict.brokenFiles, 1, 'the genuine downstream break is reported');
    assert.deepEqual((d.brokenBy ?? []).slice().sort(), ['src/reader.ts']);
  } finally {
    await p.dispose();
  }
});

test('explicit `: any` masks a downstream break — clean:true is honest, widenedToAny/downstreamTrusted:false catch it', async () => {
  const p = await project(FILES);
  try {
    const d = verdictOf(
      await p.op('impact_type_error', {
        name: 'model',
        edit: { replace: 'export const model: any = {};' },
      }),
    );
    // Independent oracle: a cold whole-program compile of the SAME collapse shows 0 downstream
    // errors — so the honesty CANNOT come from the diagnostics diff, only from the verdict flag.
    const oracle = coldDiagnosticFilesWithEdit(
      p.root,
      'src/model.ts',
      'export const model: any = {};\n',
    ).filter((f) => f !== 'src/model.ts');
    assert.deepEqual(
      oracle,
      [],
      'oracle: the reader break is MASKED — tsc reports 0 downstream errors',
    );

    assert.equal(
      d.verdict.editSiteBroke,
      false,
      'a CLEAN widen has NO intra-file error (not Case A)',
    );
    assert.equal(
      d.verdict.widenedToAny,
      true,
      'the collapse to `any` is detected via the overlay type',
    );
    assert.equal(d.verdict.brokenFiles, 0, 'the masked break does not surface as a diagnostic');
    assert.equal(
      d.verdict.clean,
      true,
      'no introduced errors → clean:true is HONEST (the masking trap)',
    );
    assert.equal(
      d.verdict.downstreamTrusted,
      false,
      'clean:true under a widen-to-any is flagged UNTRUSTWORTHY — never sold as a proven-clean downstream',
    );
    assert.ok(
      (d.notes ?? []).some((n) => n.includes('!!') && /widen|`any`|LOWER BOUND/.test(n)),
      'a loud `!!` note explains the widen-to-any masking',
    );
  } finally {
    await p.dispose();
  }
});

test('an INFERRED collapse to any (JSON.parse) is caught too — not only explicit `: any`', async () => {
  const p = await project(FILES);
  try {
    const d = verdictOf(
      await p.op('impact_type_error', {
        name: 'model',
        edit: { replace: "export const model = JSON.parse('{}');" },
      }),
    );
    assert.equal(
      d.verdict.editSiteBroke,
      false,
      'JSON.parse infers `any` with no intra-file error',
    );
    assert.equal(d.verdict.widenedToAny, true, 'an INFERRED collapse to any is flagged');
    assert.equal(d.verdict.downstreamTrusted, false, 'inferred-any masking is flagged too');
  } finally {
    await p.dispose();
  }
});

test('a FUNCTION whose RETURN type collapses to any is caught — the masking vector is `fn()`, not the `() => any` value', async () => {
  // A function's whole type is `() => T`, which never carries TypeFlags.Any even when T is `any`; the
  // masking vector is the RETURN collapsing to `any` (`fn().x` becomes `any` and is silenced). A
  // flag-only whole-type check would miss it — collapseOf must inspect the call-signature return.
  const files = {
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/fn.ts': 'export function fn() { return { a: 1 }; }\n',
    'src/reader.ts': "import { fn } from './fn';\nexport const r: number = fn().a;\n",
  };

  const collapse = await project(files);
  try {
    const d = verdictOf(
      await collapse.op('impact_type_error', {
        name: 'fn',
        edit: { replace: "export function fn() { return JSON.parse('{}'); }" },
      }),
    );
    const oracle = coldDiagnosticFilesWithEdit(
      collapse.root,
      'src/fn.ts',
      "export function fn() { return JSON.parse('{}'); }\n",
    ).filter((f) => f !== 'src/fn.ts');
    assert.deepEqual(oracle, [], 'oracle: the reader break is MASKED — the return went to any');
    assert.equal(d.verdict.widenedToAny, true, 'a function-return collapse to any is detected');
    assert.equal(d.verdict.downstreamTrusted, false, 'the masked function-return break is flagged');
    assert.equal(d.verdict.clean, true, 'no introduced errors — clean:true is honest (the trap)');
  } finally {
    await collapse.dispose();
  }

  // CONTROL — a precise return retype genuinely breaks the reader (no widen).
  const control = await project(files);
  try {
    const d = verdictOf(
      await control.op('impact_type_error', {
        name: 'fn',
        edit: { replace: "export function fn() { return { a: 'x' }; }" },
      }),
    );
    assert.equal(d.verdict.widenedToAny, false, 'a precise return retype is not a widen to any');
    assert.equal(d.verdict.downstreamTrusted, true, 'a precise edit → trustworthy downstream');
    assert.equal(d.verdict.brokenFiles, 1, 'the genuine downstream break is reported');
  } finally {
    await control.dispose();
  }
});

test('collapse to `unknown` is NOT flagged — it introduces errors the diff catches (self-revealing)', async () => {
  // `unknown` is strictly LESS assignable than a precise type, so it INTRODUCES downstream errors
  // (member access on `unknown` errors) rather than masking them. The diff already catches it
  // (clean:false). Flagging widenedToAny would assert a lower-bound that doesn't exist — a
  // false-pessimism lie. So the collapse-to-unknown is detected as a fact but never flagged.
  const p = await project(FILES);
  try {
    const d = verdictOf(
      await p.op('impact_type_error', {
        name: 'model',
        edit: { replace: 'export const model: unknown = { a: 1 };' },
      }),
    );
    assert.equal(d.verdict.widenedToAny, false, 'unknown is not a masking widen — never flagged');
    assert.equal(
      d.verdict.downstreamTrusted,
      true,
      'unknown self-reveals → the downstream is trustworthy',
    );
    assert.equal(
      d.verdict.clean,
      false,
      'unknown INTRODUCES a downstream error (member on unknown)',
    );
    assert.equal(
      d.verdict.brokenFiles,
      1,
      'the unknown-induced break is reported by the diff itself',
    );
  } finally {
    await p.dispose();
  }
});
