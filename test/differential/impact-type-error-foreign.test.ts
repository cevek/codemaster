// impact_type_error foreign-target honesty (t-733915). find_definition now resolves a sibling-only
// declaration (t-773499), so the trial-edit widen-to-`any` masking probe — which is PRIMARY-only (the
// overlay lives on the primary program) — becomes REACHABLE for a foreign target and would silently
// make no widen claim while `downstreamTrusted` read true (a masking lie). The op guards it upstream:
// a target outside the primary forces `downstreamTrusted:false` + a foreign-program disclosure.
//
// Oracle: the op's OWN verdict on an assembled isolated-package fixture — the `targetOutsidePrimary`
// flag, the forced `downstreamTrusted:false`, and the disclosure note — pinned against a
// primary-resident control that must stay trusted (no false demotion).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';
import type { JsonValue } from '../../src/core/json.ts';

const C = '"strict":true,"module":"esnext","moduleResolution":"bundler","skipLibCheck":true';

const ISO = {
  'package.json': '{"name":"root","private":true}',
  'tsconfig.json': `{"compilerOptions":{${C}},"include":["scripts"]}`,
  'scripts/build.ts':
    'export function primaryFn(n: number): number {\n  return n + 1;\n}\nexport const primaryUse: number = primaryFn(1);\n',
  'web/package.json': '{"name":"web","private":true}',
  'web/tsconfig.json': `{"compilerOptions":{${C}},"include":["src"]}`,
  'web/src/widget.ts':
    'export function widgetHelper(x: number): number {\n  return x + 1;\n}\nexport const usesIt: number = widgetHelper(41);\n',
};

function okData(r: OpResult): Record<string, JsonValue> {
  assert.ok('result' in r && r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.result.data as Record<string, JsonValue>;
}
type Verdict = { downstreamTrusted: boolean; targetOutsidePrimary?: boolean };

test('impact_type_error: a non-primary target forces downstreamTrusted:false + a foreign-program disclosure', async () => {
  const p: TestProject = await project(ISO);
  try {
    const d = okData(
      await p.op('impact_type_error', {
        name: 'widgetHelper',
        file: 'web/src/widget.ts',
        edit: { replace: 'export function widgetHelper(x: any): any {\n  return x;\n}' },
      }),
    );
    const verdict = d.verdict as Verdict;
    // Before the fix this read downstreamTrusted:true — a masking lie (the any-widen probe is
    // primary-only, so it silently made no widen claim for the sibling-resident target).
    assert.equal(verdict.targetOutsidePrimary, true, JSON.stringify(verdict));
    assert.equal(verdict.downstreamTrusted, false, 'the downstream is a LOWER BOUND, not clean');
    const notes = (d.notes as string[]) ?? [];
    assert.ok(
      notes.some((n) => /outside the primary program/i.test(n) && /LOWER BOUND/i.test(n)),
      `the disclosure names the primary-only probe limit: ${JSON.stringify(notes)}`,
    );
  } finally {
    await p.dispose();
  }
});

test('impact_type_error: a PRIMARY-resident target stays trusted (no false foreign-program demotion)', async () => {
  const p: TestProject = await project(ISO);
  try {
    const d = okData(
      await p.op('impact_type_error', {
        name: 'primaryFn',
        file: 'scripts/build.ts',
        edit: { replace: 'export function primaryFn(n: number): number {\n  return n + 2;\n}' },
      }),
    );
    const verdict = d.verdict as Verdict;
    assert.equal(verdict.targetOutsidePrimary, undefined, 'not flagged foreign');
    assert.equal(verdict.downstreamTrusted, true, 'a clean primary edit stays trusted');
  } finally {
    await p.dispose();
  }
});
