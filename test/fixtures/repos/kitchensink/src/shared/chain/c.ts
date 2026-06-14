// trap M4 (deep re-export chain — hop 1 of 3): decl(core/format) → c → b → a → consumer.
// `formatLabel` is also reachable via the hub (shared/index.ts) — two valid paths to one
// symbol. rename must update regardless of which path each consumer used; find_usages must
// resolve through `export *`.
export { formatLabel } from '@/core/format.ts';
