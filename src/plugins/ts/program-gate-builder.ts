// The write gate's ONE authority for "this file's diagnostics in this program state": a TS
// diagnostics builder (the `tsc --incremental` model) chained over the LS's Programs, per program.
// A pass re-checks only what TS proves may differ from its parent state — files whose version,
// `referencedMap` keys or compilerOptions changed, plus the reverse closure of any file whose d.ts
// signature changed — and copies every other file's diagnostics from the parent.
//
// Correctness does not depend on WHICH parent a pass chains from (TS accepts any old state, and the
// spike t-820012 verified branching): parent choice is cost only. That rests on one precondition —
// `getScriptVersion` never returns a version a path already held with a different body. Disk
// versions guarantee it by being one host-wide counter per path, advanced by every reindex that names
// the path and never reset (program/file-versions.ts) — including a path reached only through an
// import; overlay versions by the monotonic `Overlay` counter. A body that changes on disk without a
// reindex is stale for the LS itself (§3.5), not only here.
//
// Each pass: create → drain `getSemanticDiagnosticsOfNextAffectedFile` → read `checkAbs` →
// `releaseProgram` (a retained builder otherwise pins its Program + checker, ~0.7 GB on a 3.8k-file
// repo). Reading a released builder asserts inside TS, so a state is kept only as a parent and never
// handed out. A pass that throws (cancel, LS) advances nothing: its half-drained builder is dropped.
// Declaration emit on → the Emit-and-Semantic builder, whose `getDeclarationDiagnostics` matches the
// diagnostics the LS appends under `declaration`/`composite`; it never writes (`writeFile` throws).
// The builder also patches `getBuildInfo` on the LS's Program — inert for a Program we never emit.

import ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { SingleProgram } from './program/single.ts';
import { toTsDiagnostic, type TsDiagnostic } from './diagnostics.ts';

/** Options under which the incremental model is unsound or buys nothing — those programs take the
 *  full LS path. `assumeChangesOnlyAffectDirectDependencies` skips the transitive closure (a proven
 *  false clean, t-820012); `outFile` affects the whole program on any change; `noCheck` has no
 *  semantic pass to save; `module: None` builds no `referencedMap`, so every change is everything. */
export function builderEligible(options: ts.CompilerOptions): boolean {
  return (
    options.assumeChangesOnlyAffectDirectDependencies !== true &&
    options.outFile === undefined &&
    options.noCheck !== true &&
    options.module !== ts.ModuleKind.None &&
    internalsAvailable()
  );
}

/** Above this many files whose version differs from the parent, chaining costs more than a cold
 *  pass: every changed file pays a d.ts emit for its signature (t-820012: a hub edit of 893/3801
 *  files drained in 13–26 s, slower than the 22–28 s full pass a cold builder matches). */
function tooManyChanged(changed: number, files: number): boolean {
  return changed > Math.max(50, files * 0.1);
}

const AFTER_GATE_SLOTS = 4; // retained-state memory unmeasured on error-heavy repos: t-743990

/** A narrow check scope (a rename's touched files, `impact_type_error`'s closure) is cheaper on the
 *  LS: a builder pass pays a whole-program setup plus the changed files' d.ts work before it reads
 *  anything. Measured with `scripts/spike/builder-gate/live.ts`, a one-file scope: 1.1 s vs 0.4 s on
 *  a 3.8k-file repo, 1.7 s vs 0.2 s on a 456-file `declaration` repo. */
export function scopeWantsBuilder(checked: number, files: number): boolean {
  return checked * 2 >= files;
}

/** An edit by absolute path — the whole edit, unfiltered by program ownership (ownership moves once
 *  a dest exists on disk). */
export interface EditView {
  files: ReadonlyMap<string, string>;
  removed: ReadonlySet<string>;
}

export function editViewOf(
  files: readonly { abs: string; content: string }[],
  removed: readonly string[],
): EditView {
  return { files: new Map(files.map((f) => [f.abs, f.content])), removed: new Set(removed) };
}

