// trap T9 (rebind anchors): `movableAnchor` will be MOVED by a move/extract test — its
// SymbolId must rebind `rebound`. `deletableAnchor` will be DELETED — its SymbolId must
// rebind `gone`. Both have clear, exclusive consumers (Showcase.tsx) so the blast radius is
// pinnable. Also imports @/lib/util WITH the .ts extension (M11 spelling A).
import { clamp } from '@/lib/util.ts';

/** MOVE anchor (T9 → rebound). */
export function movableAnchor(n: number): number {
  return clamp(n, 0, 10);
}

/** DELETE anchor (T9 → gone). */
export function deletableAnchor(): string {
  return 'delete-me';
}
