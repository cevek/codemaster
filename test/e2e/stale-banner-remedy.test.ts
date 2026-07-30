// The self-staleness banner NAMES A LEVER — so this test PULLS it (t-034392, t-259465).
//
// CONTRIBUTING's refusal doctrine ("a refusal names a call the agent can run HERE") had no
// machine-checkable form: every remedy string in the tree was prose, asserted at best against
// another prose expectation. A banner that names `node src/bin.ts op …` is falsifiable — the
// command either exists and answers, or it does not. So the oracle here is not a regex over the
// wording: it EXTRACTS the command from the rendered banner and EXECUTES it as a real subprocess,
// against a real fixture repo. It goes red if the CLI surface is renamed, if the path stops being
// correct relative to a checkout root, or if the `op` subcommand stops answering — none of which a
// wording assertion could see.
//
// It also pins the banner's own claim about that command: `one-shot, current src`. A one-shot
// process fingerprints its own source at start, so it can never be behind it. That is proven on the
// surface that CAN print the banner — the CLI `status` render, which calls `renderStatus` and would
// emit the line if the tracker ever said stale. Asserting its absence in an `op` response would
// prove nothing: that path never touches the banner code at all, so the assertion would be green
// under every mutation, including one that broke one-shot freshness outright.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceStaleBanner } from '../../src/format/render/render-status.ts';
import { project } from '../helpers/project.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The command the banner tells the reader to run, taken from the banner itself. Fails loudly
 *  rather than defaulting: a banner that no longer names a runnable command is exactly the
 *  regression this test exists to catch, so "no command found" must not degrade to "nothing to
 *  check". */
function commandFromBanner(banner: string): readonly string[] {
  const quoted = [...banner.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');
  const named = quoted.find((q) => q.startsWith('node '));
  assert.ok(named !== undefined, `the banner names no runnable command: ${banner}`);
  return named.split(' ');
}

test('the banner names a command that RUNS — extracted from the text and executed', async () => {
  const [node, script, subcommand, ...placeholders] = commandFromBanner(
    sourceStaleBanner('daemon'),
  );
  assert.equal(node, 'node');
  assert.ok(script !== undefined && subcommand !== undefined);
  // The remaining tokens must be PLACEHOLDERS, not a literal call: a banner that hardcoded one
  // op/args pair would be pinned green here while telling every reader to run the wrong query.
  assert.deepEqual(placeholders, ['<name>', "'<json>'"], 'the call is a template to fill in');

  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/index.ts': 'export const findMeHere = 1;\n',
  });
  try {
    // Run it EXACTLY as printed — the relative script path, from a checkout root, which is what
    // "from your checkout" means. An absolute path would test a claim the banner does not make.
    const out = execFileSync(
      'node',
      [
        script,
        subcommand,
        'find_definition',
        JSON.stringify({ name: 'findMeHere', file: 'src/index.ts' }),
        '--root',
        p.root,
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
    );
    // It answered the question that was asked (exit 0 alone would also be true of a usage banner).
    assert.match(out, /findMeHere/, `the named command did not answer: ${out}`);
    assert.match(out, /src\/index\.ts/, 'the answer carries its proof span');

    // ...and the banner's "current src" claim holds. Checked on `status`, the one-shot surface that
    // RENDERS the banner (`renderStatus`): its absence there is produced by the staleness tracker
    // answering false, so a one-shot that somehow served pre-edit code would turn this red.
    const status = execFileSync('node', [script, 'status', '--root', p.root], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.match(status, /^codemaster v/, 'the status manifest rendered');
    assert.doesNotMatch(status, /PRE-EDIT codemaster/, 'a one-shot is fresh by construction');
  } finally {
    await p.dispose();
  }
});
