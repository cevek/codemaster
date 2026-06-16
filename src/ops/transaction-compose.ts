// Compose an ORDERED sequence of per-step `RefactorPlan`s — each already planned against the
// cumulative prior state via a `PlanningOverlay` — into ONE `RefactorPlan` the shared
// `applyRefactorPlan` gates + commits/rolls back atomically (spec-transactional-mutation).
//
// Identity is keyed on a file's ORIGIN path (its pre-transaction location), so a file edited in
// one step and moved in another collapses to a single move+write, and `diff[].before` is always
// the ORIGINAL on-disk bytes — the byte-exact rollback baseline `applyRefactorPlan` derives from
// `diff[].before`/`newFiles`, never an intermediate overlay's content (spec §rollback).

import type { RepoRelPath } from '../core/brands.ts';
import { readTextFile } from '../support/fs/read-file.ts';
import type { Capture, RefactorPlan, PlanningOverlay } from '../plugins/ts/plugin.ts';
import { absOf } from './mutation-support.ts';

const TS_RE = /\.(tsx?|mts|cts)$/;

/** Cumulative state of one tracked (or step-created) file across the transaction. */
interface FileState {
  /** Pre-transaction path — the stable identity key (a file that later moves keeps this). */
  origin: RepoRelPath;
  /** Path after the steps applied so far. */
  current: RepoRelPath;
  /** Post-edit content (always present once the file has appeared in a step's diff). */
  after: string;
  /** Content actually changed (vs a pure relocation) → needs a `contentWrite`, must be reformatted. */
  edited: boolean;
  /** Created by a step (an extract target) → written fresh, never git-mv'd / tombstoned. */
  isNew: boolean;
  kind: 'file' | 'dir';
}

export class TxnCompose {
  private readonly byOrigin = new Map<string, FileState>();
  /** current-path → origin, so a step's `from` (a PRIOR current path) maps back to identity. */
  private readonly currentToOrigin = new Map<string, string>();
  private readonly diskCache = new Map<string, string>();
  readonly captures: Capture[] = [];
  readonly notes: string[] = [];
  /** Any step's edits came from the §4 patched-LS rescue — provenance that must ride the composed
   *  plan (§3.3), or the rescue note would be silently dropped inside a transaction. */
  private rescued = false;
  private readonly root: string;
  private readonly gitListing: readonly RepoRelPath[];

  constructor(root: string, gitListing: readonly RepoRelPath[]) {
    this.root = root;
    this.gitListing = gitListing;
  }

  /** Fold one step's normalized plan (computed against `this.overlay()`) into the cumulative state.
   *  Returns a message (never throws) when the step is not representable — e.g. it CREATES a file at
   *  a path a prior step VACATED by a move (both want the same origin key); the op then refuses with
   *  the step index rather than silently DROP the earlier move (a §3 completeness lie). */
  applyStep(plan: RefactorPlan, stepLabel: string): string | undefined {
    const newSet = new Set(plan.newFiles.map((f) => String(f.path)));
    for (const d of plan.diff) {
      const from = String(d.from);
      const to = String(d.to);
      if (from === to && newSet.has(to)) {
        const clash = this.byOrigin.get(to);
        if (clash !== undefined && this.tombstoned(clash)) {
          return `creates a file at ${to}, a path a prior step vacated by a move (to ${clash.current}) — not representable in one transaction; reorder the steps or choose a different destination`;
        }
        // A freshly created file (an extract target): identity is its own path.
        this.byOrigin.set(to, {
          origin: d.to,
          current: d.to,
          after: d.after,
          edited: false,
          isNew: true,
          kind: 'file',
        });
        this.currentToOrigin.set(to, to);
        continue;
      }
      const origin = this.currentToOrigin.get(from) ?? from;
      const prev = this.byOrigin.get(origin);
      const moved = from !== to;
      const state: FileState = {
        origin: prev?.origin ?? d.from,
        current: d.to,
        after: d.after,
        edited: (prev?.edited ?? false) || d.after !== d.before,
        isNew: prev?.isNew ?? false,
        kind: prev?.kind ?? 'file',
      };
      this.byOrigin.set(String(state.origin), state);
      if (moved) {
        this.currentToOrigin.delete(from);
        this.currentToOrigin.set(to, String(state.origin));
      } else if (!this.currentToOrigin.has(to)) {
        this.currentToOrigin.set(to, String(state.origin));
      }
    }
    this.captures.push(...plan.captures);
    if (plan.notes !== undefined) this.notes.push(...plan.notes);
    if (plan.rescued === true) this.rescued = true;
    // §6 honesty: a step whose target was a stale SymbolId re-located by name carries a rebind.
    // The envelope `handle` is singular and a chain may rebind at several steps, so disclose each
    // as a note (never a silent retarget of a destructive edit).
    if (plan.rebind !== undefined) {
      this.notes.push(
        plan.rebind.status === 'rebound'
          ? `${stepLabel}: target was a stale SymbolId — rebound by name (confidence ${plan.rebind.confidence})`
          : `${stepLabel}: target SymbolId is gone (${plan.rebind.reason})`,
      );
    }
    return undefined;
  }

