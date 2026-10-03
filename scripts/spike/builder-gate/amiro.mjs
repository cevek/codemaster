// Spike t-820012 — the builder chain on a real repo, one scenario per process (fresh LS).
//
//   node --expose-gc scripts/spike/builder-gate/amiro.mjs <root> <scenario> [--full=all|p1|none]
//   scenario: leaf | form-model | hub | move-file | cancel | pick
//
// Chain: P0 baseline (no old builder = full) → P1 overlay → P2 overlay cleared → P3 overlay again
// (= the post-apply disk state, same bytes) . Each pass: B_k = builder(LS program, B_{k-1}),
// drained, all diagnostics read. `--full` adds the oracle/reference pass (a fresh checker over the
// same SourceFiles): equivalence + what the current gate pays per pass.

import path from 'node:path';
import ts from 'typescript';
import {
  createHost,
  builderPass,
  fullPass,
  compare,
  applyEdits,
  heapMB,
  fmt,
  lsKeys,
} from './lib.mjs';
import { presign } from './presign.mjs';

const [root, scenario, ...flags] = process.argv.slice(2);
const fullMode = (flags.find((f) => f.startsWith('--full=')) ?? '--full=all').slice(7);
const log = (s) => process.stdout.write(`${s}\n`);

const fmtOpts = ts.getDefaultFormatCodeSettings('\n');
const prefs = { allowTextChangesInNewFiles: true, quotePreference: 'single' };

function importerCounts(program, rootSet) {
  const counts = new Map();
  for (const sf of program.getSourceFiles()) {
    if (!rootSet.has(sf.fileName)) continue;
    for (const lit of sf.imports ?? []) {
      const r = program.getResolvedModuleFromModuleSpecifier(lit, sf)?.resolvedModule;
      if (r === undefined || !rootSet.has(r.resolvedFileName)) continue;
      const s = counts.get(r.resolvedFileName) ?? new Set();
      s.add(sf.fileName);
      counts.set(r.resolvedFileName, s);
    }
  }
  return counts;
}

/** Transitive reverse-import closure size — the upper bound of what a signature change rechecks. */
function reverseClosure(counts, file) {
  const rev = counts;
  const seen = new Set([file]);
  const q = [file];
  while (q.length)
    for (const i of rev.get(q.pop()) ?? []) if (!seen.has(i)) (seen.add(i), q.push(i));
  return seen.size;
}

/** LS "Move to a new file" on the first top-level statement accepted by `want` that the LS can
 *  move — the same refactor extract_symbol drives. */
function moveToNewFile(host, file, want) {
  const sf = host.service.getProgram().getSourceFile(file);
  for (const st of sf.statements) {
    if (!want(st)) continue;
    const range = { pos: st.getStart(sf), end: st.end };
    const app = host.service.getApplicableRefactors(file, range, prefs);
    if (!app.some((r) => r.name === 'Move to a new file')) continue;
    let ed;
    try {
      ed = host.service.getEditsForRefactor(
        file,
        fmtOpts,
        range,
        'Move to a new file',
        'Move to a new file',
        prefs,
      );
    } catch {
      continue; // the stock-LS assertions codemaster rescues with the fork (§4) — just skip
    }
    if (ed === undefined || ed.edits.length === 0) continue;
    const name = st.name?.text ?? st.declarationList?.declarations[0]?.name?.getText(sf) ?? '?';
    return { name, edits: ed.edits };
  }
  return undefined;
}

const isExported = (st) => ts.getCombinedModifierFlags(st) & ts.ModifierFlags.Export;
const isDecl = (st) =>
  ts.isFunctionDeclaration(st) ||
  ts.isVariableStatement(st) ||
  ts.isInterfaceDeclaration(st) ||
  ts.isTypeAliasDeclaration(st);

