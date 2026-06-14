// trap M12 target: types referenced elsewhere via the `import('@/data/shapes').Foo` TYPE
// operator (not an ES import statement) — see core/io.ts and forms/Form.tsx. move_file /
// rename must rewrite BOTH the embedded path AND the symbol; ES-import analysis alone misses
// it. Mined from a real repo (353 such uses). Stub types.
export interface Foo {
  id: string;
  count: number;
}

export interface Bar {
  foo: Foo;
  note?: string;
}

export type Envelope<T> = { data: T; status: number };
