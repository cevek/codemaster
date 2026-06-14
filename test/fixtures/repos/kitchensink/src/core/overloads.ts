// trap T6 (overloads + merged declaration): an overloaded function (≥2 signatures) and a
// function/namespace merge (the function `box` merged with a `box.of` namespace member).
// Serves: find_definition (multiple decls), expand_type.

/** Overload set — two call signatures, one implementation. */
export function coerce(value: number): string;
export function coerce(value: string): number;
export function coerce(value: number | string): string | number {
  return typeof value === 'number' ? String(value) : value.length;
}

/** Function + namespace merge (declaration merging). */
export function box(label: string): { label: string } {
  return { label };
}
export namespace box {
  export const of = (label: string): { label: string } => box(label);
  export const empty = '';
}
