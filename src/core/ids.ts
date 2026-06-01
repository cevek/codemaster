import type { Loc, Span, Confidence } from './span.js';

/** Opaque, **per-file-version-scoped, plugin-routed** handle. Encodes a plugin prefix
 *  (e.g. `ts:`, `scss:`, `i18n:`, `react-query:`) plus a plugin-private payload that
 *  the owning plugin alone decodes. Lets an agent chain
 *  `find_definition → find_usages → rename_symbol` without re-searching.
 *
 *  A handle binds to *its file's* version inside the owning plugin's state, not anything
 *  global — so a change to some *other* file never stales it. When the handle's own file
 *  has changed, the owning plugin re-locates the symbol and reports a proof-carrying
 *  rebind. See `HandleRebind` and ARCHITECTURE.md §6.
 *
 *  Examples (only the prefix is contract; everything after is plugin-private):
 *  - `ts:Button@src/Button.tsx:v7`
 *  - `scss:.button@src/styles/button.module.scss:v3`
 *  - `i18n:profile.greeting@locales/en.json:v2`
 *  - `route:/users@src/routes/users.tsx:v4` */
export type SymbolId = string & { readonly __brand: 'SymbolId' };

/** Kind names are **plugin-defined**: the `ts` plugin emits things like `function` /
 *  `class` / `component` / `hook`; the `scss` plugin emits `css-class`; the `i18n` plugin
 *  emits `i18n-key`; framework plugins emit their own (`route`, `mutation`, `query`,
 *  `store`, …). Codemaster's core enumerates none of them — `status` lists what each
 *  active plugin can produce. The `& {}` keeps autocomplete usable while allowing any
 *  string. */
export type SymbolKind = string & {};

/** The lightweight shape returned by symbol-yielding ops and accepted everywhere a target
 *  is needed. `kind` is plugin-defined (see above). */
export interface SymbolRef {
  id: SymbolId;
  name: string;
  kind: SymbolKind;
  loc: Loc;
}

/** Proof-carrying rebind (ARCHITECTURE.md §6), carried on `Result.handle`. When a
 *  `SymbolId` minted at an older file version is used and that file has since changed,
 *  the owning plugin re-locates the symbol and computes the answer against its current
 *  home. Each plugin owns its rebind algorithm; the shape of the result is universal.
 *
 *  Crucial: `proof` proves a symbol of this name/kind sits at `to` *now* — it is proof
 *  of **location, not identity**. `confidence` says whether it is provably the *same*
 *  logical symbol: `certain` only with structural-continuity evidence; otherwise
 *  `partial`/`unresolved` with a `note` ("a symbol of this name/kind is here now; can't
 *  prove it's the one you held"). We never silently claim identity we can't prove — that
 *  is the lie this whole handle protocol exists to prevent.
 *
 *  A cross-file move (e.g. `move_file` / `extract_symbol`) is a `rebound` whose `to` is
 *  in the new file; `gone` means the symbol is truly absent, not merely moved. */
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
