// Where a declared prop's DECLARATION lives — the provenance the unused-props view narrows on.
// A wrapper over `React.ComponentProps<'button'>` declares ~290 members it did not write and
// cannot delete; the props a dead-prop cleanup can act on are the ones declared in the repo's
// OWN source. The discriminator is the member's declaration FILE, not its heritage: an anonymous
// intersection (`type P = React.ComponentProps<…> & { own?: boolean }`) has no named owning type,
// so `ParamTypeMember.inherited` is absent for EVERY member there — the two claims are different
// and only this one holds on that shape.
//
// Input is a `RepoRelPath` (the ts seam's spans go through `host.relOf`), NOT the absolute
// `ts.SourceFile.fileName` the `/node_modules/` filters elsewhere in the tree test — hence the
// leading-segment arm: an in-root dependency file is `node_modules/…`, with no leading slash.

import type { Span } from '../../core/span.ts';

/** True when the declaration provably sits outside the repo's own source — under a
 *  `node_modules` segment, or outside the repo root (`relOf` passes such a path through
 *  absolute; codemaster's bundled `lib.*.d.ts` lands there, §5-L1).
 *
 *  A member with NO declaration span (a synthesized member) is NOT external: ownership is
 *  undetermined, and hiding what we cannot prove foreign is the silent-omission lie (§3.4). */
export function isExternalDeclaration(span: Span | undefined): boolean {
  if (span === undefined) return false;
  const file: string = span.file;
  // Outside the root: an absolute posix path, or a Windows drive-letter path (`relOf` posix-
  // normalizes but keeps the drive prefix).
  if (file.startsWith('/') || /^[A-Za-z]:/.test(file)) return true;
  return (
    file === 'node_modules' || file.startsWith('node_modules/') || file.includes('/node_modules/')
  );
}
