// t-378508 live check: the production write gate (`gateAcross`) over a real repo, builder path vs
// the full LS path, overlay in memory only — the tree is read, never written.
//   node --max-old-space-size=8192 scripts/spike/builder-gate/live.ts <root> <leafRel> <coreRel> [--oracle]
// Work = checker runs per Program instance (the spike's method), so CPU noise cannot fake a hit.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type ts from 'typescript';
import type { RepoRelPath } from '../../../src/core/brands.ts';
import { createTsProjectHost } from '../../../src/plugins/ts/ls-host.ts';
import { gateAcross, type GateHostCtx } from '../../../src/plugins/ts/program-gate.ts';

const [root, leaf, core] = process.argv.slice(2) as [string, string, string];
const oracle = process.argv.includes('--oracle');
const host = createTsProjectHost(root);
const ctx = host.gateHostCtx();
const service = ctx.primary.service;
const perProgram: number[] = [];
const seen = new WeakSet<ts.Program>();
const orig = service.getProgram.bind(service);
interface Checked {
  getBindAndCheckDiagnostics(
    sf: ts.SourceFile,
    ct?: ts.CancellationToken,
  ): readonly ts.Diagnostic[];
}
service.getProgram = () => {
  const p = orig();
  if (p !== undefined && !seen.has(p)) {
    seen.add(p);
    const slot = perProgram.push(0) - 1;
    const t = p as unknown as Checked;
    const check = t.getBindAndCheckDiagnostics.bind(t);
    t.getBindAndCheckDiagnostics = (sf, ct) => {
      if (!sf.fileName.includes('/node_modules/')) perProgram[slot] = (perProgram[slot] ?? 0) + 1;
      return check(sf, ct);
    };
  }
  return p;
};

const all = (ctx.primary.fileNames() as string[]).map(
  (a) => path.relative(root, a).split(path.sep).join('/') as RepoRelPath,
);
const touch = (rel: string, n: number) => ({
  path: rel as RepoRelPath,
  content: `${readFileSync(path.join(root, rel), 'utf8')}\n// gate-live ${n}\n`,
});
const lsOnly = (): GateHostCtx => {
  const { builders: _b, cache: _c, ...rest } = host.gateHostCtx();
  return rest;
};
const key = (ds: readonly { file: string; line: number; message: string }[]) =>
  ds
    .map((d) => `${d.file}|${d.line}|${d.message}`)
    .sort()
    .join('\n');

function run(
  label: string,
  rel: string,
  n: number,
  check: 'all' | 'touched',
  c = host.gateHostCtx(),
) {
  const files = [touch(rel, n)];
  const from = perProgram.length;
  const t0 = performance.now();
  const g = gateAcross(c, files, {
    anchor: [rel as RepoRelPath],
    check: check === 'all' ? all : [rel as RepoRelPath],
  });
  const ms = performance.now() - t0;
  console.log(
    `${label.padEnd(34)} ${(ms / 1000).toFixed(1)}s checked per program=[${perProgram.slice(from).join(',')}] baseline=${g.baseline.length} overlay=${g.overlay.length}`,
  );
  return g;
}

console.log(`files=${all.length} root=${root}`);
run('cold gate (leaf, all)', leaf, 1, 'all');
run('leaf again (all)', leaf, 2, 'all');
const b = run('core (all)', core, 3, 'all');
run('core again (all)', core, 4, 'all');
run('rename-like core (touched)', core, 5, 'touched');
run('rename-like core LS (touched)', core, 6, 'touched', lsOnly());
if (oracle) {
  const o = run('core LS oracle (all)', core, 3, 'all', lsOnly());
  console.log(
    `verdict equal: baseline=${key(b.baseline) === key(o.baseline)} overlay=${key(b.overlay) === key(o.overlay)}`,
  );
}
console.log(`heapUsed=${Math.round(process.memoryUsage().heapUsed / 1048576)}MB`);
host.dispose();
