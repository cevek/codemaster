// Spike for t-378508 — can an EmitAndSemanticDiagnosticsBuilderProgram give the declaration
// diagnostics the LS appends under `declaration:true`, incrementally? Measures parity vs the LS
// surface and counts declaration-diagnostic computations per pass (patched on the Program instance).
//   node scripts/spike/builder-gate/decl.mjs            # inline fixture
//   node scripts/spike/builder-gate/decl.mjs <root> <relFile>   # real repo, append a comment to relFile
import ts from 'typescript';
import path from 'node:path';
import { createHost, diagKey, compare, lsKeys } from './lib.mjs';

const builderHost = {
  useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  createHash: ts.sys.createHash,
};
const isLib = (p, sf) =>
  sf.isDeclarationFile && (p.isSourceFileDefaultLibrary(sf) || sf.fileName.includes('/node_modules/'));

function pass(host, prev) {
  const program = host.service.getProgram();
  const checked = [];
  const declared = [];
  const origC = program.getBindAndCheckDiagnostics.bind(program);
  program.getBindAndCheckDiagnostics = (sf, ct) => (checked.push(sf.fileName), origC(sf, ct));
  const origD = program.getDeclarationDiagnostics.bind(program);
  program.getDeclarationDiagnostics = (sf, ct) => (declared.push(sf?.fileName ?? '(all)'), origD(sf, ct));
  const t0 = performance.now();
  const b = ts.createEmitAndSemanticDiagnosticsBuilderProgram(program, builderHost, prev);
  while (b.getSemanticDiagnosticsOfNextAffectedFile() !== undefined);
  const keys = [];
  for (const sf of program.getSourceFiles()) {
    if (isLib(program, sf)) continue;
    for (const d of program.getSyntacticDiagnostics(sf)) keys.push(diagKey(d));
    for (const d of b.getSemanticDiagnostics(sf)) keys.push(diagKey(d));
    for (const d of b.getDeclarationDiagnostics(sf)) keys.push(diagKey(d));
  }
  const ms = performance.now() - t0;
  return { b, keys, checked: checked.length, declared: declared.length, ms };
}

const real = process.argv[2];
let host;
let edit;
if (real === undefined) {
  const base = { strict: true, declaration: true, ...JSON.parse(process.env.DECL_OPTS ?? '{"noEmit":false,"emitDeclarationOnly":true}'), target: 99, module: 99, moduleResolution: 100 };
  host = createHost({
    root: '/virtual/decl',
    options: base,
    files: {
      'a.ts': 'export const make = () => class { x = 1; };\n',
      'b.ts': "import { make } from './a';\nexport const K = make();\n",
      'z.ts': 'export const z = 1;\n',
    },
  });
  edit = () => [{ abs: '/virtual/decl/a.ts', content: 'export const make = () => class { private x = 1; };\n' }];
} else {
  host = createHost({ root: real });
  const abs = path.join(real, process.argv[3]).split(path.sep).join('/');
  edit = () => [{ abs, content: `${host.read(abs)}\n// touch\n` }];
}
const p0 = pass(host, undefined);
console.log(`B0 cold: checked=${p0.checked} declared=${p0.declared} ms=${p0.ms.toFixed(0)} parityLS=${compare(p0.keys, lsKeys(host)).equal}`);
host.setOverlay(edit());
const p1 = pass(host, p0.b);
const c1 = compare(p1.keys, lsKeys(host));
console.log(`B1 overlay<-B0: checked=${p1.checked} declared=${p1.declared} ms=${p1.ms.toFixed(0)} parityLS=${c1.equal} ${c1.equal ? '' : JSON.stringify(c1)}`);
console.log(`  overlay diags: ${p1.keys.length} (sample ${JSON.stringify(p1.keys.slice(0, 3))})`);
host.clearOverlay();
const p2 = pass(host, p0.b);
console.log(`B2 disk<-B0: checked=${p2.checked} declared=${p2.declared} ms=${p2.ms.toFixed(0)} parityLS=${compare(p2.keys, lsKeys(host)).equal}`);
