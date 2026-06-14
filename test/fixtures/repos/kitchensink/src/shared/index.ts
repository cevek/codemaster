// traps M2 (barrel: `export *` + `export { X } from`) + M3 (re-export WITH rename). This is
// the "hub" barrel; the M4 dual-path symbol (formatLabel) is reachable BOTH through here and
// through the 3-hop chain (./chain/a.ts). Serves: reexport role split, move, rename.
export * from '@/core/registry.ts';
export { formatLabel } from '@/core/format.ts';
export { Severity } from '@/core/kinds.ts';

// re-export WITH rename (M3): `handle` surfaces here as `coreHandle`.
export { handle as coreHandle } from '@/core/handle.ts';

// re-export a component WITH rename (M3): consumed as `<Card/>` in features/misc/Showcase.tsx.
export { Widget as Card } from '@/features/widget/Widget.tsx';
