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
import type { OpFlags } from './contracts.ts';

/** What an op sees at run time. Ops compose plugins through the registry's public
 *  APIs only — never internals (§5-L3). */
export interface OpContext {
  plugins: PluginRegistry;
  flags: OpFlags;
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
   *  `{ target: SymbolId, limit?: number }`. */
  readonly argsHint: string;
  /** A canonical example call, validated against `argsSchema` by the anti-drift test
   *  (§1.1). The formatter composes the display string; ops never hand-write it. */
  readonly example?: OpExample;
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
