// `OpDefinition` — how an op presents itself to the dispatcher: name, one-line
// summary, zod args schema (the schema + example ARE the documentation an agent sees
// through `status` — §7), required plugins, and the typed `run`. Each op lives in its
// own file and exports one definition via `defineOp`; the composition root hands the
// list to the engine. Phase 0 ships an empty catalogue (no plugins yet — §17).

import type { z } from 'zod';
import type { Result } from '../core/result.ts';
import type { JsonValue } from '../core/json.ts';
import type { OpExample } from '../core/op-example.ts';
import type { PluginRegistry } from '../core/plugin.ts';
import type { TextScanner } from '../support/text-search/scan.ts';
import type { Deadline } from '../common/async/deadline.ts';
import type { Isolation, IsolationReason } from '../core/isolation.ts';
import type { OpFlags } from './contracts.ts';

/** What an op sees at run time. Ops compose plugins through the registry's public
 *  APIs only — never internals (§5-L3). */
/** Daemon-attached context, the same for every op in a call — assembled by the engine so
 *  an op never has to (and cannot honestly) gather it. The `feedback` op stamps its inbox
 *  entry from this; ordinary ops ignore it. `nowMs` comes from the injectable `Clock`
 *  (never `Date.now` — §16). */
export interface DaemonInfo {
  nowMs: number;
  version: string;
  /** Absolute workspace root — identifies the repo for a human triager (repoId is an
   *  internal hash, redundant here). */
  root: string;
  /** Codemaster's state base (`~/.codemaster` by default; a temp dir under test). */
  stateDir: string;
  plugins: readonly { id: string; version: string }[];
  /** The op catalogue at filing time — a "wish: op X should exist" is triaged against it. */
  opNames: readonly string[];
  /** How the engine is hosted (§2): `in-process` shares the daemon heap (an OOM is uncatchable),
   *  `process` is a killable child. The semantic-fanout guard (t-679091) refuses a heavy LS fan-out
   *  only when `in-process`; process-mode survives via the t-000052 kill/respawn mechanism. */
  isolation: Isolation;
  /** WHY that isolation (t-754922) — so a refusal names the ONE cause and its ONE remedy instead of
   *  enumerating every possibility we already ruled out (§3.6). A closed union: a consumer switches
   *  exhaustively, so a new cause is a compile error, never a silently-misread old one. `undefined`
   *  = not wired on this path (a synthetic context / a forked child) — a consumer must SAY it
   *  doesn't know, never substitute a plausible cause. */
  isolationReason?: IsolationReason;
}

export interface OpContext {
  plugins: PluginRegistry;
  flags: OpFlags;
  /** The op's OWN name (t-166631) — stamped by the dispatcher from the `OpDefinition` it is about
   *  to run, which is also the key it was looked up by, so there is no second value that could
   *  disagree. An op that has to name itself (a refusal saying which call declined, §9) reads it
   *  here instead of repeating a literal that must match its own `defineOp({name})` with nothing in
   *  the types tying the two together — a copy-paste carrying a neighbour's name used to compile
   *  and produce a confidently wrong message. REQUIRED, not optional: an optional field re-admits
   *  the same class through a `?? ''` fallback, which is a fabricated fact in the one place whose
   *  whole job is to be exact. */
  opName: string;
  /** Daemon-attached runtime context (§ feedback-channel). Present on every op call. */
  daemon?: DaemonInfo;
  /** The textual-occurrence scanner for `find_usages text:true` (§ text-overlay). A
   *  one-type seam (default pure-JS; ripgrep can drop in) — present on every op call. */
  textScanner?: TextScanner;
  /** The op's cooperative wall-clock budget (§1 never-hang), Clock-backed and constructed
   *  fresh per op by the engine. Always present — `NO_DEADLINE` when nothing is wired, so a
   *  loop-/LS-bounded op never has to guard `undefined`. An op that polls it (`impact`'s BFS,
   *  `find_unused_exports`' candidate loop, `find_usages`' LS cancellation) degrades to an
   *  honest `ToolFailure{tool:'timeout'}` / `partial` on overrun instead of spinning. Distinct
   *  from the process-mode kill-on-deadline backstop (§9), a hard SIGKILL for uncancellable work
   *  (a TS program build): this cooperative budget is set SHORTER than that kill, so the graceful
   *  partial always returns first. */
  deadline?: Deadline;
  /** Engine-level (NOT an agent-visible OpFlag — §5.2): set ONLY when this op is feeding
   *  an in-call SQLite table. A capped producer feeding a `NOT IN` makes the SQL answer a
   *  lie (§2.3), so a table-bearing op replaces its per-op `limit` with this bound — the
   *  SAME `MAX_TABLE_ROWS` the engine enforces over the projection, so the op caps exactly
   *  where the engine signals `partial` (no constant-vs-seam drift). Presence of this
   *  field IS the "sql-mode" signal; ops without a `table` ignore it. An op that hits this
   *  bound MUST report `truncated`, so the engine can mark the table incomplete. */
  tableRowBound?: number;
}

