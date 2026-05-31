// A JSON-serializable value. The graph, list entries, and on-disk snapshots are all JSON
// (ARCHITECTURE.md §18), so the open "extras" bags are typed as this — never `unknown`.
// It is honest about what can actually live there and keeps non-serializable junk
// (functions, symbols, class instances) out of anything that must round-trip a snapshot.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