function pickEdit(host, counts, rootSet, kind) {
  const rel = (f) => path.relative(root, f);
  const files = [...rootSet].sort();
  if (kind === 'form-model') {
    const f = path.join(root, 'src/lib/forms/form-model.ts');
    const m = moveToNewFile(host, f, (st) => isDecl(st) && isExported(st));
    return m && { file: f, ...m, entries: applyEdits(host, m.edits), removed: [] };
  }
  if (kind === 'leaf') {
    for (const f of files) {
      if (!f.endsWith('.tsx') || f.includes('.test.') || f.includes('.story.') || counts.has(f))
        continue;
      const m = moveToNewFile(host, f, (st) => ts.isFunctionDeclaration(st) && !isExported(st));
      if (m) return { file: f, ...m, entries: applyEdits(host, m.edits), removed: [] };
    }
  }
  if (kind === 'hub') {
    const ranked = [...counts]
      .filter(([f]) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
      .sort((a, b) => b[1].size - a[1].size);
    for (const [f] of ranked.slice(0, 15)) {
      const m = moveToNewFile(
        host,
        f,
        (st) => (ts.isFunctionDeclaration(st) || ts.isVariableStatement(st)) && isExported(st),
      );
      if (m) return { file: f, ...m, entries: applyEdits(host, m.edits), removed: [] };
    }
  }
  if (kind === 'move-file-missed') {
    // Positive control on the real repo: one importer's rewrite is dropped → it must dangle
    // (amiro is otherwise error-free, so a clean-vs-clean EQUAL proves nothing about soundness).
    const e = pickEdit(host, counts, rootSet, 'move-file');
    const victim = e.entries.find((x) => !x.abs.endsWith('-moved.ts'));
    return {
      ...e,
      name: `${e.name} (missed ${path.relative(root, victim.abs)})`,
      entries: e.entries.filter((x) => x !== victim),
    };
  }
  if (kind === 'move-file') {
    const mid = [...counts]
      .filter(([f, s]) => f.endsWith('.ts') && s.size >= 5 && s.size <= 15)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const [f] = mid[0];
    const to = f.replace(/\.ts$/, '-moved.ts');
    const edits = host.service.getEditsForFileRename(f, to, fmtOpts, prefs);
    const entries = applyEdits(host, edits).map((e) => (e.abs === f ? { ...e, abs: to } : e));
    if (!entries.some((e) => e.abs === to)) entries.push({ abs: to, content: host.read(f) });
    return { file: f, name: `→ ${rel(to)}`, edits, entries, removed: [f] };
  }
  return undefined;
}

function report(label, b, full) {
  const eq = full ? compare(b.keys, full.keys) : undefined;
  log(
    `${label.padEnd(10)} builder total=${fmt(b.ms.total)}s (program ${fmt(b.ms.program)} create ${fmt(b.ms.create)} drain ${fmt(b.ms.drain)} read ${fmt(b.ms.read)})` +
      ` drained=${b.drained} rechecked=${b.rechecked.length}/${b.files} diags=${b.keys.length} heap=${heapMB()}MB` +
      (full
        ? ` | full=${fmt(full.ms.total)}s (program ${fmt(full.ms.program)} check ${fmt(full.ms.check)}) ${eq.equal ? 'EQUAL' : `DIFF builder-only=${eq.onlyA.length} full-only=${eq.onlyB.length}`}`
        : ''),
  );
  if (eq && !eq.equal)
    log(
      `   builder-only ${JSON.stringify(eq.onlyA.slice(0, 5))}\n   full-only ${JSON.stringify(eq.onlyB.slice(0, 5))}`,
    );
}

/** Changed files + the union reverse-import closure of every changed/removed file (an upper bound
 *  of what a signature change can force the builder to recheck). */
function describe(e) {
  const changed = [...e.entries.map((x) => x.abs), ...e.removed];
  const seen = new Set();
  const q = changed.filter((f) => rootSet.has(f));
  for (const f of q) seen.add(f);
  while (q.length)
    for (const i of counts.get(q.pop()) ?? []) if (!seen.has(i)) (seen.add(i), q.push(i));
  const shown = e.entries
    .slice(0, 4)
    .map((x) => path.relative(root, x.abs))
    .join(', ');
  return `${path.relative(root, e.file)} ${e.name} overlayFiles=${e.entries.length} [${shown}${e.entries.length > 4 ? ', …' : ''}] removed=${e.removed.length} importersOfSource=${counts.get(e.file)?.size ?? 0} closureOfChanged=${seen.size}`;
}

const host = createHost({ root });
log(`root=${root} scenario=${scenario} ts=${ts.version} heap0=${heapMB()}MB`);
let t = performance.now();
const program0 = host.service.getProgram();
log(
  `LS program build ${fmt(performance.now() - t)}s files=${program0.getSourceFiles().length} roots=${host.rootFiles().length} heap=${heapMB()}MB`,
);
const rootSet = new Set(host.rootFiles());
const counts = importerCounts(program0, rootSet);

if (scenario === 'pick') {
  for (const k of ['leaf', 'form-model', 'hub', 'move-file']) {
    const e = pickEdit(host, counts, rootSet, k);
    log(`${k}: ${e ? describe(e) : 'NONE'}`);
  }
  process.exit(0);
}

const wantFull = (p) => fullMode === 'all' || (fullMode === 'p1' && (p === 'P1' || p === 'G1'));

if (scenario === 'cancel') {
  // P0 cancelled after 200 rechecks, then resumed on the SAME builder; then an overlay pass
  // cancelled after 5 rechecks and resumed. Each resumed result is compared with the full pass.
  const edit = pickEdit(host, counts, rootSet, 'move-file-missed');
  for (const [label, after, setup] of [
    ['P0', 200, () => {}],
    ['P1', 5, () => host.setOverlay(edit.entries, edit.removed)],
  ]) {
    setup();
    const program = host.service.getProgram();
    let n = 0;
    const orig = program.getBindAndCheckDiagnostics.bind(program);
    program.getBindAndCheckDiagnostics = (sf, ct) => (n++, orig(sf, ct));
    const token = {
      isCancellationRequested: () => n >= after,
      throwIfCancellationRequested() {
        if (n >= after) throw new ts.OperationCanceledException();
      },
    };
    globalThis.__b = globalThis.__b
      ? ts.createSemanticDiagnosticsBuilderProgram(
          program,
          { useCaseSensitiveFileNames: () => true, createHash: ts.sys.createHash },
          globalThis.__b,
        )
      : ts.createSemanticDiagnosticsBuilderProgram(program, {
          useCaseSensitiveFileNames: () => true,
          createHash: ts.sys.createHash,
        });
    let threw = 'no';
    try {
      while (globalThis.__b.getSemanticDiagnosticsOfNextAffectedFile(token));
    } catch (e) {
      threw = e instanceof ts.OperationCanceledException ? 'OperationCanceledException' : String(e);
    }
    const atCancel = n;
    const resumed = builderPass(host, globalThis.__b);
    // builderPass made a NEW builder over the same program from the cancelled one — the realistic
    // "next gate call after a timeout" — plus the resumed state must equal the oracle.
    const full = fullPass(resumed.program, host);
    const eq = compare(resumed.keys, full.keys);
    log(
      `${label} cancel after ${after}: threw=${threw} rechecked-before-cancel=${atCancel}; resumed rechecked=${resumed.rechecked.length} ${eq.equal ? 'EQUAL' : `DIFF ${eq.onlyA.length}/${eq.onlyB.length}`}`,
    );
    globalThis.__b = resumed.builder;
  }
  process.exit(0);
}

const edit = pickEdit(host, counts, rootSet, scenario);
if (edit === undefined) throw new Error(`no edit for ${scenario}`);
log(`edit: ${describe(edit)}`);

const lsMode = flags.includes('--mode=ls');

/** Control: the CURRENT gate's surface (service.get{Syntactic,Semantic}Diagnostics per root file
 *  on the LS's own new Program) — its time per pass and the heap it leaves behind. */
function lsStep(label) {
  const t0 = performance.now();
  const keys = lsKeys(host);
  log(
    `${label.padEnd(10)} LS-surface pass=${fmt(performance.now() - t0)}s diags=${keys.length} heap=${heapMB()}MB`,
  );
}

function step(label, prev) {
  if (lsMode) return lsStep(label);
  const b = builderPass(host, prev);
  const full = wantFull(label.slice(0, 2)) ? fullPass(b.program, host) : undefined;
  report(label, b, full);
  return b.builder;
}

// --chain=linear: each pass derives from the previous one (P0→P1→P2→P3).
// --chain=gate (default): the integration shape — the disk-state builder B0 is KEPT and every
// overlay pass branches from it; the post-apply pass (disk now holds the overlay bytes under new
// versions) derives from the overlay builder; a later baseline on unchanged disk branches from B0.
const linear = flags.includes('--chain=linear');
let prev;
let b0;
let b1;
const passes = linear
  ? [
      ['P0 base', () => {}, () => prev],
      ['P1 overlay', () => host.setOverlay(edit.entries, edit.removed), () => prev],
      ['P2 clear', () => host.clearOverlay(), () => prev],
      ['P3 again', () => host.setOverlay(edit.entries, edit.removed), () => prev],
    ]
  : [
      ['G0 base', () => {}, () => undefined],
      ['G1 overlay←B0', () => host.setOverlay(edit.entries, edit.removed), () => b0],
      ['G2 postwrite←B1', () => host.setOverlay(edit.entries, edit.removed), () => b1],
      ['G3 disk←B0', () => host.clearOverlay(), () => b0],
      ['G4 overlay←B0', () => host.setOverlay(edit.entries, edit.removed), () => b0],
    ];
// --presign: before an overlay pass branches from B0, record the real d.ts signature of every
// existing file the overlay will change (on the LS's current disk-state program).
// --release: releaseProgram() on every builder once drained — a kept builder then holds only its
// state (signatures, references, cached diagnostics), not its Program + checker.
const presignOn = flags.includes('--presign');
const releaseOn = flags.includes('--release');
for (const [label, act, from] of passes) {
  if (presignOn && label.includes('overlay←B0')) {
    const t = performance.now();
    const n = presign(
      b0,
      edit.entries.map((e) => e.abs),
      host.service.getProgram(),
    );
    log(`           presign ${n} files ${fmt(performance.now() - t)}s`);
  }
  act();
  prev = step(label, from());
  if (releaseOn) prev.releaseProgram();
  if (label.startsWith('G0')) b0 = prev;
  if (label.startsWith('G1')) b1 = prev;
  // Settled heap: only the LS + the CURRENT builder alive (b/full dropped by scope, B_{k-1} by
  // the reassignment above) — what a daemon holding the chain would retain between gate calls.
  log(`           settled heap (LS + current builder) = ${heapMB()}MB`);
}
prev = undefined;
b0 = undefined;
b1 = undefined;
log(`           heap LS only (builder dropped) = ${heapMB()}MB`);
