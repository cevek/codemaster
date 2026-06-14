// trap T10 (string-literal-union-as-enum): the modern erasable-syntax reality — a
// discriminated union used as a de-facto enum, narrowed across many sites and shadowed by
// parallel `Record<Status, V>` lookup tables (+ a `satisfies`) that MUST stay in sync when
// the union changes. Serves: find_usages / expand_type / change_signature on a union arm.
// (A real `enum` lives in ./kinds.ts so both paths stay covered.)

/** The de-facto enum — four arms, narrowed below across ≥4 sites. */
export type Status = 'idle' | 'loading' | 'ready' | 'error';

/** Parallel table #1 — display labels keyed by every Status arm. */
export const STATUS_LABEL: Record<Status, string> = {
  idle: 'Idle',
  loading: 'Loading…',
  ready: 'Ready',
  error: 'Error',
};

/** Parallel table #2 — `satisfies` so a new arm is a compile error here too. */
export const STATUS_RANK = {
  idle: 0,
  loading: 1,
  ready: 2,
  error: 3,
} satisfies Record<Status, number>;

/** Narrowing site #1 — type guard. */
export function isTerminal(s: Status): boolean {
  return s === 'ready' || s === 'error';
}

/** Narrowing site #2 — switch over every arm. */
export function describe(s: Status): string {
  switch (s) {
    case 'idle':
      return 'waiting';
    case 'loading':
      return 'in flight';
    case 'ready':
      return 'done';
    case 'error':
      return 'failed';
  }
}

/** Narrowing site #3 — indexed lookup `labels[status]`. */
export function labelOf(s: Status): string {
  return STATUS_LABEL[s];
}

/** Narrowing site #4 — equality narrow guarding a transition. */
export function next(s: Status): Status {
  if (s === 'idle') return 'loading';
  if (s === 'loading') return 'ready';
  return s;
}
