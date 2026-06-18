// parseFailures path hygiene (backlog scss — abs-path leak): a stylesheet that fails to parse
// must report a REPO-RELATIVE path, never the machine-absolute one. postcss embeds its `from`
// in the error message; a relative `from` resolves against the daemon cwd (≠ repo root), so the
// leaked path is both machine-specific (breaks golden stability across machines) AND points at a
// file that isn't there. The plugin parses with an absolute `<root>/<rel>` and scrubs the root
// prefix, so the surfaced message carries the repo-relative path the rest of codemaster speaks.
// Oracle = the fixture's own known root + rel (no grep, no golden): the message must contain rel
// and must NOT contain the absolute root anywhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { project } from '../helpers/project.ts';

type Failure = { file: string; message: string };

// A syntactically broken sheet (unclosed block) so postcss throws on parse.
const FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/broken.module.scss': '.a { color: \n',
};

test('a parse-failure message is repo-relative — no absolute root path leaks to the agent', async () => {
  const p = await project(FILES);
  try {
    const r = await p.op('scss_classes', {});
    assert.ok('result' in r && r.result.ok, 'op succeeded (a parse failure is data, not a fault)');
    const failures = (r.result.data as { parseFailures?: Failure[] }).parseFailures ?? [];
    const broken = failures.find((f) => f.file === 'src/broken.module.scss');
    assert.ok(broken !== undefined, 'the broken sheet is reported under parseFailures');

    // The message names the repo-relative path (so the agent can act on it)...
    assert.ok(
      broken.message.includes('src/broken.module.scss'),
      `message carries the rel path: ${broken.message}`,
    );
    // ...with NO absolute prefix before it. Pre-fix postcss embeds `<abs>/src/broken.module.scss`
    // (the abs being daemon-cwd-resolved — machine-specific); the scrub leaves a bare rel path, so
    // a leading-separator path component is the crisp leak signal independent of WHICH abs leaked.
    assert.ok(
      !broken.message.includes('/src/broken.module.scss'),
      `message must not embed an absolute path to the sheet: ${broken.message}`,
    );
    // Belt-and-suspenders: post-fix the plugin parses with `<root>/rel`, so a BROKEN scrub would
    // re-leak the fixture root / temp dir — assert neither appears.
    assert.ok(
      !broken.message.includes(p.root),
      `message must not embed the absolute repo root: ${broken.message}`,
    );
    assert.ok(
      !broken.message.includes(tmpdir()),
      `message must not embed any absolute temp path: ${broken.message}`,
    );
  } finally {
    await p.dispose();
  }
});
