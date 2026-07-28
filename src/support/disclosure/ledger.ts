// The request-scoped disclosure ledger (§3.4/§3.6): the channel by which a fact established deep
// in a resolution — "this answer cannot claim X" — reaches the `Result` envelope of whatever op is
// answering, WITHOUT that op knowing the fact exists.
//
// Why ambient rather than a return value: the fact is produced at target-resolution time and is
// relevant to EVERY op that answers about that target. Threading it out through each plugin method
// and into each op costs an edit per consumer and leaves any op that forgets silently mute. Here
// the producer states the fact once and the dispatcher stamps it; a new op inherits it by existing.
//
// Why `AsyncLocalStorage` rather than a module-global: in `in-process` mode one process hosts
// SEVERAL workspace engines, whose ops interleave across `await`s. A shared global would attach one
// repo's disclosure to another repo's answer — a FALSE claim of doubt, which is the same lie
// inverted (§3.6) and exactly what a disclosure mechanism must never manufacture.
//
// It lives in `support/`, beside the other two ambient runtime mechanisms (`debug`'s `req#N` ALS and
// `watchdog/beacon`'s process-global): `common/` is pure logic over `core/` types, and per-request
// mutable state is not that, whatever it does or does not touch.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Disclosure, Result } from '../../core/result.ts';

/** Keyed `unsafe|target` so one resolution repeated across an op's internal calls (impact's BFS
 *  re-resolving its seed, source's per-target loop) states its claim once. */
type Ledger = Map<string, Disclosure>;

const storage = new AsyncLocalStorage<Ledger>();

/** State a claim the answer in flight cannot support. A no-op outside a scope (a plugin method
 *  called directly from a test / another plugin) — the ledger reports what an OP is answering, and
 *  silently inventing a scope for a caller that has no envelope would have nowhere to put it. */
export function disclose(entry: Disclosure): void {
  storage.getStore()?.set(`${entry.unsafe}|${entry.target}`, entry);
}

/** Run one op inside a fresh ledger and stamp whatever it disclosed onto the envelope it returns —
 *  BOTH arms: a failure built on a doubtful resolution is as much in need of the claim as a
 *  success (a `0`-shaped miss reads as absence either way).
 *
 *  Re-entrant by design: a nested call JOINS the enclosing ledger instead of opening its own, so an
 *  inner disclosure still reaches the outer envelope rather than being stamped on an intermediate
 *  result nobody sees. Nothing is drained — reading is non-destructive, so joining can never steal
 *  a claim from the outer answer.
 *
 *  An op that discloses nothing gets a byte-identical envelope (no empty array), so the common case
 *  is invisible in output and in goldens. */
export async function runWithDisclosures<T>(body: () => Promise<Result<T>>): Promise<Result<T>> {
  const outer = storage.getStore();
  if (outer !== undefined) return stamp(await body(), outer);
  const ledger: Ledger = new Map();
  return storage.run(ledger, async () => stamp(await body(), ledger));
}

function stamp<T>(result: Result<T>, ledger: Ledger): Result<T> {
  if (ledger.size === 0) return result;
  // Merge, never overwrite: an op that composed its own disclosures keeps them.
  const existing = result.disclosures ?? [];
  const merged: Disclosure[] = [...existing];
  for (const entry of ledger.values()) {
    if (!merged.some((d) => d.unsafe === entry.unsafe && d.target === entry.target)) {
      merged.push(entry);
    }
  }
  return { ...result, disclosures: merged };
}
