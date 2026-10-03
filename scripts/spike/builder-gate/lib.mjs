// Spike t-820012 — SemanticDiagnosticsBuilderProgram chained over LS programs vs the current
// full-pass typecheck gate. Not production code: a measurement harness, run by hand.
//
// The LS host mirrors src/plugins/ts/program/single.ts (overlay shadows disk, tombstones hide a
// path from fileExists/readFile/script list, overlay versions are `o<counter>`, every set/clear
// bumps the project version) but reads every file from an in-memory SNAPSHOT taken on first read,
// so a live foreign tree that changes mid-run cannot skew a measurement and nothing is ever written.

import path from 'node:path';
import fs from 'node:fs';
import ts from 'typescript';

const posix = (p) => p.split(path.sep).join('/');

/** @param {{root:string, files?:Record<string,string>, options?:ts.CompilerOptions}} cfg
 *  `files` = an inline VFS project (traps); otherwise `root/tsconfig.json` from disk (amiro). */
export function createHost(cfg) {
  const root = posix(cfg.root);
  const inline = cfg.files
    ? new Map(Object.entries(cfg.files).map(([k, v]) => [`${root}/${k}`, v]))
    : undefined;
  const snapshot = new Map(); // abs → text | null (first read wins, forever)
  const readSnap = (abs) => {
    if (snapshot.has(abs)) return snapshot.get(abs) ?? undefined;
    let text;
    if (inline !== undefined && abs.startsWith(`${root}/`)) text = inline.get(abs);
    else {
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        text = undefined;
      }
    }
    snapshot.set(abs, text ?? null);
    return text;
  };

  let options;
  let rootFiles;
  if (inline !== undefined) {
    options = cfg.options;
    rootFiles = [...inline.keys()].filter((f) => /\.tsx?$/.test(f));
  } else {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      `${root}/tsconfig.json`,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (d) => {
          throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
        },
      },
    );
    options = { ...parsed.options, ...cfg.options };
    rootFiles = parsed.fileNames.map(posix).filter((f) => !f.includes('/node_modules/'));
    for (const f of rootFiles) readSnap(f); // eager: the tree is frozen at start
  }

  const overlay = new Map(); // abs → {content, v}
  const removed = new Set();
  let counter = 0;
  let projectVersion = 0;
  let cancelled = () => false;

  const exists = (abs) => {
    if (removed.has(abs)) return false;
    if (overlay.has(abs)) return true;
    if (inline !== undefined && abs.startsWith(`${root}/`)) return inline.has(abs);
    return readSnap(abs) !== undefined;
  };
  const lsHost = {
    getScriptFileNames: () =>
      [...new Set([...rootFiles, ...overlay.keys()])].filter((f) => !removed.has(f)),
    getScriptVersion: (f) => {
      const o = overlay.get(posix(f));
      return o !== undefined ? `o${o.v}` : '1';
    },
    getScriptSnapshot: (f) => {
      const abs = posix(f);
      if (removed.has(abs)) return undefined;
      const o = overlay.get(abs);
      const t = o !== undefined ? o.content : readSnap(abs);
      return t === undefined ? undefined : ts.ScriptSnapshot.fromString(t);
    },
    getCurrentDirectory: () => root,
    getCancellationToken: () => ({ isCancellationRequested: () => cancelled() }),
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: (f) => exists(posix(f)),
    readFile: (f) => {
      const abs = posix(f);
      if (removed.has(abs)) return undefined;
      const o = overlay.get(abs);
      return o !== undefined ? o.content : readSnap(abs);
    },
    readDirectory: ts.sys.readDirectory,
    directoryExists: (d) => {
      const dir = posix(d);
      if (
        inline !== undefined &&
        (dir === root || [...inline.keys()].some((k) => k.startsWith(`${dir}/`)))
      )
        return true;
      for (const k of overlay.keys()) if (k.startsWith(`${dir}/`)) return true;
      return ts.sys.directoryExists(d);
    },
    getDirectories: ts.sys.getDirectories,
    getProjectVersion: () => String(projectVersion),
    realpath: (f) => {
      if (inline !== undefined) return f;
      try {
        return ts.sys.realpath ? ts.sys.realpath(f) : f;
      } catch {
        return f;
      }
    },
  };
  const service = ts.createLanguageService(lsHost, ts.createDocumentRegistry());

  return {
    root,
    service,
    exists,
    options,
    rootFiles: () => lsHost.getScriptFileNames(),
    read: (abs) => lsHost.readFile(abs),
    setOverlay(entries, tomb = []) {
      counter++;
      overlay.clear();
      removed.clear();
      for (const e of entries) overlay.set(posix(e.abs), { content: e.content, v: counter });
      for (const r of tomb) removed.add(posix(r));
      projectVersion++;
    },
    clearOverlay() {
      counter++;
      overlay.clear();
      removed.clear();
      projectVersion++;
    },
    /** Install a cancellation predicate (polled by LS + builder via the program's token). */
    setCancel(fn) {
      cancelled = fn;
    },
  };
}

const builderHost = {
  useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  createHash: ts.sys.createHash,
};

/** Wrap THIS program instance's getBindAndCheckDiagnostics: every call = a file the checker really
 *  (re)checked on this program. The builder reads cached old diagnostics without calling it, so the
 *  counter is the ground truth for "did the builder skip work" — independent of its own drain list. */
function instrument(program) {
  const rechecked = [];
  const orig = program.getBindAndCheckDiagnostics.bind(program);
  program.getBindAndCheckDiagnostics = (sf, ct) => {
    rechecked.push(sf.fileName);
    return orig(sf, ct);
  };
  return rechecked;
}

