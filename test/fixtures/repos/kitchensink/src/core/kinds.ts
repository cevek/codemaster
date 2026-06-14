// traps T1 (enum / union / interface / type-alias / generic interface): the structural
// kind-zoo for expand_type / search_symbol / find_definition. Keep the REAL `enum` here so
// expand_type's enum path stays covered (the T10 string-union lives in ./status.ts).

/** A real runtime enum (T1) — expand_type enum-member path. */
export enum Severity {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
}

/** Union type (T1) — expand_type union-constituents path. */
export type Primitive = string | number | boolean;

/** Type alias (T1). */
export type Id = string & { readonly __id: unique symbol };

/** Generic interface (T1) — structural members, generic param. */
export interface Box<T> {
  readonly value: T;
  readonly label: string;
}

/** Plain interface (T1) — members, optional, inherited-flag coverage. */
export interface Shape {
  id: Id;
  severity: Severity;
  tags?: readonly string[];
}
