// Task J #1 — the `Changes overlap` assertion is recognized, routed through the §4 rescue, and
// (when the rescue can't) FAILs with a SANITIZED message: the agent never sees the raw stock-LS
// `Debug Failure. False expression: Changes overlap … {"pos":0,"end":244}` string (feedback bug
// 10:12). The routing logic is what codemaster OWNS — whether a given TS build throws the
// assertion is TS's behavior — so it is tested deterministically here against an injected throw,
// with the spec's required message as the independent oracle (no live LS needed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type ts from 'typescript';
import type { TsProjectHost } from '../../src/plugins/ts/ls-host.ts';
import {
  isChangesOverlapAssertion,
  isExtractAssertion,
  isLsDebugFailure,
  requestEditsWithRescue,
} from '../../src/plugins/ts/refactor/extract/taxonomy.ts';

// The verbatim shape the stock LS threw in the field (the raw internals the agent must NOT see).
const RAW_OVERLAP = 'Debug Failure. False expression: Changes overlap. {"pos":0,"end":244}';

/** A host whose primary `service` and optional rescue `service` each throw or return per the
 *  scenario. `requestEditsWithRescue` only touches `host.service` (handed to our callback) and
 *  `host.rescueService()`, so a partial fake is sound. */
function fakeHost(rescue: ts.LanguageService | undefined): TsProjectHost {
  return {
    service: { tag: 'primary' } as unknown as ts.LanguageService,
    rescueService: () => rescue,
  } as unknown as TsProjectHost;
}

test('isChangesOverlapAssertion matches the field shape; predicates stay distinct', () => {
  assert.equal(isChangesOverlapAssertion(RAW_OVERLAP), true);
  assert.equal(isLsDebugFailure(RAW_OVERLAP), true);
  assert.equal(isExtractAssertion(RAW_OVERLAP), false); // a DIFFERENT assertion — no false category
  assert.equal(isChangesOverlapAssertion('Cannot find name foo'), false);
  assert.equal(isChangesOverlapAssertion('Debug Failure. Expected symbol to be a module'), false);
});

test('Changes overlap, rescue unavailable → sanitized FAIL, no raw debug string (extract)', () => {
  const host = fakeHost(undefined); // fork not installed / incompatible
  const out = requestEditsWithRescue(
    host,
    () => {
      throw new Error(RAW_OVERLAP);
    },
    'extract',
  );
  assert.ok('error' in out, 'must be a failure');
  assert.equal(
    out.error,
    'cannot extract: the language service produced overlapping edits for this extract — co-move the interdependent symbols together in one transaction, or extract manually',
  );
  // The honesty oracle: NONE of the raw internal tokens leak to the agent.
  for (const leak of ['Debug Failure', 'False expression', 'Changes overlap.', 'pos', 'end":244']) {
    assert.ok(!out.error.includes(leak), `sanitized message leaked \`${leak}\`: ${out.error}`);
  }
});

test('Changes overlap, verb=move → "cannot move" guidance', () => {
  const out = requestEditsWithRescue(
    fakeHost(undefined),
    () => {
      throw new Error(RAW_OVERLAP);
    },
    'move',
  );
  assert.ok('error' in out);
  assert.equal(
    out.error,
    'cannot move: the language service produced overlapping edits for this move — co-move the interdependent symbols together in one transaction, or move manually',
  );
});

test('Changes overlap, rescue ALSO throws → still sanitized (never the raw string)', () => {
  const rescue = { tag: 'rescue' } as unknown as ts.LanguageService;
  const out = requestEditsWithRescue(
    fakeHost(rescue),
    (svc) => {
      throw new Error(svc === rescue ? 'rescue blew up internally {"pos":0}' : RAW_OVERLAP);
    },
    'extract',
  );
  assert.ok('error' in out);
  assert.equal(
    out.error,
    'cannot extract: the language service produced overlapping edits for this extract — co-move the interdependent symbols together in one transaction, or extract manually',
  );
  assert.ok(!out.error.includes('pos'), 'rescue throw must not leak either');
});

test('Changes overlap, rescue SUCCEEDS → edits returned, rescued flag set', () => {
  const rescue = { tag: 'rescue' } as unknown as ts.LanguageService;
  const good = { edits: [{ fileName: 'x', textChanges: [] }] } as unknown as ts.RefactorEditInfo;
  const out = requestEditsWithRescue(
    fakeHost(rescue),
    (svc) => {
      if (svc === rescue) return good;
      throw new Error(RAW_OVERLAP);
    },
    'extract',
  );
  assert.ok(!('error' in out), `expected edits, got ${JSON.stringify(out)}`);
  assert.equal(out.edits, good);
  assert.equal(out.rescued, true);
});

test('module assertion, rescue unavailable → sanitized ts-ls note, no raw string', () => {
  const out = requestEditsWithRescue(
    fakeHost(undefined),
    () => {
      throw new Error('Debug Failure. Expected symbol to be a module');
    },
    'extract',
  );
  assert.ok('error' in out);
  assert.match(out.error, /^ts-ls-internal:/);
  assert.match(out.error, /patched-LS rescue/);
  assert.ok(!out.error.includes('Expected symbol to be a module'), 'no raw assertion leak');
});

test('unrecognized Debug Failure surfaces raw (honest — a new shape to triage)', () => {
  const out = requestEditsWithRescue(
    fakeHost(undefined),
    () => {
      throw new Error('Debug Failure. Some brand new internal assertion');
    },
    'extract',
  );
  assert.ok('error' in out);
  assert.match(out.error, /internal assertion/);
  assert.match(out.error, /Some brand new internal assertion/); // visible, not mislabeled
});

test('ordinary (non-assertion) throw → plain failure, no rescue attempt', () => {
  let rescueAsked = false;
  const out = requestEditsWithRescue(
    {
      service: {} as unknown as ts.LanguageService,
      rescueService: () => {
        rescueAsked = true;
        return undefined;
      },
    } as unknown as TsProjectHost,
    () => {
      throw new Error('something mundane');
    },
    'extract',
  );
  assert.ok('error' in out);
  assert.equal(out.error, 'extract failed: something mundane');
  assert.equal(rescueAsked, false, 'a non-assertion error must not invoke the rescue');
});

test('no throw → edits passed through, rescued false', () => {
  const good = { edits: [] } as unknown as ts.RefactorEditInfo;
  const out = requestEditsWithRescue(fakeHost(undefined), () => good, 'extract');
  assert.ok(!('error' in out));
  assert.equal(out.edits, good);
  assert.equal(out.rescued, false);
});
