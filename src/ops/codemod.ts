// `codemod` — shape-based structural find/replace via ast-grep (§7). Explicitly NOT
// symbol-anchored: it matches an AST PATTERN, so it can never rewrite a same-named binding
// that doesn't match the shape (the safety distinction from rename_symbol). The transform is
// purely syntactic; correctness is gated by the same §2.8 post-edit typecheck as every
// mutating op (a rewrite that breaks compilation is refused / rolled back).
//
// ast-grep's `node.replace(text)` does NOT substitute metavariables, so the rewrite template
// is expanded here from the per-match captures: `$X` → one node, `$$$X` → many (comma-joined).

import { z } from 'zod';
import type { Result } from '../core/result.ts';
import type { JsonValue } from '../core/json.ts';
import type { RepoRelPath } from '../core/brands.ts';
import { fail, failFromThrown } from '../common/result/construct.ts';
import { isOk } from '../common/result/narrow.ts';
import { gitLsFiles } from '../support/git/ls-files.ts';
import { brandGitPath } from '../support/fs/canonicalize.ts';
import { matchesAnyGlob } from '../common/glob/match.ts';
import { readTextFile } from '../support/fs/read-file.ts';
import type { Capture, CodemodEdit, CodemodRegion, TsPluginApi } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import { absOf } from './mutation-support.ts';
import { applyMutation, type MutationChange } from './refactor-apply.ts';
import type * as AstGrepModule from '@ast-grep/napi';

type AstGrep = typeof AstGrepModule;
type SgMatch = ReturnType<ReturnType<ReturnType<AstGrep['parse']>['root']>['findAll']>[number];

const codemodArgsSchema = z.strictObject({
  pattern: z.string().min(1),
  rewrite: z.string(),
  /** Restrict to these files; default scans every tracked TS file. */
  paths: z.array(z.string()).optional(),
  dirtyOk: z.boolean().optional(),
});
type CodemodArgs = z.infer<typeof codemodArgsSchema>;

/** Metavariable names by sigil: `$$$X` (multi) vs `$X` (single). They're DISTINCT — `$X`
 *  referencing a `$$$X` capture has no single match (`getMatch` returns null) and would emit
 *  the literal `$X`, so the guard below must reject a sigil mismatch, not just an unbound name. */
function metavars(s: string): { single: Set<string>; multi: Set<string> } {
  const multi = new Set<string>();
  for (const m of s.matchAll(/\$\$\$([A-Z_][A-Z0-9_]*)/g)) if (m[1] !== undefined) multi.add(m[1]);
  const single = new Set<string>();
  for (const m of s.replace(/\$\$\$[A-Z_][A-Z0-9_]*/g, '').matchAll(/\$([A-Z_][A-Z0-9_]*)/g)) {
    if (m[1] !== undefined) single.add(m[1]);
  }
  return { single, multi };
}

/** ast-grep has `$X` (one node) and `$$$X` (many) — NOT `$$X`. A two-dollar token slips the
 *  `$$$` strip and the single-`$` regex then matches its SECOND `$`, leaving a literal `$` in
 *  the output. Reject it up front rather than emit a stray `$` (strip `$$$X` first so it's not
 *  a false positive on the three-dollar form). */
function hasTwoDollarMetavar(s: string): boolean {
  return /\$\$[A-Z_]/.test(s.replace(/\$\$\$[A-Z_][A-Z0-9_]*/g, ''));
}

/** Expand a rewrite template against one match's captured metavariables. */
function substitute(template: string, match: SgMatch): string {
  return template
    .replace(/\$\$\$([A-Z_][A-Z0-9_]*)/g, (_, name: string) =>
      // `getMultipleMatches` returns the list INCLUDING the separator nodes (the `,` punctuation
      // between args), so joining every node with ', ' double-emits them: `cn(a, b)` → `clsx(a, ,,
      // b)` (spec-stresstest §2a). Keep only the NAMED nodes (the real arguments) and re-join with
      // a single separator so `$$$` reconstructs a clean list.
      // KNOWN LIMITATION: an ELIDED array hole (`[a, , b]`) has no node, so `$$$` drops it and the
      // list shifts to `[a, b]` — a pathological, vanishingly-rare source shape, and codemod is
      // shape-not-semantic by contract; the whole-program gate still guards type-breaking rewrites.
      match
        .getMultipleMatches(name)
        .filter((n) => n.isNamed())
        .map((n) => n.text())
        .join(', '),
    )
    .replace(/\$([A-Z_][A-Z0-9_]*)/g, (whole, name: string) => {
      const m = match.getMatch(name);
      return m === null ? whole : m.text();
    });
}

