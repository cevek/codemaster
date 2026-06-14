// trap T1 (generics): free generic functions + a constrained generic, for expand_type /
// search_symbol / find_definition over type params. Stub bodies.
export function identity<T>(value: T): T {
  return value;
}

export function firstOf<T>(items: readonly T[]): T | undefined {
  return items[0];
}

export function pluck<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key];
}