/** A SQL column's storage class. Mode-dependent fields are nullable rather than
 *  appearing/disappearing, so an agent can write SQL blind (§3). */
export type ColumnType = 'text' | 'int' | 'real';

/** One projected cell. `null` is an honest absent value (e.g. `encloser` on a flat row). */
export type Cell = string | number | null;

export interface TableColumn {
  readonly name: string;
  readonly type: ColumnType;
}

/** The tabular face of a list-shaped op (§3): a stable column set plus a pure projection
 *  of the op's `Data` into rows. Declaring `table` makes an op usable under `batch + sql`;
 *  ops whose output is not list-shaped simply omit it (using them under `sql` is a pointed
 *  `bad_args`). */
export interface TableSpec<D> {
  /** Stable, `snake_case`, args-independent. Surfaces in `status` automatically (§6). */
  readonly columns: ReadonlyArray<TableColumn>;
  /** Pure projection — one relation, no I/O, no plugin calls. `null` for absent values. */
  rows(data: D): ReadonlyArray<ReadonlyArray<Cell>>;
  /** Op-specific completeness caveats that are NOT rows — e.g. multi-symbol `unresolved`
   *  targets (absent symbols) and `excludedByFilter` counts. Surfaced in the SQL result's
   *  envelope so an unanswered question is never silently dropped (§3). */
  notes?(data: D): readonly string[];
}

/** Liberal-intake metadata (§7 Postel boundary) — how the dispatcher rewrites a known
 *  off-canonical arg spelling to this op's canonical shape BEFORE zod validation. PURELY
 *  INTERNAL: never projected into `status`/`argsHint` (the canonical shape is the only
 *  advertised truth), so an alias never leaks into the documentation. All fields optional;
 *  an op with no off-canonical inputs omits `intake` entirely. The rewrites that actually
 *  fire on a call are disclosed per-call via `Result.intake`. */
export interface OpIntake {
  /** Per-op input-key → canonical-key map (e.g. `{ symbol: 'name' }` for find_usages,
   *  `{ path: 'module', file: 'module' }` for importers_of). Applied only when the canonical
   *  key is not already present (an explicit canonical value never gets clobbered). */
  readonly aliases?: Readonly<Record<string, string>>;
  /** This op addresses a TS symbol via the shared `{symbolId|name|file+line+col}` shape:
   *  enable smart-string parsing of `name` — a `ts:…@…:L:C` SymbolId → `symbolId`, a
   *  `path:line:col` string → `file/line/col`. */
  readonly locationTarget?: boolean;
  /** This op addresses a module PATH (e.g. `importers_of`): a `query`/`name` key (a SYMBOL-name
   *  spelling) is the WRONG addressing mode — a symbol name never resolves to a path, so aliasing
   *  it to `module` would turn a loud `bad_args` into a silent "0 importers" (§3.6). Its presence
   *  hard-rejects with a pointed steer, never a silent coercion. Declared on the op (mirrors
   *  `locationTarget`) so the module-target discrimination lives beside the op's aliases, not in a
   *  central name-keyed table that could silently win over a later-added alias. */
  readonly moduleTarget?: boolean;
  /** This op carries an array of target objects under the named field (e.g. `source.targets`):
   *  each STRING element is parsed into a target object (SymbolId / file:line:col / name) and
   *  each OBJECT element gets the shared symbol/target alias rename + name smart-string. */
  readonly targetArray?: string;
}