function rewriteFile(
  sg: AstGrep,
  isTsx: boolean,
  before: string,
  pattern: string,
  rewrite: string,
): { after: string; regions: CodemodRegion[] } | null {
  const root = sg.parse(isTsx ? sg.Lang.Tsx : sg.Lang.TypeScript, before).root();
  const matches = root.findAll(pattern);
  if (matches.length === 0) return null;
  const edits = matches.map((m) => m.replace(substitute(rewrite, m)));
  const after = root.commitEdits(edits);
  // The post-edit span of each rewrite (for capture-safety §): sort by start offset, accumulate the
  // length delta of earlier edits. `commitEdits` DROPS an edit that overlaps an already-applied one
  // (nested matches: `f($X)` over `f(f(1))` yields two matches, only the outer is committed), so we
  // must mirror that here — an overlapping edit is skipped, contributing NO delta — else its phantom
  // delta shifts every later region (a desynced capture window).
  //
  // ast-grep offsets are UTF-8 BYTE indices; the capture check enumerates identifiers at TS UTF-16
  // CHAR offsets. Mixing them on non-ASCII source mis-bounds a window — which can MISS a capture OR
  // FABRICATE one (refuse a clean codemod, the §1 over-refusal risk). So convert every edit boundary
  // byte→UTF-16 up front and build the regions entirely in char space (`insertedText.length` is
  // already UTF-16). The written `after` is byte-correct regardless (it's ast-grep's commitEdits).
  const charOf = byteToUtf16(
    before,
    edits.flatMap((e) => [e.startPos, e.endPos]),
  );
  const regions: CodemodRegion[] = [];
  let delta = 0;
  let prevEnd = -1;
  for (const e of [...edits].sort((a, b) => a.startPos - b.startPos)) {
    const beforeStart = charOf(e.startPos);
    const beforeEnd = charOf(e.endPos);
    if (beforeStart < prevEnd) continue; // overlaps an applied edit → dropped by commitEdits
    const deletedLength = beforeEnd - beforeStart;
    const afterStart = beforeStart + delta;
    const afterEnd = afterStart + e.insertedText.length;
    regions.push({ beforeStart, beforeEnd, afterStart, afterEnd });
    delta += e.insertedText.length - deletedLength;
    prevEnd = beforeEnd;
  }
  return { after, regions };
}

/** A byte-offset → UTF-16-char-offset resolver for `text`, built in ONE pass over the requested
 *  offsets (ast-grep reports UTF-8 byte indices; TS — and the capture check — use UTF-16). For an
 *  ASCII file every byte == its char index, so this is the identity; it only matters on non-ASCII.
 *  An offset that isn't on a code-point boundary (shouldn't happen for AST node bounds) falls back
 *  to the byte value, preserving the old ASCII behavior. */
function byteToUtf16(text: string, byteOffsets: readonly number[]): (byte: number) => number {
  const want = [...new Set(byteOffsets)].sort((a, b) => a - b);
  const map = new Map<number, number>();
  let byte = 0;
  let utf16 = 0;
  let wi = 0;
  for (const cp of text) {
    while (wi < want.length && want[wi] === byte) map.set(want[wi++] as number, utf16);
    if (wi >= want.length) break;
    byte += Buffer.byteLength(cp, 'utf8');
    utf16 += cp.length;
  }
  while (wi < want.length && (want[wi] as number) <= byte) map.set(want[wi++] as number, utf16);
  return (b) => map.get(b) ?? b;
}

