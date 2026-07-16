// The typed rich-marker layer over `elideString` (§3.4): cut a type/signature string at its
// registered `CapId` cap and, on a cut, append a recovery marker that reports the FULL length and
// how to get the rest. Every `typeToString(…NoTruncation)` render in the tree routes here so the
// marker + verbosity attach BY CONSTRUCTION — a bare `…` on a real type would read as completeness.

import type { Verbosity } from '../../core/result.ts';
import { elideString } from './elide-string.ts';
import { CAP_DESCRIPTORS, capFor, type CapId, type CapDescriptor } from './cap-ids.ts';

/** The recovery clause for a cut marker, per the descriptor's `recover`. `length-only` returns ''
 *  (the marker reports length alone — no recovery the op can actually offer, §3.6). */
function recoverClause(desc: CapDescriptor): string {
  switch (desc.recover) {
    case 'verbosity':
      return ' — verbosity:full';
    case 'verbosity+param':
      return ' — verbosity:full, or expand_type the param type';
    case 'length-only':
      return '';
  }
}

/** Cut a type/signature string at its `CapId` cap (verbosity-aware where the descriptor allows it),
 *  appending on a cut an explicit `(<kind> elided: N chars[ — <recover>])` marker that reports the
 *  full length. Under the cap the string is returned verbatim. This is the single home for the
 *  formerly copy-pasted `typeStr`/`signatureStr` elide idiom (§4 one-parser; t-487095). */
export function elideType(s: string, capId: CapId, verbosity: Verbosity = 'normal'): string {
  const desc = CAP_DESCRIPTORS[capId];
  const cut = elideString(s, capFor(desc, verbosity));
  if (!cut.elided) return cut.text;
  return `${cut.text} (${desc.kind} elided: ${cut.total} chars${recoverClause(desc)})`;
}
