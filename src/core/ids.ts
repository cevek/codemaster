import type { Loc, Span, Confidence } from './span.js';

/** Opaque, **per-file-version-scoped** handle to a symbol. Encodes
 *  `(repoId, file, name, kind, fileVersion)` behind a branded string so an agent can
 *  chain `search → resolve → refs → edit` without re-searching.
 *
 *  A handle binds to *its file's* version (`Graph.fileVersions`), not the global
 *  `indexVersion` — so a change to some *other* file never stales it. When the handle's
 *  own file has changed, the verb re-locates the symbol and reports a proof-carrying
 *  rebind. See `HandleRebind` and ARCHITECTURE.md §6. */
export type SymbolId = string & { readonly __brand: 'SymbolId' };

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'method'
  | 'property'
  | 'component'
  | 'hook'
  | 'module';

/** The lightweight shape returned by `search` and accepted everywhere a target is
 *  needed. */
export interface SymbolRef {
  id: SymbolId;
  name: string;
  kind: SymbolKind;
  loc: Loc;
}

/** Proof-carrying rebind (ARCHITECTURE.md §6), carried on `Result.handle`. When a
 *  `SymbolId` minted at an older file version is used and that file has since changed,
 *  the symbol is re-located and the answer computed against its current home.
 *
 *  Crucial: `proof` proves a symbol of this name/kind sits at `to` *now* — it is proof
 *  of **location, not identity**. `confidence` says whether it is provably the *same*
 *  logical symbol: `certain` only with structural-continuity evidence; otherwise
 *  `partial`/`unresolved` with a `note` ("a symbol of this name/kind is here now; can't
 *  prove it's the one you held"). We never silently claim identity we can't prove — that
 *  is the lie this whole handle protocol exists to prevent.
 *
 *  A cross-file move (`moveFile`/`extractSymbol`) is a `rebound` whose `to` is in the new
 *  file; `gone` means the symbol is truly absent, not merely moved. */
export type HandleRebind =
  | {
      status: 'rebound';
      from: SymbolId;
      to: SymbolRef;
      proof: Span;
      confidence: Confidence;
      note?: string;
    }
  | { status: 'gone'; from: SymbolId; reason: string };
