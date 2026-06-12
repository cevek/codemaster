// `SymbolId` codec — only the plugin-prefix routing is a shared contract
// (ARCHITECTURE.md §6). Everything after the first `:` is plugin-private payload; this
// codec never interprets it.

import type { SymbolId } from '../../core/ids.ts';

export interface DecodedSymbolId {
  /** The owning plugin's id — the dispatcher routes on this. */
  plugin: string;
  /** Opaque plugin-private payload (everything after the first `:`). */
  payload: string;
}

export function encodeSymbolId(plugin: string, payload: string): SymbolId {
  if (plugin.length === 0 || plugin.includes(':')) {
    throw new Error(`SymbolId plugin prefix must be a non-empty id without ':': got '${plugin}'`);
  }
  if (payload.length === 0) {
    throw new Error(`SymbolId payload must be non-empty (plugin '${plugin}')`);
  }
  return `${plugin}:${payload}` as SymbolId;
}

/** Decode the routing prefix. Returns `undefined` for a malformed id — the boundary
 *  turns that into a pointed `bad_args` error, never a crash. */
export function decodeSymbolId(id: string): DecodedSymbolId | undefined {
  const sep = id.indexOf(':');
  if (sep <= 0 || sep === id.length - 1) return undefined;
  return { plugin: id.slice(0, sep), payload: id.slice(sep + 1) };
}
