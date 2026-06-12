// groupedDispatch must keep results positionally aligned with requests even when an
// engine misbehaves and returns FEWER results than it was sent — a dropped slot would
// silently shrink the array and shift every later result off its request index (a
// positional lie, §3.4). The short slot must carry an explicit error instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RepoId } from '../../src/core/brands.ts';
import type { OpRequest, OpResult } from '../../src/ops/contracts.ts';
import { groupedDispatch, type RouteOutcome, type SpawnHost } from '../../src/daemon/multi-root.ts';
import type { ProjectHost } from '../../src/daemon/host.ts';

function okResult(name: string): OpResult {
  return { name, result: { ok: true, data: name } };
}

test('a short engine reply fills its slot with an explicit error, never shifts later results', async () => {
  const reqs: OpRequest[] = [
    { name: 'a1', args: {} },
    { name: 'b1', args: {} },
    { name: 'a2', args: {} },
  ];
  const routes: RouteOutcome[] = [
    { ok: true, repoId: 'A' as RepoId, root: '/a' },
    { ok: true, repoId: 'B' as RepoId, root: '/b' },
    { ok: true, repoId: 'A' as RepoId, root: '/a' },
  ];
  // Engine A is sent [a1, a2] but (buggy) returns only one result; engine B behaves.
  const spawn: SpawnHost = (repoId) =>
    Promise.resolve({
      ok: true,
      host: {
        request: (sent: readonly OpRequest[]) =>
          Promise.resolve(
            repoId === ('A' as RepoId)
              ? [okResult(sent[0]?.name ?? '?')] // one short
              : sent.map((r) => okResult(r.name)),
          ),
      } as unknown as ProjectHost,
    });

  const results = await groupedDispatch(reqs, routes, undefined, spawn);

  assert.equal(results.length, reqs.length, 'one slot per request, always');
  assert.deepEqual(results[0], okResult('a1'));
  assert.deepEqual(results[1], okResult('b1'), 'B result stays at ITS request index');
  const short = results[2];
  assert.ok(short !== undefined && 'error' in short, 'the short slot carries an error');
  assert.equal(short.name, 'a2');
  assert.match(short.error.message, /codemaster bug/);
});