/** Did the gate of `gated` verify bytes that are now on disk? Its overlay is the source files only,
 *  while an op also writes what no program typechecks (a co-extracted stylesheet), so the test is
 *  containment, not equality. An empty overlay vouches for nothing. */
function gatedBy(gated: EditView, written: EditView): boolean {
  if (gated.files.size === 0 && gated.removed.size === 0) return false;
  for (const [abs, content] of gated.files) if (written.files.get(abs) !== content) return false;
  for (const abs of gated.removed) if (!written.removed.has(abs)) return false;
  return true;
}

export interface GateBuilders {
  /** Did a kept gate of these bytes run on the builder for `program`? */
  follows(program: SingleProgram, written: EditView): boolean;
  /** Disk diagnostics of `checkAbs`; the program must carry no overlay. `written` names the bytes
   *  just written (post-apply): the overlay state that gated them is the cheapest parent. */
  disk(
    program: SingleProgram,
    relOf: (abs: string) => RepoRelPath,
    checkAbs: readonly string[],
    token: ts.CancellationToken,
    written?: EditView,
  ): TsDiagnostic[];
  /** Diagnostics under the overlay currently applied to `program`, chained from its disk state and
   *  kept with `edit` as a parent for the post-apply pass. */
  overlay(
    program: SingleProgram,
    relOf: (abs: string) => RepoRelPath,
    checkAbs: readonly string[],
    token: ts.CancellationToken,
    edit: EditView,
  ): TsDiagnostic[];
}

/** A parent is reused only by a builder of its own kind — the two kinds keep different state. */
type ChainState =
  | { kind: 'emit'; builder: ts.EmitAndSemanticDiagnosticsBuilderProgram; versions: VersionMap }
  | { kind: 'semantic'; builder: ts.SemanticDiagnosticsBuilderProgram; versions: VersionMap };
type VersionMap = ReadonlyMap<string, string>;

interface Chain {
  disk?: ChainState;
  afterGate: { edit: EditView; state: ChainState }[]; // oldest first
}

export function createGateBuilders(): GateBuilders {
  const chains = new WeakMap<SingleProgram, Chain>();
  const chainOf = (program: SingleProgram): Chain => {
    let chain = chains.get(program);
    if (chain === undefined) {
      chain = { afterGate: [] };
      chains.set(program, chain);
    }
    return chain;
  };
  const programOf = (program: SingleProgram): ts.Program => {
    const p = program.getProgram();
    if (p === undefined) throw new Error(`${program.label}: the language service built no program`);
    return p;
  };

  const gateOf = (program: SingleProgram, written: EditView): ChainState | undefined =>
    chains.get(program)?.afterGate.findLast((g) => gatedBy(g.edit, written))?.state;

  return {
    follows: (program, written) => gateOf(program, written) !== undefined,
    disk(program, relOf, checkAbs, token, written) {
      const chain = chainOf(program);
      const viaGate = written !== undefined ? gateOf(program, written) : undefined;
      const run = pass(programOf(program), viaGate ?? chain.disk, relOf, checkAbs, token);
      chain.disk = run.state;
      // Every kept gate was taken against the disk this write replaced.
      if (written !== undefined) chain.afterGate = [];
      return run.diags;
    },
    overlay(program, relOf, checkAbs, token, edit) {
      const chain = chainOf(program);
      const run = pass(programOf(program), chain.disk, relOf, checkAbs, token);
      chain.afterGate.push({ edit, state: run.state });
      if (chain.afterGate.length > AFTER_GATE_SLOTS) chain.afterGate.shift();
      return run.diags;
    },
  };
}