  /** The overlay the NEXT step plans against: post-edit content at every touched CURRENT path,
   *  origin tombstones for moved-away sources, and the listing with prior moves/new files applied. */
  overlay(): PlanningOverlay {
    const states = [...this.byOrigin.values()];
    return {
      files: states.map((s) => ({ path: s.current, content: s.after })),
      removed: states.filter((s) => this.tombstoned(s)).map((s) => s.origin),
      listing: this.listing(),
    };
  }

  /** Collapse the whole sequence into one plan, or a message when a pre-edit file can't be read
   *  (we will not guess the rollback baseline — §3.6). `programTsFiles` widens the single §2.8 gate
   *  to the whole program (a chain mixing moves/edits can break an un-touched importer). */
  build(
    programTsFiles: readonly RepoRelPath[],
    extraNotes: readonly string[],
  ): RefactorPlan | string {
    const states = [...this.byOrigin.values()];
    const moves: RefactorPlan['moves'] = [];
    const newFiles: RefactorPlan['newFiles'] = [];
    const contentWrites: RefactorPlan['contentWrites'] = [];
    const overlayFiles: RefactorPlan['overlayFiles'] = [];
    const removed: RepoRelPath[] = [];
    const diff: RefactorPlan['diff'] = [];
    for (const s of states) {
      if (s.isNew) {
        newFiles.push({ path: s.current, content: s.after });
        diff.push({ from: s.current, to: s.current, before: '', after: s.after });
      } else {
        const before = this.originalDisk(s.origin);
        if (before === undefined) return `cannot read ${s.origin} to compose the cumulative diff`;
        const moved = this.tombstoned(s);
        if (moved) {
          moves.push({ from: s.origin, to: s.current, kind: s.kind });
          removed.push(s.origin);
        }
        if (s.edited) contentWrites.push({ path: s.current, content: s.after });
        if (moved || s.edited) diff.push({ from: s.origin, to: s.current, before, after: s.after });
      }
      if (TS_RE.test(String(s.current))) overlayFiles.push({ path: s.current, content: s.after });
    }
    const checkSet = new Set<string>();
    // Include EVERY primary TS file — moved-away ORIGINS too. The pre-edit baseline must sample an
    // origin where a PRE-EXISTING error lives, so the §1b path-remap (origin→current) can cancel it
    // against the overlay's relocated copy; dropping origins counts that error as introduced and
    // falsely rolls back a sound multi-move chain. The overlay pass tombstones the origin (gate
    // `removed`), and post-apply it is gone from disk — so it is sampled ONLY where it should be (the
    // baseline), symmetric. (The single-move path already adds origins via the program file set.)
    for (const p of programTsFiles) checkSet.add(String(p));
    for (const s of states) if (TS_RE.test(String(s.current))) checkSet.add(String(s.current));
    // Whole git tree (post-move current paths), so a SIBLING-only file (a `test/**` importer/
    // reference under tsconfig.test.json) is in the gate scope. `programTsFiles` is the PRIMARY
    // program only — a transaction rename step plans primary-only sites (cross-program fan-out is
    // off under a planning overlay, ls-host TRAP), so without this a cross-program dangle it leaves
    // would be sampled by NO program and read clean. With it, the fanned gate catches the dangle
    // and refuses the whole transaction (honest, never a silent partial — backlog residual).
    for (const p of this.listing()) if (TS_RE.test(String(p))) checkSet.add(String(p));
    const allNotes = [...this.notes, ...extraNotes];
    return {
      moves,
      newFiles,
      contentWrites,
      removed,
      overlayFiles,
      checkPaths: [...checkSet] as RepoRelPath[],
      diff,
      captures: this.captures,
      ...(allNotes.length > 0 ? { notes: allNotes } : {}),
      ...(this.rescued ? { rescued: true } : {}),
    };
  }

  /** True when no file is created, moved, or content-edited across all steps (a no-op chain — e.g.
   *  a rename to the same name). A file can sit in `byOrigin` from a touched-but-unchanged step
   *  (`after === before`), so a non-empty map is NOT proof of a real change. */
  isEmpty(): boolean {
    for (const s of this.byOrigin.values()) {
      if (s.isNew || s.edited || this.tombstoned(s)) return false;
    }
    return true;
  }

  /** A non-new file that moved away from its origin → its origin disk path is tombstoned. */
  private tombstoned(s: FileState): boolean {
    return !s.isNew && String(s.current) !== String(s.origin);
  }

  private listing(): RepoRelPath[] {
    const out: string[] = [];
    for (const p of this.gitListing) {
      const s = this.byOrigin.get(String(p));
      out.push(s !== undefined && !s.isNew ? String(s.current) : String(p));
    }
    for (const s of this.byOrigin.values()) if (s.isNew) out.push(String(s.current));
    return [...new Set(out)] as RepoRelPath[];
  }

  private originalDisk(origin: RepoRelPath): string | undefined {
    const key = String(origin);
    const cached = this.diskCache.get(key);
    if (cached !== undefined) return cached;
    const r = readTextFile(absOf(this.root, origin));
    if (!r.ok) return undefined;
    this.diskCache.set(key, r.data);
    return r.data;
  }
}
