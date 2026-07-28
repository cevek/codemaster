// Composition on the CLI (t-631032): `codemaster batch '<json>' --sql '<SELECT>'` and the single-op
// `codemaster op <name> … --sql '<SELECT>'`. The point is PARITY — the one-shot path must answer a
// composed question exactly as the MCP surface does, so an agent on either front door gets the same
// answer, and neither surface is a reduced version of the other.
//
// Oracles, none of them "the flag parsed":
//  (1) BEHAVIOUR — the absence-audit anti-join (t-933867) over a fixture whose hole set is known by
//      construction, run through a real `node src/bin.ts` subprocess;
//  (2) BYTE-PARITY — the CLI's stdout equals `renderBatch(...)` over the SAME requests dispatched
//      in-process. This is the check that fails if the CLI ever assembles its own envelope instead
//      of rendering the one the engine produced — the failure mode that silently drops an ambient
//      honesty channel (disclosures / freshness / truncation), which a same-rows assertion passes;
//  (3) the §11 sql invariants on this path: producers run UNCAPPED, and a failed producer fails the
//      SELECT (named) without sinking its independent neighbour.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project } from '../helpers/project.ts';
import { renderBatch } from '../../src/mcp/render-response.ts';
import type { OpRequest } from '../../src/ops/contracts.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(repoRoot, 'src', 'bin.ts');

type Run = { status: number | null; stdout: string; stderr: string };
function runCli(args: string[]): Run {
  const r = spawnSync('node', [BIN, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A REDUCED copy of `test/e2e/sql-absence-audit.test.ts`'s family: a/c call the guard, b/d do not,
 *  so the hole set is `{b, d}` by construction. That file's `e`/`e-helper` pair (a member calling
 *  the guard only from a helper, which the file-keyed join reports as a hole) is deliberately left
 *  OUT — it pins the recipe's residual-error direction, which is that test's subject, not this
 *  one's. This test asks only whether the CLI reaches the same answer as the in-process path, so it
 *  keeps its own input rather than sharing a map whose expectations belong to another oracle (§16:
 *  a fixture is input, never shared truth). Do not "restore the drift". */
const OPS_FAMILY = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/reg.ts': `export function defineOp<T>(d: T): T { return d; }\nexport const guardCheck = (n: number): boolean => n > 0;\n`,
  'src/ops/a.ts': `import { defineOp, guardCheck } from '../reg';\nexport const aOp = defineOp({ run: () => guardCheck(1) });\n`,
  'src/ops/b.ts': `import { defineOp } from '../reg';\nexport const bOp = defineOp({ run: () => 2 });\n`,
  'src/ops/c.ts': `import { defineOp, guardCheck } from '../reg';\nexport const cOp = defineOp({ run: () => guardCheck(3) });\n`,
  'src/ops/d.ts': `import { defineOp } from '../reg';\nexport const dOp = defineOp({ run: () => 4 });\n`,
};

const ANTI_JOIN_REQUESTS: OpRequest[] = [
  {
    name: 'find_usages',
    as: 'fam',
    args: { name: 'defineOp', role: 'call', filter: { pathInclude: ['src/ops/**'] } },
  },
  { name: 'find_usages', as: 'f', args: { name: 'guardCheck', role: 'call' } },
];
const ANTI_JOIN_SQL =
  'SELECT fam.file FROM fam WHERE fam.file NOT IN (SELECT file FROM f) ORDER BY fam.file';

test('the absence-audit anti-join runs on the CLI and returns the fixture hole set', async () => {
  const p = await project(OPS_FAMILY);
  try {
    const r = runCli([
      'batch',
      JSON.stringify(ANTI_JOIN_REQUESTS),
      '--sql',
      ANTI_JOIN_SQL,
      '--root',
      p.root,
    ]);
    assert.equal(r.status, 0, `exit 0; stderr=${r.stderr}`);
    assert.match(r.stdout, /^src\/ops\/b\.ts$/m, 'b never calls the guard — a hole');
    assert.match(r.stdout, /^src\/ops\/d\.ts$/m, 'd never calls the guard — a hole');
    assert.doesNotMatch(r.stdout, /^src\/ops\/a\.ts$/m, 'a calls it — not a hole');
    assert.doesNotMatch(r.stdout, /^src\/ops\/c\.ts$/m, 'c calls it — not a hole');
  } finally {
    await p.dispose();
  }
});

test('CLI stdout is BYTE-identical to the in-process render of the same composed call', async () => {
  // The parity that matters: not "same rows" but same BYTES, so a dropped honesty channel
  // (disclosures / freshness / truncation lines all render into this text) fails here.
  const p = await project(OPS_FAMILY);
  try {
    const results = await p.request(ANTI_JOIN_REQUESTS, { sql: ANTI_JOIN_SQL });
    const expected = renderBatch(results, ANTI_JOIN_REQUESTS, {
      sqlPresent: true,
      format: undefined,
      verbosity: undefined,
    });
    const r = runCli([
      'batch',
      JSON.stringify(ANTI_JOIN_REQUESTS),
      '--sql',
      ANTI_JOIN_SQL,
      '--root',
      p.root,
    ]);
    assert.equal(r.status, 0, `exit 0; stderr=${r.stderr}`);
    assert.equal(r.stdout, `${expected}\n`, 'CLI renders the engine envelope, never a rebuilt one');
  } finally {
    await p.dispose();
  }
});

test("a producer's resolve-time DISCLOSURE survives the CLI sql path", async () => {
  // The ambient channel (§3.4): the claim is stated deep in target resolution, stamped on the
  // producer's envelope by the dispatcher, merged into the join's envelope by `runSqlBatch`, and
  // rendered by `renderResult`. A CLI path that reassembled anywhere along that chain would print
  // a clean-looking anti-join over a doubtful target — the worst place to drop it.
  const p = await project({
    ...OPS_FAMILY,
    // A nested tsconfig with no package.json, holding a file the primary's `include` does NOT
    // cover, is left unloaded — so a bare-name resolve cannot claim it saw every same-named
    // declaration, and says so. (Covered by the primary it would be subtracted, no doubt.)
    'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src"]}',
    'nested/tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'nested/other.ts': 'export const unrelated = 1;\n',
  });
  try {
    const r = runCli([
      'batch',
      JSON.stringify(ANTI_JOIN_REQUESTS),
      '--sql',
      ANTI_JOIN_SQL,
      '--root',
      p.root,
    ]);
    assert.equal(r.status, 0, `exit 0; stderr=${r.stderr}`);
    assert.match(
      r.stdout,
      /!! CANNOT CLAIM unsafe=target-is-the-only-symbol-of-this-name/,
      'the disclosure reaches CLI stdout',
    );
  } finally {
    await p.dispose();
  }
});

test('§11 on the CLI: producers run UNCAPPED under --sql (an explicit limit is ignored)', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/x.ts': `export const foo = 1;\n`,
    'src/use.ts': `import { foo } from './x';\nexport const a = foo;\nexport const b = foo;\nexport const c = foo;\nexport const d = foo;\nexport const e = foo;\n`,
  });
  try {
    // Same op, same limit, both surfaces of the CLI: without --sql the op caps at 2…
    const capped = runCli(['op', 'find_usages', '{"name":"foo","limit":2}', '--root', p.root]);
    assert.equal(capped.status, 0, capped.stderr);
    assert.match(capped.stdout, /shown 2\/\d+/, 'without sql the op caps and says so');
    // …with --sql the producer is uncapped, so COUNT(*) sees every row (a capped table feeding a
    // NOT IN would lie — the property the whole sql mode rests on).
    const counted = runCli([
      'op',
      'find_usages',
      '{"name":"foo","limit":2}',
      '--sql',
      'SELECT COUNT(*) AS n FROM t',
      '--root',
      p.root,
    ]);
    assert.equal(counted.status, 0, counted.stderr);
    const n = Number(/^(\d+)$/m.exec(counted.stdout)?.[1]);
    assert.ok(n > 2, `sql sees all rows, not the capped 2 (got ${n})\n${counted.stdout}`);
  } finally {
    await p.dispose();
  }
});

