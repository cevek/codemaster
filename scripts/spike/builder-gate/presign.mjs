// Spike t-820012 — "pre-sign": a cold builder records file VERSIONS as signatures, so the first
// derived builder treats every changed file as having changed its d.ts shape and invalidates its
// whole reverse closure. Computing the real d.ts signature of the files an overlay is ABOUT to
// change, on the baseline program before the overlay is set, removes that penalty if TS's own
// comparison then sees an unchanged shape. Uses the internal ts.BuilderState.computeDtsSignature
// (exported at runtime, absent from typescript.d.ts).
//
//   node scripts/spike/builder-gate/presign.mjs

import ts from 'typescript';
import { createHost, builderPass, fullPass, compare } from './lib.mjs';

const builderHost = { useCaseSensitiveFileNames: () => true, createHash: ts.sys.createHash };

/** Overwrite B's recorded signature of each `abs` with its d.ts hash, computed on `program` — any
 *  program over the SAME text B saw (the LS's current disk-state program), so B's own program may
 *  already be released. */
export function presign(builder, absList, program = builder.state.program) {
  const state = builder.state;
  let n = 0;
  for (const abs of absList) {
    const sf = program.getSourceFile(abs);
    if (sf === undefined || sf.isDeclarationFile || !state.fileInfos.has(sf.resolvedPath)) continue;
    n++;
    ts.BuilderState.computeDtsSignature(program, sf, undefined, builderHost, (sig) => {
      state.fileInfos.get(sf.resolvedPath).signature = sig;
    });
  }
  return n;
}

const R = '/spike';
const files = {
  'a.ts': 'export type T = number;',
  'b.ts': "import type { T } from './a';\nexport type U = T;",
  'c.ts': "import type { U } from './b';\nexport const x: U = 1;",
  'z.ts': 'export const z = 1;',
  'zu.ts': "import { z } from './z';\nexport const zz: number = z;",
};
const options = {
  strict: true,
  noEmit: true,
  isolatedModules: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  types: [],
  lib: ['lib.es2022.d.ts'],
};
const isMain = import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) for (const [label, content, sign] of [
  ['shape-preserving edit, no presign', 'export type T = number; // c', false],
  ['shape-preserving edit, presign', 'export type T = number; // c', true],
  ['shape-CHANGING edit, presign', 'export type T = string;', true],
]) {
  const host = createHost({ root: R, files, options });
  const b0 = builderPass(host, undefined);
  if (sign) presign(b0.builder, [`${R}/a.ts`]);
  host.setOverlay([{ abs: `${R}/a.ts`, content }]);
  const b1 = builderPass(host, b0.builder);
  const f = fullPass(b1.program, host);
  const cmp = compare(b1.keys, f.keys);
  console.log(`${label.padEnd(36)} ${cmp.equal ? 'EQUAL' : 'DIFF'} diags=${f.keys.length} rechecked=[${b1.rechecked.map((x) => x.slice(R.length + 1))}]`);
}
