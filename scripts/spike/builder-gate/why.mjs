// Spike t-820012 — diagnostic: does the builder's own referencedMap explain how many files a
// change to one file forces it to recheck?
//
//   node --max-old-space-size=8192 scripts/spike/builder-gate/why.mjs <root> <repo-rel file>...

import path from 'node:path';
import { createHost, builderPass } from './lib.mjs';

const [root, ...rels] = process.argv.slice(2);
const host = createHost({ root });
const b0 = builderPass(host, undefined);
const st = b0.builder.state;
const keyOf = (rel) => b0.program.getSourceFile(path.join(root, rel)).resolvedPath;

for (const rel of rels) {
  const seen = new Set();
  const q = [keyOf(rel)];
  while (q.length) {
    const p = q.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    for (const k of st.referencedMap.getKeys(p)?.keys() ?? []) q.push(k);
  }
  const fwd = [...(st.referencedMap.getValues(keyOf(rel))?.keys() ?? [])].map((p) =>
    path.relative(root, p),
  );
  const direct = [...(st.referencedMap.getKeys(keyOf(rel))?.keys() ?? [])].map((p) =>
    path.relative(root, p),
  );
  console.log(
    `${rel}: referencedMap reverse closure=${seen.size}; direct referencers=${JSON.stringify(direct.slice(0, 12))}; forward refs=${fwd.length}`,
  );
}
// Distribution over every root file: how much of the repo a d.ts-shape change of that file forces
// the builder to recheck (its referencedMap reverse closure / non-lib files).
if (rels.length === 0) {
  const roots = b0.program
    .getSourceFiles()
    .filter(
      (sf) => !sf.fileName.includes('/node_modules/') && !b0.program.isSourceFileDefaultLibrary(sf),
    );
  const total = roots.length;
  const buckets = new Map([
    [0.01, 0],
    [0.1, 0],
    [0.3, 0],
    [0.5, 0],
    [1, 0],
  ]);
  for (const sf of roots) {
    const seen = new Set();
    const q = [sf.resolvedPath];
    while (q.length) {
      const p = q.pop();
      if (seen.has(p)) continue;
      seen.add(p);
      for (const k of st.referencedMap.getKeys(p)?.keys() ?? []) q.push(k);
    }
    const frac = seen.size / total;
    for (const b of buckets.keys()) if (frac <= b) buckets.set(b, buckets.get(b) + 1);
  }
  console.log(
    `files=${total}; cumulative share of files whose closure ≤ X of repo: ${[...buckets].map(([b, n]) => `≤${b * 100}%: ${n} (${((100 * n) / total).toFixed(1)}%)`).join(', ')}`,
  );
}
const g = [...st.fileInfos]
  .filter(([, i]) => i.affectsGlobalScope)
  .map(([p]) => path.relative(root, p));
console.log(
  `affectsGlobalScope (non-node_modules): ${JSON.stringify(g.filter((p) => !p.includes('node_modules')))}`,
);
