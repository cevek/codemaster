// Lift an OpFlag an agent placed INSIDE `args` up to the request level (§7 Postel) — the
// dogfood fail log had `extract_symbol {args:{apply:true, summaryOnly:true}}` rejected as
// unknown keys. A lifted value is type-checked here (the MCP boundary validated only the
// real top-level flags, not these); a wrong type fails honestly as a pointed error rather
// than being silently coerced. Never lifts a key the op's own schema defines (collision-safe).

import { OP_FLAG_KEYS } from '../contracts.ts';
import type { OpFlags } from '../contracts.ts';

type FlagKey = (typeof OP_FLAG_KEYS)[number];

const BOOLEAN_FLAGS: ReadonlySet<FlagKey> = new Set(['apply', 'summaryOnly', 'debug']);
const ENUM_FLAGS: Readonly<Record<string, readonly string[]>> = {
  verbosity: ['terse', 'normal', 'full'],
  format: ['text', 'json'],
};

export interface LiftResult {
  /** OpFlag values lifted out of `args`, to merge onto the request. */
  flags: Partial<OpFlags>;
  /** Note labels for the rewrites that fired (e.g. `apply→flag`). */
  notes: string[];
  /** Set when a lifted value had the wrong type — the op is rejected with this as a pointed
   *  `bad_args`, never a silent coercion. */
  error?: string;
}

/** Validate + coerce one lifted flag value. Returns the typed value, or an error string. */
function coerceFlag(key: FlagKey, value: unknown): { value: OpFlags[FlagKey] } | { error: string } {
  if (BOOLEAN_FLAGS.has(key)) {
    if (typeof value === 'boolean') return { value };
    return { error: `${key}: expected boolean (a flag), got ${JSON.stringify(value)}` };
  }
  const allowed = ENUM_FLAGS[key];
  if (allowed !== undefined) {
    if (typeof value === 'string' && allowed.includes(value))
      return { value: value as OpFlags[FlagKey] };
    return { error: `${key}: expected one of ${allowed.join('|')}, got ${JSON.stringify(value)}` };
  }
  return { error: `${key}: not a liftable flag` };
}

/** Pull every OpFlag key found in `args` (and not defined as a canonical arg of this op) into
 *  a flags object. Mutates `args` (a fresh clone owned by the caller) by deleting the lifted
 *  keys. Stops at the first type error so the agent fixes one thing. */
export function liftFlags(
  args: Record<string, unknown>,
  canonical: ReadonlySet<string>,
): LiftResult {
  const flags: Partial<OpFlags> = {};
  const notes: string[] = [];
  for (const key of OP_FLAG_KEYS) {
    if (!(key in args) || canonical.has(key)) continue;
    const coerced = coerceFlag(key, args[key]);
    if ('error' in coerced) return { flags, notes, error: coerced.error };
    delete args[key];
    Object.assign(flags, { [key]: coerced.value });
    notes.push(`${key}→flag`);
  }
  return { flags, notes };
}
