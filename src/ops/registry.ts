// `OpDefinition` — how an op presents itself to the dispatcher: name, one-line
// summary, zod args schema (the schema + example ARE the documentation an agent sees
// through `status` — §7), required plugins, and the typed `run`. Each op lives in its
// own file and exports one definition via `defineOp`; the composition root hands the
// list to the engine. Phase 0 ships an empty catalogue (no plugins yet — §17).

import type { z } from 'zod';
import type { Result } from '../core/result.ts';
import type { JsonValue } from '../core/json.ts';
import type { PluginRegistry } from '../core/plugin.ts';
import type { OpFlags } from './contracts.ts';

/** What an op sees at run time. Ops compose plugins through the registry's public
 *  APIs only — never internals (§5-L3). */
export interface OpContext {
  plugins: PluginRegistry;
  flags: OpFlags;
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
  readonly example?: string;
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
