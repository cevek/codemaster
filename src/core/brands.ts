// Branded primitives: a string or number that carries identity/semantics we must not
// confuse with free text or an arbitrary count. The brand makes a category error a
// compile error — you cannot pass a `Glob` where a `RepoRelPath` is wanted. Deliberately
// few: only the ones that recur across the codebase.
//
// Values are branded at the boundary — zod on the way in, each plugin on the way out —
// and flow already-branded within the code. Config inputs stay plain `string` for
// authoring ergonomics and are branded by the loader.

/** A repo-relative path, **canonicalized at the one minting chokepoint**: forward slashes
 *  always (never Windows `\`); case-folded on case-insensitive volumes (APFS/NTFS — detected,
 *  not assumed) and preserved on case-sensitive ones; symlinks resolved by a fixed `realpath`
 *  policy. Never absolute, never a glob. Every plugin keys its data by `RepoRelPath` and it
 *  is part of `SymbolId`, so two spellings of one file MUST brand to one value, or freshness
 *  and `find_usages`/rebind silently misfire — see ARCHITECTURE.md §19. */
export type RepoRelPath = string & { readonly __brand: 'RepoRelPath' };

/** A glob pattern that matches paths — not itself a path. */
export type Glob = string & { readonly __brand: 'Glob' };

/** Opaque identifier of a repo the daemon serves (git root / nearest config). */
export type RepoId = string & { readonly __brand: 'RepoId' };

/** Per-file version stamp, plugin-private. Each plugin maintains its own per-file
 *  versions for its own internal tracking; `SymbolId` may encode the owning plugin's
 *  per-file version so a stale handle's rebind (§6) is observable. There is no global
 *  index version across plugins — each plugin's state evolves independently. */
export type FileVersion = number & { readonly __brand: 'FileVersion' };
