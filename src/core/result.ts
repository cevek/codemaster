// Core result envelope.
//
// Everything an agent receives is *proof-carrying*: a fact it cannot independently
// verify is a fact it will not trust. These types encode the trust contract
// (ARCHITECTURE.md §3). `Loc`/`Span`/`Confidence` live in `./span`.

import type { Span, Confidence } from './span.js';
import type { IndexVersion, RepoRelPath } from './brands.js';
import type { HandleRebind } from './ids.js';

/** A value plus the spans that prove it and our confidence in it. */
export interface Fact<T> {
  value: T;
  proof: Span[];
  confidence: Confidence;
  /** Present when confidence !== 'certain': the reason. */
  note?: string;
}

/** Surfaced when the index is behind the working tree. Freshness is checked
 *  **repo-globally** on read (git HEAD + porcelain status, file-mtime fallback —
 *  ARCHITECTURE.md §3.5 / §8), so a file that *should* have been in the answer but
 *  wasn't (e.g. added by a watcher-missed `git checkout`) still trips this — never a
 *  silent undercount. */
export interface FreshnessNote {
  /** The index version this answer was computed at — lets a handle-holder tell whether
   *  its `SymbolId`s still bind. */
  indexVersion: IndexVersion;
  /** Files changed but not yet reindexed at answer time. */
  pending: number;
  /** The specific paths, when the set is small enough to be useful. */
  staleFiles?: RepoRelPath[];
  /** Git commit the index reflects, when on a clean tree. */
  indexedAtCommit?: string;
}

/** Truncation is always explicit — silent capping reads as "this is everything". */
export interface Truncation {
  shown: number;
  total: number;
  /** How to retrieve the rest (narrow the filter, or paginate). */
  hint: string;
}

/** Set when the operation could not be completed because an internal tool failed — the
 *  TS LS, git, ast-grep, prettier, the filesystem. We surface the failure verbatim and
 *  never guess a result in its place; `data` is empty (or partial, if `partial`). The
 *  agent falls back to its own means. */
export interface ToolFailure {
  /** Which internal tool failed, e.g. 'tsserver', 'git', 'ast-grep', 'fs', 'prettier'. */
  tool: string;
  /** The underlying error message — not swallowed. */
  message: string;
  /** True if some results were produced before the failure. */
  partial?: boolean;
}

/** The envelope wrapping every primitive's payload. */
export interface Result<T> {
  data: T;
  /** Set when an internal tool failed and the operation could not complete honestly —
   *  never a crash, never a guess (ARCHITECTURE.md §3). When present, `data` is empty. */
  failure?: ToolFailure;
  /** Present only when a passed `SymbolId` was rebound to its new home or lost —
   *  a proof-carrying rebind, never a silent one (ARCHITECTURE.md §6). */
  handle?: HandleRebind;
  freshness?: FreshnessNote;
  truncated?: Truncation;
  /** Opt-in per-call debug trace (off by default — see ARCHITECTURE.md §13).
   *  One compact, greppable line per event. */
  debug?: string[];
}

/** Agent-controlled output density (tokens are the scarce resource). */
export type Verbosity = 'terse' | 'normal' | 'full';
