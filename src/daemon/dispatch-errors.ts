// Pointed dispatch-error messages for the engine's `runOne` (§7: an agent should author
// blind, so a typo gets a "did you mean" instead of a bare miss). Split from engine.ts to
// keep that file focused on the request lifecycle.

import type { AnyOpDefinition } from '../ops/registry.ts';

export function unknownOpMessage(name: string, ops: Map<string, AnyOpDefinition>): string {
  const known = [...ops.keys()];
  if (known.length === 0) {
    return `unknown op '${name}' — this workspace has no ops yet (no plugins active; see status)`;
  }
  const guess = closestName(name, known);
  return `unknown op '${name}'${guess !== undefined ? ` — did you mean '${guess}'?` : ''} (known: ${known.join(', ')})`;
}

/** Cheap edit-distance-free guess: shared-prefix length, good enough for typos. */
function closestName(name: string, candidates: readonly string[]): string | undefined {
  let best: { name: string; score: number } | undefined;
  for (const candidate of candidates) {
    let score = 0;
    const cap = Math.min(name.length, candidate.length);
    while (score < cap && name[score] === candidate[score]) score++;
    if (score > 2 && (best === undefined || score > best.score)) {
      best = { name: candidate, score };
    }
  }
  return best?.name;
}
