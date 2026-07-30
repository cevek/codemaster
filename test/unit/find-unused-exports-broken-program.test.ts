// t-000011, the OTHER half: when the LS produces NO Program at all, nothing is parsed and nothing is
// walked, so an empty `unused` list establishes nothing. Reporting it as `ok` — `unused (0), scanned
// exports=0 files=0` — is an `ok` shaped like a proven absence, which CONTRIBUTING rules out outright:
// a failed establishment is returned as a FAILURE, so the agent falls back to its own means.
//
// Covered at BOTH layers, because they fail independently: the engine must FLAG the missing program
// (a plain zero-count view is indistinguishable from a clean repo), and the op must RAISE that flag
// into a `ToolFailure` (an engine flag nothing reads changes no answer). Reverting either one alone
// must go red here.
//
// No fixture can reach this state — `getProgram()` returns a Program for every real project — so the
// input is a stub at each layer and the assertion is DISCRIMINATION: two inputs differing only in
// "was there a program", two different answer shapes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findUnusedExports, type UnusedExportsView } from '../../src/plugins/ts/unused-exports.ts';
import type { TsProjectHost } from '../../src/plugins/ts/ls-host.ts';
import type { TsPluginApi } from '../../src/plugins/ts/plugin.ts';
import { findUnusedExportsOp } from '../../src/ops/find-unused-exports.ts';
import type { OpContext } from '../../src/ops/registry.ts';
import type { Plugin, PluginRegistry } from '../../src/core/plugin.ts';

/** A host whose LanguageService yields no Program — the shape `getProgram(): Program | undefined`
 *  admits and the only way in: an LS that fell over. Nothing else is reachable, so nothing else is
 *  stubbed. */
const hostWithoutProgram = (): TsProjectHost =>
  ({
    service: { getProgram: () => undefined },
    relOf: (f: string) => f,
    undiscoveredProgramLabels: () => [],
  }) as unknown as TsProjectHost;

/** An op context over a `ts` plugin that returns exactly `view` — the seam the op reads. `daemon` is
 *  absent, so the pre-warm fan-out guard declines to refuse (it never over-refuses where it cannot
 *  confirm in-process isolation) and the op reaches the branch under test. */
function ctxWithView(view: UnusedExportsView): OpContext {
  const ts = {
    id: 'ts',
    unusedExports: () => view,
  } as unknown as TsPluginApi;
  const registry: PluginRegistry = {
    get: <T extends Plugin>(): T => ts as unknown as T,
    has: (id: string) => id === 'ts',
    ids: ['ts'],
  };
  return { plugins: registry, flags: {}, opName: 'find_unused_exports' };
}

const EMPTY_SCAN: UnusedExportsView = {
  unused: [],
  scannedExports: 0,
  scannedFiles: 0,
  computedDynamicImport: false,
};

test('engine: no Program flags `programUnavailable` — it does not return a zero-count view', () => {
  const view = findUnusedExports(hostWithoutProgram());
  assert.equal(view.programUnavailable, true, 'the missing program is reported, not absorbed');
  // The counters are all zero here, which is exactly why the flag has to exist: without it this view
  // is byte-identical to a walked-but-empty scan of a genuinely clean repo.
  assert.deepEqual(
    { unused: view.unused.length, exports: view.scannedExports, files: view.scannedFiles },
    { unused: 0, exports: 0, files: 0 },
  );
});

test('op: a missing Program FAILS (ts-ls) — the same empty view WITHOUT the flag stays an ok answer', async () => {
  const broken = await findUnusedExportsOp.run(
    ctxWithView({ ...EMPTY_SCAN, programUnavailable: true }),
    {},
  );
  const walked = await findUnusedExportsOp.run(ctxWithView(EMPTY_SCAN), {});

  // The load-bearing assert: two views differing ONLY in "was there a program" must not answer alike.
  assert.notEqual(
    broken.ok,
    walked.ok,
    'a scan that could not run and a scan that ran must NOT share a shape',
  );

  assert.equal(broken.ok, false);
  if (broken.ok) return;
  assert.equal(broken.failure.tool, 'ts-ls', 'the failing oracle names itself');
  assert.match(broken.failure.message, /no Program/i, 'and says what could not be established');
  assert.ok(!('data' in broken), 'a failed scan carries no list to misread as a clean repo');

  // The control arm is not merely `ok` — it must still refuse the VERDICT (its walk opened no file),
  // which is the `notAVerdict` marker, not a failure. Two distinct honesty shapes, never merged.
  assert.equal(walked.ok, true);
  if (!walked.ok) return;
  const data = walked.data as { notAVerdict?: string };
  assert.match(data.notAVerdict ?? '', /NOT A VERDICT/);
});
