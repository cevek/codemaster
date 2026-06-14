// In-memory content overlay on the LS host (spec §2.7) — the dry-run engine. While set, a
// file's overlaid content shadows disk so the LanguageService typechecks POST-edit source
// without writing anything; cleared, the host behaves exactly as before (inert when empty,
// guarding every existing read-op test).
//
// Correctness hinges on versioning: every set/clear bumps a MONOTONIC counter that never
// resets, and the host folds it into `getScriptVersion` + `getProjectVersion`, so the LS
// invalidates its cached program. Without that, `getSemanticDiagnostics` would run against
// the pre-edit program and the §2.8 typecheck gate would silently pass unchecked code.

export interface OverlayEntry {
  /** Posix absolute path (the key the LS host uses internally). */
  abs: string;
  content: string;
}

export class Overlay {
  private readonly files = new Map<string, { content: string; version: number }>();
  /** Paths TOMBSTONED for this overlay: a moved file's OLD location, hidden from the LS so
   *  an importer we failed to rewrite dangles and the dry-run typecheck catches it (§2.7).
   *  Threaded through `fileExists`/`readFile` too — not just the file list — or the old file
   *  stays resolvable on disk and the missed rewrite is invisible. */
  private readonly removed = new Set<string>();
  /** Monotonic across the host lifetime — never reset, so a cleared-then-reset overlay
   *  still presents a version the LS has not seen, forcing a re-read. */
  private counter = 0;

  has(absPosix: string): boolean {
    return this.files.has(absPosix);
  }

  get(absPosix: string): { content: string; version: number } | undefined {
    return this.files.get(absPosix);
  }

  isRemoved(absPosix: string): boolean {
    return this.removed.has(absPosix);
  }

  keys(): IterableIterator<string> {
    return this.files.keys();
  }

  /** True when some overlaid file lives under `dirPosix` — so module resolution into a
   *  not-yet-on-disk destination directory (a move target) succeeds during the dry-run. */
  hasDirectory(dirPosix: string): boolean {
    const prefix = `${dirPosix}/`;
    for (const f of this.files.keys()) if (f.startsWith(prefix)) return true;
    return false;
  }

  removedKeys(): IterableIterator<string> {
    return this.removed.keys();
  }

  isEmpty(): boolean {
    return this.files.size === 0 && this.removed.size === 0;
  }

  /** Replace the overlay with exactly `entries` (added/overridden) and `removed`
   *  (tombstoned); bumps the version token. */
  set(entries: readonly OverlayEntry[], removed: readonly string[] = []): void {
    this.counter++;
    this.files.clear();
    this.removed.clear();
    for (const e of entries) this.files.set(e.abs, { content: e.content, version: this.counter });
    for (const r of removed) this.removed.add(r);
  }

  /** Drop all overlaid content/tombstones; bumps the version so files revert to disk. */
  clear(): void {
    this.counter++;
    this.files.clear();
    this.removed.clear();
  }
}