test('§11 on the CLI: a failed producer fails the SELECT (named) but not its neighbour', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/x.ts': `export const foo = 1;\n`,
  });
  try {
    const requests = [
      { name: 'search_symbol', as: 'a', args: { query: 'foo' } },
      { name: 'find_usages', as: 'b', args: { name: 'NoSuchSymbolAnywhere' } },
    ];
    const r = runCli([
      'batch',
      JSON.stringify(requests),
      '--sql',
      'SELECT * FROM a',
      '--return',
      'all',
      '--root',
      p.root,
    ]);
    assert.match(r.stdout, /^\[0\] search_symbol/m, 'the independent neighbour still returns');
    assert.match(
      r.stdout,
      /FAIL tool=sql — SELECT not run — producer\(s\) 'find_usages' \(as b\) failed:/,
      'the sql record names the failed producer with its cause',
    );
    // A ToolFailure is an HONEST answer, not a dispatch rejection — exit code parity with `op`.
    assert.equal(r.status, 0, 'a failed producer is ok:false, not a non-zero exit');
  } finally {
    await p.dispose();
  }
});

test('a dispatch rejection inside a batch exits NON-zero (parity with `op`)', async () => {
  const p = await project(OPS_FAMILY);
  try {
    const r = runCli(['batch', '[{"name":"no_such_op","args":{}}]', '--root', p.root]);
    assert.match(r.stdout, /DISPATCH unknown_op/, 'the rejection is rendered, not swallowed');
    assert.notEqual(r.status, 0, 'a dispatch error is non-zero on the CLI (t-337633)');
  } finally {
    await p.dispose();
  }
});