export const codemodOp = defineOp<CodemodArgs, JsonValue>({
  name: 'codemod',
  summary: 'Shape-based structural find/replace via ast-grep — NOT symbol-anchored (§7)',
  mutating: true,
  requires: ['ts'],
  argsSchema: codemodArgsSchema,
  argsHint: '{ pattern: string, rewrite: string, paths?: string[], dirtyOk?: boolean }',
  example: { args: { pattern: 'oldApi($A)', rewrite: 'newApi($A)' } },
  notes: [
    'matches AST SHAPE, not a symbol — it never touches a same-named binding that does not match the pattern. Metavars: $X (one node), $$$X (many, comma-joined — intended for argument/array lists).',
    'dry-run/apply like every mutating op; the whole-program typecheck gates apply on errors the rewrite INTRODUCES (diffed against a pre-edit baseline — pre-existing repo errors are a preExisting count, not a block) and rolls back a rewrite that introduces new ones.',
    'paths (optional) are GLOBS over tracked .ts/.tsx (e.g. "src/features/**", "**/*.tsx") — a literal file path works too; an entry that selects no tracked TS file FAILS loudly (never a silent clean). Omit paths to scan every tracked TS file.',
    'capture-safe (best-effort, shape-based): a metavar ($X/$$$X) identifier PRESERVED into a rewritten span that silently re-resolves to a different declaration is listed under `captures` and apply is REFUSED. An INTRODUCED identifier binding a same-named local is NOT flagged (it would over-refuse) — the whole-program typecheck is its guard. summaryOnly:true returns the verdict + a per-file diffstat instead of the full diff.',
  ],
  async run(ctx, args): Promise<Result<JsonValue>> {
    const root = ctx.daemon?.root;
    if (root === undefined)
      return fail({ tool: 'engine', message: 'no workspace root in op context' });

    // A rewrite metavar the pattern never captured (or captured under the OTHER sigil) would
    // otherwise be emitted literally (`$X` is a valid identifier) and could compile — a silent
    // wrong edit. Reject an unbound name AND a single/multi sigil mismatch.
    const pat = metavars(args.pattern);
    const rw = metavars(args.rewrite);
    const bad = [
      ...[...rw.single].filter((v) => !pat.single.has(v)).map((v) => `$${v}`),
      ...[...rw.multi].filter((v) => !pat.multi.has(v)).map((v) => `$$$${v}`),
    ];
    if (bad.length > 0) {
      return fail({
        tool: 'codemod',
        message: `rewrite metavariable(s) not captured by the pattern (or wrong $ vs $$$ sigil): ${bad.join(', ')}`,
      });
    }
    if (hasTwoDollarMetavar(args.pattern) || hasTwoDollarMetavar(args.rewrite)) {
      return fail({
        tool: 'codemod',
        message: 'a `$$X` metavariable is not supported — use `$X` for one node or `$$$X` for many',
      });
    }

    let sg: AstGrep;
    try {
      sg = await import('@ast-grep/napi');
    } catch (thrown) {
      return failFromThrown('ast-grep', thrown);
    }

    const ls = await gitLsFiles(root);
    if (!isOk(ls)) return fail(ls.failure);
    const trackedTs = ls.data.map(brandGitPath).filter((f) => /\.(tsx?|mts|cts)$/.test(f));

    let files: RepoRelPath[];
    if (args.paths !== undefined) {
      // A `../`-escaping path would read/write outside the repo — invisible to the dirty-gate
      // and unrecoverable by rollback. Refuse (the default tracked listing can't produce one).
      const escaping = args.paths.filter((p) => p.split(/[\\/]/).includes('..'));
      if (escaping.length > 0) {
        return fail({
          tool: 'codemod',
          message: `path(s) escape the repo root: ${escaping.join(', ')}`,
        });
      }
      // `paths` are GLOBS over tracked TS files, same engine as scss/usages `pathInclude` — so a
      // directory glob (`src/features/**`) and a literal file path both work. A silent 0-match
      // reads as "no matches in scope" and is dangerous (spec-stresstest §2b): fail loudly naming
      // every entry that selected no tracked TS file (a typo'd path, a glob over an empty dir, a
      // wrong extension), rather than report a misleading `clean=true`.
      const selected = new Set<RepoRelPath>();
      const empty: string[] = [];
      for (const pat of args.paths) {
        const hits = trackedTs.filter((f) => matchesAnyGlob(f, [pat]));
        if (hits.length === 0) empty.push(pat);
        for (const h of hits) selected.add(h);
      }
      if (empty.length > 0) {
        return fail({
          tool: 'codemod',
          message: `paths entr${empty.length === 1 ? 'y' : 'ies'} matched no tracked TS file: ${empty.join(', ')} (paths are globs over tracked .ts/.tsx — check the spelling/extension/scope)`,
        });
      }
      files = [...selected];
    } else {
      files = trackedTs;
    }

    const changes: MutationChange[] = [];
    const codemodEdits: CodemodEdit[] = [];
    try {
      for (const path of files) {
        const read = readTextFile(absOf(root, path));
        if (!read.ok) continue; // unreadable file — skip, never guess
        const rw = rewriteFile(sg, path.endsWith('.tsx'), read.data, args.pattern, args.rewrite);
        if (rw !== null && rw.after !== read.data) {
          changes.push({ path, before: read.data, after: rw.after });
          codemodEdits.push({ path, before: read.data, after: rw.after, regions: rw.regions });
        }
      }
    } catch (thrown) {
      return failFromThrown('ast-grep', thrown);
    }

    // Capture-safety (§): a metavar-preserved identifier inside a rewritten span can silently
    // re-resolve to a DIFFERENT declaration (type-compatible → invisible to the §2.8 gate). The LS
    // access lives in the ts plugin (ops never reach the LS — §5-L3). A throw here degrades the
    // signal to a warning rather than sinking a codemod the typecheck still gates (§3.6).
    let captures: Capture[] = [];
    const captureWarnings: string[] = [];
    if (codemodEdits.length > 0) {
      try {
        captures = ctx.plugins.get<TsPluginApi>('ts').detectCodemodCaptures(codemodEdits);
      } catch {
        captureWarnings.push(
          'the capture-safety check could not run — the §2.8 whole-program typecheck still gated this edit',
        );
      }
    }

    // Shape-based: a rewrite can break an un-matched importer, so widen the §2.8 gate to the
    // whole program (crossFileScope) — unlike symbol-anchored rename, whose changeset is complete.
    return applyMutation(ctx, changes, {
      crossFileScope: true,
      captures,
      captureAction:
        'narrow the pattern, or rename the colliding binding the rewrite now resolves to',
      ...(captureWarnings.length > 0 ? { warnings: captureWarnings } : {}),
      ...(args.dirtyOk !== undefined ? { dirtyOk: args.dirtyOk } : {}),
    });
  },
});