function pass(
  program: ts.Program,
  parent: ChainState | undefined,
  relOf: (abs: string) => RepoRelPath,
  checkAbs: readonly string[],
  token: ts.CancellationToken,
): { diags: TsDiagnostic[]; state: ChainState } {
  const versions = new Map<string, string>();
  for (const sf of program.getSourceFiles()) versions.set(sf.fileName, versionOf(sf));
  const options = program.getCompilerOptions();
  const declarations = options.declaration === true || options.composite === true;
  const usable =
    parent !== undefined &&
    parent.kind === (declarations ? 'emit' : 'semantic') &&
    !tooManyChanged(changedCount(parent.versions, versions), versions.size)
      ? parent
      : undefined;
  const state: ChainState = declarations
    ? {
        kind: 'emit',
        builder: ts.createEmitAndSemanticDiagnosticsBuilderProgram(
          program,
          BUILDER_HOST,
          usable?.kind === 'emit' ? usable.builder : undefined,
        ),
        versions,
      }
    : {
        kind: 'semantic',
        builder: ts.createSemanticDiagnosticsBuilderProgram(
          program,
          BUILDER_HOST,
          usable?.kind === 'semantic' ? usable.builder : undefined,
        ),
        versions,
      };
  const { builder } = state;
  while (builder.getSemanticDiagnosticsOfNextAffectedFile(token) !== undefined) {
    /* drain: computes the changed files' signatures and invalidates their closure */
  }
  const diags: TsDiagnostic[] = [];
  for (const abs of checkAbs) {
    const sf = program.getSourceFile(abs);
    if (sf === undefined) continue; // not in this program — see `fileDiagnostics`
    const semantic = ts.sortAndDeduplicateDiagnostics(builder.getSemanticDiagnostics(sf, token));
    const all = [
      ...program.getSyntacticDiagnostics(sf, token),
      ...semantic,
      ...(declarations ? builder.getDeclarationDiagnostics(sf, token) : []),
    ];
    for (const d of all) diags.push(toTsDiagnostic(d, abs, relOf));
  }
  release(builder);
  return { diags, state };
}

function changedCount(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): number {
  let n = 0;
  for (const [file, v] of after) if (before.get(file) !== v) n++;
  for (const file of before.keys()) if (!after.has(file)) n++;
  return n;
}

const BUILDER_HOST: ts.BuilderProgramHost = {
  ...(ts.sys.createHash !== undefined ? { createHash: ts.sys.createHash } : {}),
  writeFile: (fileName) => {
    throw new Error(`the typecheck gate's diagnostics builder attempted to write ${fileName}`);
  },
};

// `releaseProgram` and `SourceFile.version` are @internal (absent from the public d.ts) and are read
// through this one typed block. `releaseProgram` is probed once: without it the builder path is off
// (full LS path) rather than retaining every Program. A missing `version` only blinds the
// cold-restart threshold (cost) — the builder itself compares the same field.
interface InternalBuilder {
  releaseProgram?: () => void;
}
interface InternalSourceFile {
  version?: unknown;
}

function release(builder: ts.BuilderProgram): void {
  const fn = (builder as unknown as InternalBuilder).releaseProgram;
  if (typeof fn !== 'function') throw new Error('TS builder lost releaseProgram');
  fn.call(builder);
}

function versionOf(sf: ts.SourceFile): string {
  const v = (sf as unknown as InternalSourceFile).version;
  return typeof v === 'string' ? v : '';
}

let internals: boolean | undefined;

function internalsAvailable(): boolean {
  if (internals !== undefined) return internals;
  try {
    const host = ts.createCompilerHost({});
    const sf = ts.createSourceFile('/__probe.ts', 'export {};', ts.ScriptTarget.Latest);
    (sf as unknown as InternalSourceFile).version = '1'; // the builder asserts every file has one
    host.getSourceFile = (f) => (f === '/__probe.ts' ? sf : undefined);
    const program = ts.createProgram({
      rootNames: ['/__probe.ts'],
      options: { noLib: true },
      host,
    });
    const builder = ts.createSemanticDiagnosticsBuilderProgram(program, BUILDER_HOST);
    internals = typeof (builder as unknown as InternalBuilder).releaseProgram === 'function';
  } catch {
    internals = false;
  }
  return internals;
}
