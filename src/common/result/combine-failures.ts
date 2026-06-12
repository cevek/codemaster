// Fold several `ToolFailure`s into one envelope-level failure without losing any of
// them — each underlying message survives verbatim (§3.6: surface the failure, never
// swallow it).

import type { ToolFailure } from '../../core/result.ts';

export function combineFailures(failures: readonly ToolFailure[]): ToolFailure | undefined {
  if (failures.length === 0) return undefined;
  const first = failures[0];
  if (failures.length === 1 && first !== undefined) return first;

  const tools = [...new Set(failures.map((f) => f.tool))];
  return {
    tool: tools.join('+'),
    message: failures.map((f) => `[${f.tool}] ${f.message}`).join('; '),
    ...(failures.some((f) => f.partial === true) ? { partial: true } : {}),
  };
}
