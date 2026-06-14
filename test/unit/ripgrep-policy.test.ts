// Stage 2 oracle (spec-ci-tooling §3): the ripgrep cross-check oracle must NOT be able to
// silently no-op to green in the CI gate. The decision is extracted into a pure function so
// every (rg-present? × flag-set?) combination is asserted hermetically — we cannot uninstall
// `rg` from the box, so the pure branch is the oracle. The real-`rg` path stays covered by
// the differential/e2e tests + the CI `rg --version` step.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireRg, rgDecision, rgSites } from '../helpers/ripgrep.ts';

test('rgDecision: rg present always runs, with or without the flag', () => {
  assert.equal(rgDecision(true, false), 'run');
  assert.equal(rgDecision(true, true), 'run');
});

test('rgDecision: rg absent skips locally but THROWS under the CI flag', () => {
  assert.equal(rgDecision(false, false), 'skip'); // local dev — honest skip
  assert.equal(rgDecision(false, true), 'throw'); // CI gate — fail loud, never a silent no-op
});

// Env-flag parsing, pinned DIRECTLY and hermetically (no `rg` dependency, so it holds on
// every box including CI): only unset / "" / "0" are OFF; any other value is ON. Guards a
// regression to plain truthiness, which would flip `"0"` → ON. Driving this through `rgSites`
// instead would no-op on any rg-present box (the off/on distinction collapses to 'run'), so
// the parser is tested at its own surface.
test('requireRg: unset / "" / "0" are OFF, every other value is ON', () => {
  const prev = process.env.CODEMASTER_REQUIRE_RG;
  try {
    for (const v of ['', '0']) {
      process.env.CODEMASTER_REQUIRE_RG = v;
      assert.equal(requireRg(), false, `${JSON.stringify(v)} is OFF`);
    }
    delete process.env.CODEMASTER_REQUIRE_RG;
    assert.equal(requireRg(), false, 'unset is OFF');
    for (const v of ['1', 'true', 'yes', 'x']) {
      process.env.CODEMASTER_REQUIRE_RG = v;
      assert.equal(requireRg(), true, `${JSON.stringify(v)} is ON`);
    }
  } finally {
    if (prev === undefined) delete process.env.CODEMASTER_REQUIRE_RG;
    else process.env.CODEMASTER_REQUIRE_RG = prev;
  }
});

// Integration: prove `rgSites` actually wires the policy to behavior on THIS box, honestly
// for either availability. We probe availability via the no-flag path (absent → undefined),
// then assert the flag's effect: throw when absent, real sites when present.
test('rgSites honors CODEMASTER_REQUIRE_RG: throws when rg absent, returns sites when present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-rg-'));
  const prev = process.env.CODEMASTER_REQUIRE_RG;
  try {
    writeFileSync(join(dir, 'a.ts'), 'const widget = 1;\nexport const x = widget + widget;\n');

    delete process.env.CODEMASTER_REQUIRE_RG; // probe: no flag → absent yields a skip
    const probe = rgSites(dir, 'widget');

    process.env.CODEMASTER_REQUIRE_RG = '1';
    if (probe === undefined) {
      // rg absent on this box → the flag must make it fail loud, never silently skip.
      assert.throws(() => rgSites(dir, 'widget'), /CODEMASTER_REQUIRE_RG/);
    } else {
      const sites = rgSites(dir, 'widget');
      assert.ok(sites !== undefined, 'rg present under the flag → runs, never skips');
      assert.ok(sites.length >= 1, 'finds the word-boundary matches');
    }
  } finally {
    if (prev === undefined) delete process.env.CODEMASTER_REQUIRE_RG;
    else process.env.CODEMASTER_REQUIRE_RG = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