test('the flat `{op:…}` request envelope dispatches correctly inside a bare requests ARRAY', async () => {
  // The trap the bare-array sugar could reintroduce: `normalizeBatchArguments` only rewrites a
  // `{requests:[…]}` shape, so an array wrapped AFTER normalization would dispatch each request's
  // `name` VALUE ('foo') as the op name. Repro-negative: on that bug this reads `unknown op 'foo'`.
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/x.ts': `export const foo = 1;\nexport const a = foo;\n`,
  });
  try {
    const r = runCli(['batch', '[{"op":"find_usages","name":"foo"}]', '--root', p.root]);
    assert.doesNotMatch(r.stdout, /unknown op 'foo'/, 'the flat envelope is normalized, not split');
    assert.match(r.stdout, /^\[0\] find_usages/m, 'dispatched to the op named by `op`');
    assert.equal(r.status, 0, r.stderr);
  } finally {
    await p.dispose();
  }
});

test("t-141874: `op batch` names the working form instead of answering 'unknown op'", () => {
  const r = runCli(['op', 'batch', '{}']);
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stderr, /unknown op/, 'batch is not unknown — it exists, elsewhere (§3.6)');
  assert.match(r.stderr, /not an op/, 'it says what batch IS');
  assert.match(r.stderr, /codemaster batch/, 'and names the form that works here');
});

test('a name that is genuinely NOT an op still reaches the honest catalogue — prototype keys too', async () => {
  // The other half of t-141874, and the direction that is easy to break while fixing the first:
  // the non-op map must not swallow names it does not own. A bare `MAP[name]` lookup on an object
  // literal answers `constructor`/`toString`/`__proto__` from `Object.prototype` — a native-code
  // string, on the WRONG exit code, in place of the dispatcher's own `unknown_op` + op list.
  const p = await project(OPS_FAMILY);
  try {
    for (const name of ['no_such_op', 'constructor', 'toString', '__proto__']) {
      const r = runCli(['op', name, '{}', '--root', p.root]);
      const all = r.stdout + r.stderr;
      assert.match(all, /unknown op/, `'${name}' reaches the honest rejection`);
      assert.doesNotMatch(
        all,
        /native code|\[object Object\]/,
        `'${name}' answers no prototype junk`,
      );
      assert.equal(r.status, 1, `'${name}' exits as a dispatch error, not a usage error`);
    }
  } finally {
    await p.dispose();
  }
});

test('a batch WITHOUT sql is byte-identical to its in-process render too', async () => {
  // The sql path has its own parity test above; this is the plain multi-op batch — the common case,
  // and the one where the per-request render-flag routing (`requests[i]?.format`) lives.
  const p = await project(OPS_FAMILY);
  try {
    const requests: OpRequest[] = [
      { name: 'search_symbol', args: { query: 'defineOp' } },
      { name: 'find_usages', args: { name: 'guardCheck' }, verbosity: 'normal' },
    ];
    const results = await p.request(requests);
    const expected = renderBatch(results, requests, {
      sqlPresent: false,
      format: undefined,
      verbosity: undefined,
    });
    const r = runCli(['batch', JSON.stringify(requests), '--root', p.root]);
    assert.equal(r.status, 0, `exit 0; stderr=${r.stderr}`);
    assert.equal(r.stdout, `${expected}\n`);
  } finally {
    await p.dispose();
  }
});

test('batch-level --format/--verbosity without --sql are REFUSED, not silently ignored', async () => {
  // They describe the join output; with no join they would pass every gate and change nothing —
  // a `--format json | jq` pipeline would get dense text with no diagnostic (§3 silent-swallow).
  const p = await project(OPS_FAMILY);
  try {
    const r = runCli([
      'batch',
      '[{"name":"search_symbol","args":{"query":"defineOp"}}]',
      '--format',
      'json',
      '--root',
      p.root,
    ]);
    assert.equal(r.status, 2, 'refused');
    assert.match(r.stderr, /--format/, 'names the flag');
    assert.match(r.stderr, /join output only/, 'and why it does not apply here');
    assert.equal(r.stdout, '', 'nothing ran');
  } finally {
    await p.dispose();
  }
});

test('§3 no silent drop: a value-flag written without a value is reported AS THAT', () => {
  // `--sql` with nothing after it used to fall through to the stray check and read "unrecognized
  // flag --sql" — true about the parse, false about the tool, the same shape as t-141874.
  const r = runCli(['batch', '[{"name":"search_symbol","args":{}}]', '--sql']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /without a value/, 'named as missing its value');
  assert.doesNotMatch(r.stderr, /unrecognized/, 'never reported as unrecognized');
});

test('§3 no silent resolve: the same key given as a flag AND in the json is rejected', async () => {
  const p = await project(OPS_FAMILY);
  try {
    const r = runCli([
      'batch',
      '{"requests":[{"name":"search_symbol","args":{"query":"a"}}],"sql":"SELECT 1"}',
      '--sql',
      'SELECT 2',
      '--root',
      p.root,
    ]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /given BOTH/, 'neither spelling is silently preferred');
  } finally {
    await p.dispose();
  }
});
