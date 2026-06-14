// trap M9 (string-keyed React.lazy registry): the HONEST-LIMITATION case — a symbol rename
// can't reach a string path inside `import('./X')`, so it must be FLAGGED, not silently
// missed. move_file must still rewrite the dynamic specifier. Mirrors a 172-entry registry
// mined from a real repo (here: a representative handful).
import { lazy } from 'react';

export const lazyRegistry = {
  widget: lazy(() => import('@/features/widget/Widget.tsx').then((m) => ({ default: m.Widget }))),
  panel: lazy(() => import('@/features/panel/Panel.tsx').then((m) => ({ default: m.Panel }))),
  table: lazy(() => import('@/features/table/Table.tsx').then((m) => ({ default: m.Table }))),
} as const;

export type LazyKey = keyof typeof lazyRegistry;