export interface OpDefinition<A, D extends JsonValue> {
  readonly name: string;
  readonly summary: string;
  /** Mutating ops obey the §7 contract: dry-run unless `flags.apply === true`. */
  readonly mutating: boolean;
  /** Plugin ids this op needs. The engine drops the op from the catalogue when one is
   *  missing — an agent never sees an op it cannot call (§11). */
  readonly requires: readonly string[];
  readonly argsSchema: z.ZodType<A>;
  /** Compact args rendering for the `status` cheat-sheet, e.g.
   *  `{ symbolId: SymbolId, limit?: number }`. */
  readonly argsHint: string;
  /** A canonical example call, validated against `argsSchema` by the anti-drift test
   *  (§1.1). The formatter composes the display string; ops never hand-write it. */
  readonly example?: OpExample;
  /** Short per-op usage notes (1–3 clauses each), rendered indented under the op in the
   *  `status` catalogue. `status` IS the documentation (§11) — notes live ON the
   *  definition so they appear and vanish with the op, never drifting to one that isn't
   *  active. Clauses, not paragraphs: the deep dive is `argsHint` + `example`. */
  readonly notes?: readonly string[];
  /** Liberal-intake rewrites for this op (§7 Postel) — INTERNAL, never shown in `status`. */
  readonly intake?: OpIntake;
  /** The op's `at least one of` arg constraints, as key-sets — the shape a zod `.refine` enforces
   *  but `required` (a flat projection of zod-required) cannot express. Rendered into the
   *  advertised `inputSchema` as `anyOf:[{required:[…]},…]` (§11), so the harness rejects a
   *  target-less call BEFORE it costs a round-trip — for a mutating op the schema is the last cheap
   *  gate before an `apply:true` write (t-527994).
   *
   *  ADVERTISING A BRANCH ZOD WOULD REJECT IS WORSE THAN THE PERMISSIVENESS IT REPLACES, so the
   *  ts-target ops derive theirs from the very predicate they refine on (`TS_TARGET_ONE_OF`) and
   *  the remaining hand-written ones are pinned BOTH ways by the anti-drift test: every branch must
   *  PARSE, and an object satisfying `required` but no branch must FAIL.
   *
   *  SCOPE: the branches describe the CANONICAL spellings — the §7 intake additionally accepts
   *  aliases (`symbol`/`target`/`query` for a ts target), so a strict client that validates
   *  `anyOf` before we ever see the call rejects an alias-ONLY target this engine would have
   *  accepted. That is deliberate: an alias may never be advertised (§7), and the rejection names
   *  the canonical keys, which is the shape we want the caller on anyway. */
  readonly requiredOneOf?: ReadonlyArray<readonly string[]>;
  /** Present when the op is list-shaped and usable under `batch + sql` (§3). */
  readonly table?: TableSpec<D>;
  run(ctx: OpContext, args: A): Promise<Result<D>>;
}

/** The type-erased shape the dispatcher stores. `args` was validated by `argsSchema`
 *  before `run` — the cast inside `defineOp` is the single sanctioned erase point. */
export interface AnyOpDefinition extends Omit<OpDefinition<unknown, JsonValue>, 'run'> {
  run(ctx: OpContext, args: unknown): Promise<Result<JsonValue>>;
}

export function defineOp<A, D extends JsonValue>(definition: OpDefinition<A, D>): AnyOpDefinition {
  return definition as AnyOpDefinition;
}
