// trap M4 (deep re-export chain — hop 3 of 3): the deep path's public face. A consumer
// (features/dashboard/Dashboard.tsx) imports `formatLabel` from HERE while others import it
// from the hub (shared/index.ts) or the decl directly — the dual-path rename trap.
export { formatLabel } from './b.ts';
