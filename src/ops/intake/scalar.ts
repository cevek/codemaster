// Scalar predicate shared by the intake coercion steps (top-level `coerce-array` and nested
// `nested-array`) — a bare `string | number | boolean` is the coercible scalar a one-element
// array wraps (§7 Postel). One definition, so the two coercers can't drift.

export function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}
