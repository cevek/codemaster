// Core result envelope.
//
// Everything an agent receives is *proof-carrying*: a fact it cannot independently
// verify is a fact it will not trust. These types encode the trust contract
// (ARCHITECTURE.md §3). `Loc`/`Span`/`Confidence` live in `./span`.

import type { Span, Confidence } from './span.js';
import type { RepoRelPath } from './brands.js';
import type { HandleRebind } from './ids.js';

/** A value plus the spans that prove it and our confidence in it. */
export interface Fact<T> {
  value: T;
  proof: Span[];
  confidence: Confidence;
  /** Present when confidence !== 'certain': the reason. */
  note?: string;
}

/** Surfaced when a plugin's data is behind the working tree at op time. Freshness is
 *  checked **repo-globally** on read (git HEAD + porcelain status, file-mtime fallback —
 *  ARCHITECTURE.md §3.5 / §8), so a file that *should* have been in the answer but
 *  wasn't (e.g. added by a watcher-missed `git checkout`) still trips this — never a
 *  silent undercount.
 *
 *  Each plugin computes its own freshness; an op that touches multiple plugins
 *  aggregates them here (worst-of). `plugins` lists which plugins contributed pending
 *  state, with their per-plugin opaque fingerprint — useful for a handle-holder to tell
 *  whether its `SymbolId`s still bind. */
export interface FreshnessNote {
  /** Per-plugin fingerprints at the moment the op started. The fingerprint shape is
   *  plugin-private (a number, a hash, etc.); consumers compare by equality only. */
  plugins: ReadonlyArray<{ id: string; fingerprint: string }>;
  /** Files changed but not yet reindexed at answer time, across all touched plugins. */
  pending: number;
  /** The specific paths, when the set is small enough to be useful. */
  staleFiles?: RepoRelPath[];
  /** Git commit the workspace reflects, when on a clean tree. */
  indexedAtCommit?: string;
}

/** Truncation is always explicit — silent capping reads as "this is everything". */
export interface Truncation {
  shown: number;
  total: number;
  /** How to retrieve the rest (narrow the filter, or paginate). */
  hint: string;
}

/** Set when the op could not be completed because an internal tool failed — the
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

/** Common envelope fields that apply to both success and failure paths. */
interface ResultCommon {
  /** Present only when a passed `SymbolId` was rebound to its new home or lost —
   *  a proof-carrying rebind, never a silent one (ARCHITECTURE.md §6). */
  handle?: HandleRebind;
  /** Per-plugin freshness at op time. */
  freshness?: FreshnessNote;
  /** Opt-in per-call debug trace (off by default — see ARCHITECTURE.md §13). One
   *  compact, greppable line per event. Surfaced only when `OpFlags.debug` was set on
   *  the request. */
  debug?: string[];
}

/** Success envelope: `data` present, no `failure`. */
export interface OkResult<T> extends ResultCommon {
  ok: true;
  data: T;
  truncated?: Truncation;
}

/** Failure envelope: `failure` present, `data` carried only for partial recovery (a
 *  list-shaped op that produced N entries before an internal tool failed). Plain
 *  failures have no `data`. ARCHITECTURE.md §3 (trust contract): never a crash, never
 *  a guess; the agent falls back to its own means. */
export interface FailureResult<T> extends ResultCommon {
  ok: false;
  /** Present only for partial recovery (paired with `ToolFailure.partial = true`). */
  data?: T;
  failure: ToolFailure;
}

/** The envelope wrapping every op's payload. Discriminated on `ok` so consumers must
 *  narrow before reading `data` — compile-time enforcement of the trust contract. */
export type Result<T> = OkResult<T> | FailureResult<T>;

/** Agent-controlled output density (tokens are the scarce resource). */
export type Verbosity = 'terse' | 'normal' | 'full';
