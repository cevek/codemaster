// Branded primitives: a string or number that carries identity/semantics we must not
// confuse with free text or an arbitrary count. The brand makes a category error a
// compile error — you cannot pass a `Glob` where a `RepoRelPath` is wanted, or a
// `FileVersion` where an `IndexVersion` is. Deliberately few: only the ones that recur
// across the codebase.
//
// Values are branded at the boundary — zod on the way in, the indexer on the way out —
// and flow already-branded within the code. Config inputs stay plain `string` for
// authoring ergonomics and are branded by the loader.

/** A repo-relative path, **canonicalized at the one minting chokepoint**: forward slashes
 *  always (never Windows `\`); case-folded on case-insensitive volumes (APFS/NTFS — detected,
 *  not assumed) and preserved on case-sensitive ones; symlinks resolved by a fixed `realpath`
 *  policy. Never absolute, never a glob. It is the graph's primary key (and part of
 *  `SymbolId`), so two spellings of one file MUST brand to one value, or freshness and
 *  `refs`/`rebind` silently misfire — see ARCHITECTURE.md §19. */
export type RepoRelPath = string & { readonly __brand: 'RepoRelPath' };

/** A glob pattern that matches paths — not itself a path. */
export type Glob = string & { readonly __brand: 'Glob' };

/** Opaque identifier of a repo the daemon serves (git root / nearest config). */
export type RepoId = string & { readonly __brand: 'RepoId' };

/** Identifier of a node in the knowledge graph. Graph-internal — distinct from the
 *  agent-facing `SymbolId`. */
export type NodeId = string & { readonly __brand: 'NodeId' };

/** Monotonic version of the whole graph, bumped on every atomic swap. */
export type IndexVersion = number & { readonly __brand: 'IndexVersion' };

/** Per-file version stamp. A `SymbolId` binds to this, never to `IndexVersion` — keeping
 *  them distinct types makes that confusion impossible. */
export type FileVersion = number & { readonly __brand: 'FileVersion' };