const isLib = (program, sf) =>
  sf.isDeclarationFile &&
  (program.isSourceFileDefaultLibrary(sf) || sf.fileName.includes('/node_modules/'));

export function diagKey(d) {
  return [
    d.file ? posix(d.file.fileName) : '-',
    d.start ?? -1,
    d.length ?? -1,
    d.code,
    ts.flattenDiagnosticMessageText(d.messageText, '\n'),
  ].join('|');
}

const now = () => performance.now();
export const heapMB = () => {
  globalThis.gc?.();
  return Math.round(process.memoryUsage().heapUsed / 1048576);
};

/** One builder pass: B_k = builder(LS program at the current version, B_{k-1}); drain; then read
 *  syntactic + semantic diagnostics of every non-lib file (what the gate consumes). */
export function builderPass(host, prev, token) {
  const t0 = now();
  const program = host.service.getProgram();
  const tProgram = now() - t0;
  const rechecked = instrument(program);
  const t1 = now();
  const builder = ts.createSemanticDiagnosticsBuilderProgram(program, builderHost, prev);
  const tCreate = now() - t1;
  const t2 = now();
  const drained = [];
  for (;;) {
    const r = builder.getSemanticDiagnosticsOfNextAffectedFile(token);
    if (r === undefined) break;
    drained.push(r.affected.fileName ?? '(program)');
  }
  const tDrain = now() - t2;
  const t3 = now();
  const keys = [];
  for (const sf of program.getSourceFiles()) {
    if (isLib(program, sf)) continue;
    for (const d of program.getSyntacticDiagnostics(sf)) keys.push(diagKey(d));
    for (const d of builder.getSemanticDiagnostics(sf, token)) keys.push(diagKey(d));
  }
  const tRead = now() - t3;
  const files = program.getSourceFiles().filter((sf) => !isLib(program, sf)).length;
  return {
    builder,
    program,
    keys,
    files,
    drained: drained.filter((f) => !f.includes('/node_modules/')).length,
    rechecked: rechecked.filter((f) => !f.includes('/node_modules/')),
    ms: { program: tProgram, create: tCreate, drain: tDrain, read: tRead, total: now() - t0 },
  };
}

/** The current gate's work on the SAME source files with a FRESH checker: createProgram reusing
 *  every SourceFile of `program` (structure fully reused, no reparse) → a new TypeChecker →
 *  syntactic + semantic of every non-lib file. This is what each gate pass pays today (a version
 *  bump → a new Program + checker → full re-check), and its diagnostics are the oracle. */
export function fullPass(program, host) {
  const t0 = now();
  const opts = program.getCompilerOptions();
  const ch = ts.createCompilerHost(opts);
  const byName = new Map(program.getSourceFiles().map((sf) => [posix(sf.fileName), sf]));
  ch.getSourceFile = (f) => byName.get(posix(f));
  ch.fileExists = (f) => byName.has(posix(f)) || host.exists(posix(f));
  const fresh = ts.createProgram({
    rootNames: program.getRootFileNames(),
    options: opts,
    host: ch,
    oldProgram: program,
  });
  const tProgram = now() - t0;
  const keys = [];
  const t1 = now();
  for (const sf of fresh.getSourceFiles()) {
    if (isLib(fresh, sf)) continue;
    for (const d of fresh.getSyntacticDiagnostics(sf)) keys.push(diagKey(d));
    for (const d of fresh.getSemanticDiagnostics(sf)) keys.push(diagKey(d));
  }
  return { keys, ms: { program: tProgram, check: now() - t1, total: now() - t0 } };
}

/** LS-surface oracle (what src/plugins/ts/diagnostics.ts reads): service.get{Syntactic,Semantic}
 *  per root file. Differs from program.getSemanticDiagnostics by the declaration diagnostics the LS
 *  appends when declaration emit is on. */
export function lsKeys(host) {
  const keys = [];
  const program = host.service.getProgram();
  for (const f of host.rootFiles()) {
    if (program.getSourceFile(f) === undefined) continue;
    for (const d of host.service.getSyntacticDiagnostics(f)) keys.push(diagKey(d));
    for (const d of host.service.getSemanticDiagnostics(f)) keys.push(diagKey(d));
  }
  return keys;
}

/** Multiset difference both ways. */
export function compare(a, b) {
  const count = (xs) => {
    const m = new Map();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const ma = count(a);
  const mb = count(b);
  const onlyA = [];
  const onlyB = [];
  for (const [k, n] of ma) for (let i = 0; i < n - (mb.get(k) ?? 0); i++) onlyA.push(k);
  for (const [k, n] of mb) for (let i = 0; i < n - (ma.get(k) ?? 0); i++) onlyB.push(k);
  return { equal: onlyA.length === 0 && onlyB.length === 0, onlyA, onlyB };
}

/** Apply ts.FileTextChanges to current host content → overlay entries (new files from ''). */
export function applyEdits(host, edits) {
  return edits.map((fe) => {
    const abs = posix(fe.fileName);
    let text = fe.isNewFile ? '' : (host.read(abs) ?? '');
    const changes = [...fe.textChanges].sort((x, y) => y.span.start - x.span.start);
    for (const c of changes)
      text = text.slice(0, c.span.start) + c.newText + text.slice(c.span.start + c.span.length);
    return { abs, content: text };
  });
}

export const fmt = (n) => (n / 1000).toFixed(2);
