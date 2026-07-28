// Core result envelope.
//
// Everything an agent receives is *proof-carrying*: a fact it cannot independently
// verify is a fact it will not trust. These types encode the trust contract
// (ARCHITECTURE.md §3). `Loc`/`Span`/`Confidence` live in `./span`.

import type { Span, Confidence } from './span.ts';
import type { RepoRelPath } from './brands.ts';
import type { HandleRebind } from './ids.ts';

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
  /** Files reindexed at op entry for this call (drift the read-time backstop caught and
   *  resolved before answering). Reported even when the answer is otherwise fully fresh,
   *  so a drift-triggered reindex is never silent — an agent that just edited can see its
   *  edit was picked up rather than having to trust it (§1.3, §3.5). */
  reindexed?: number;
  /** The specific paths, when the set is small enough to be useful. */
  staleFiles?: RepoRelPath[];
  /** Git commit the workspace reflects, when on a clean tree **and** freshness was
   *  verified. Suppressed when `unverified` is set — stamping a commit whose changes we
   *  could not confirm were applied would be a silent-stale lie (§3.5, §3.6). */
  indexedAtCommit?: string;
  /** Set when the read-time backstop could NOT establish what changed — e.g. the drift
   *  `git diff` itself failed. The op still answers from current plugin state, but the
   *  answer may be stale and we say so outright rather than imply freshness (§3.6: report
   *  what we couldn't do). The agent should fall back / re-run. */
  unverified?: { tool: string; message: string };
}

/** Truncation is always explicit — silent capping reads as "this is everything". */
export interface Truncation {
  shown: number;
  total: number;
  /** `total` itself is a FLOOR, not a count: the producer's own source (the TS LS's navto page)
   *  truncated before it could be counted, so more may exist beyond it. Rendered as `≥total`, so a
   *  capped count is never read as an exact one (§3.4). */
  totalIsLowerBound?: boolean;
  /** How to retrieve the rest (narrow the filter, or paginate). */
  hint: string;
}

/** A claim the answer must NOT be read as making, established at the moment the TARGET was
 *  RESOLVED rather than where the answer was assembled — so every op that answers about that
 *  target carries the same one and disclosure is never a per-op obligation (§3.4/§3.6).
 *
 *  The vocabulary names WHAT IS UNSAFE TO CLAIM, never the upstream EVENT that made it unsafe.
 *  That distinction is load-bearing: a flag SET on an event ("the search page overflowed") and
 *  READ as an assertion ("same-named declarations may be missing") are different statements, and
 *  the gap between them is where false refusals and false incompleteness live. The cause belongs
 *  in `note` (prose, for the agent), never in the type (the machine-readable claim). */
export interface Disclosure {
  /** The assertion this answer cannot support. */
  unsafe: UnsafeClaim;
  /** HOW the target was addressed (e.g. `name 'Span'`), so the claim is attributed to the
   *  resolution that is actually at risk — an op that internally resolves some OTHER name must
   *  never project its doubt onto the exactly-addressed target the agent passed. */
  target: string;
  /** The cause + the remedy, in words: why the claim is unsafe and how to address the target so
   *  it becomes safe. */
  note: string;
}

/** The closed set of assertions a resolution can invalidate. Closed so a consumer switches
 *  exhaustively and a new claim is a compile error, never a silently-misread old one. */
export type UnsafeClaim =
  /** "the symbol this answer is about is the only one of that name." The name→declaration
   *  candidate set was cut before we saw all of it, so the resolved symbol is one of the ones we
   *  COULD see: the target itself may be a mis-pick, and any count / emptiness / completeness the
   *  answer states about it is a floor rather than a fact. */
  'target-is-the-only-symbol-of-this-name';

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
  /** Liberal-intake disclosure (§7 Postel boundary): when the dispatcher rewrote a known
   *  input spelling to the canonical arg shape BEFORE validation, the rewrites that
   *  actually fired on THIS call are listed here (e.g. `['symbol→name']`) — a tiny per-call
   *  note, never the alias table. The canonical shape stays the only advertised truth
   *  (`status`/`argsHint`); this just states what we reinterpreted so the agent is never
   *  silently second-guessed. Absent when nothing was rewritten. */
  intake?: readonly string[];
  /** Resolve-time disclosures (§3.4/§3.6): claims this answer does NOT support, recorded where
   *  the target was resolved and stamped onto the envelope by the dispatcher. On the ENVELOPE and
   *  not in `data` because the fact is a property of the RESOLUTION, not of any one op's payload —
   *  so an op answering about a doubtful target inherits the disclosure without opting in, and two
   *  ops cannot report contradictory confidence about one target. Absent when the resolution
   *  supports everything the answer says. */
  disclosures?: readonly Disclosure[];
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
