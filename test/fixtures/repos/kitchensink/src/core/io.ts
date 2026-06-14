// trap M12 (import('…').Type type-query in a signature, NOT an ES import) + T7 (a symbol
// used ONLY in a type position). `load` takes a `import('@/data/shapes').Bar` and returns an
// `Envelope<Foo>` via the type operator — no ES import of those names exists in this file.
export function load(id: string): import('@/data/shapes').Envelope<import('@/data/shapes').Foo> {
  return { data: { id, count: 0 }, status: 200 };
}

export function describeBar(bar: import('@/data/shapes').Bar): string {
  return bar.note ?? bar.foo.id;
}
