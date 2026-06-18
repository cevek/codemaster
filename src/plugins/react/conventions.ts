// React naming conventions — pure, dependency-free predicates. This is the policy the
// `react` plugin OWNS (§4/§5-L2): the `ts` plugin emits framework-neutral syntactic facts
// (a declaration's name + whether it returns JSX); the React-specific reading of those
// facts (PascalCase + returns-JSX = a component, `useX` = a hook) lives here, never in the
// `ts` plugin. Heuristic by nature — a match is `provenance: heuristic` (§3.3).

/** A component name by React convention: starts with an uppercase ASCII letter. Lowercase
 *  tags are host/DOM elements in JSX, never components — so a lowercase function returning
 *  JSX is NOT a component. */
export function isComponentName(name: string): boolean {
  const first = name.charCodeAt(0);
  return first >= 65 && first <= 90; // 'A'..'Z'
}

/** A hook name by the React convention: `use` followed by an uppercase letter (`useState`,
 *  `useTodos`). Bare `use` or `username` are NOT hooks — the char after `use` must be
 *  uppercase, so `usB` (too short) and `useful` (lowercase after `use`) are excluded. */
export function isHookName(name: string): boolean {
  if (!name.startsWith('use') || name.length < 4) return false;
  const after = name.charCodeAt(3);
  return after >= 65 && after <= 90; // 'A'..'Z'
}
