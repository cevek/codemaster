// Pointed dispatch-error messages for the engine's `runOne` (§7: an agent should author
// blind, so a typo gets a "did you mean" instead of a bare miss). Split from engine.ts to
// keep that file focused on the request lifecycle.

import type { AnyOpDefinition } from '../ops/registry.ts';
import { canonicalKeys } from '../ops/intake/shape-keys.ts';

export function unknownOpMessage(name: string, ops: Map<string, AnyOpDefinition>): string {
  const known = [...ops.keys()];
  if (known.length === 0) {
    return `unknown op '${name}' — this workspace has no ops yet (no plugins active; see status)`;
  }
  const guess = closestName(name, known);
  return `unknown op '${name}'${guess !== undefined ? ` — did you mean '${guess}'?` : ''} (known: ${known.join(', ')})`;
}

/** The `unavailable` message: an op the workspace knows but whose required plugin(s) aren't
 *  active here (§11). Named the missing plugins so the agent knows what to enable. */
export function unavailableMessage(name: string, missing: readonly string[]): string {
  return `op '${name}' needs plugin(s) [${missing.join(', ')}] which are not active in this workspace`;
}

/** A structural subset of a zod issue — enough to format it and to spot an unrecognized key. */
interface ArgIssue {
  readonly code?: string;
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
  readonly keys?: readonly string[];
}

/** Build the `bad_args` message after the canonical (post-intake) zod gate rejected `args`
 *  (§7). An unrecognized key gets a did-you-mean against the op's canonical fields — the
 *  intake layer already mapped every known alias, so a leftover unknown key is a genuine
 *  typo/wrong-field, not a spelling we accept. The clean canonical `argsHint` (no alias
 *  annotations) closes the message — the only advertised shape. */
export function badArgsMessage(op: AnyOpDefinition, issues: readonly ArgIssue[]): string {
  const canonical = [...canonicalKeys(op.argsSchema)];
  const parts = issues.map((issue) => {
    const where = issue.path.map((p) => String(p)).join('.') || '<args>';
    if (issue.code === 'unrecognized_keys' && issue.keys !== undefined) {
      const suggestions = issue.keys.map((key) => {
        const guess = closestName(key, canonical);
        return `'${key}'${guess !== undefined ? ` — did you mean '${guess}'?` : ''}`;
      });
      return `unrecognized ${suggestions.join(', ')}`;
    }
    return `${where}: ${issue.message}`;
  });
  return `${parts.join('; ')} — expected ${op.argsHint}`;
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
