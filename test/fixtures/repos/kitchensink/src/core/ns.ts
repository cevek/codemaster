// trap M5 target (value namespace): consumed as `import * as NS` with member calls
// `NS.alpha()` in forms/Form.tsx — find_usages must see the call through the namespace.
export function alpha(): string {
  return 'a';
}
export function beta(n: number): number {
  return n + 1;
}
