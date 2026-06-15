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
import { readTextFile } from '../support/fs/read-file.ts';
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
      match
        .getMultipleMatches(name)
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
): string | null {
  const root = sg.parse(isTsx ? sg.Lang.Tsx : sg.Lang.TypeScript, before).root();
  const matches = root.findAll(pattern);
  if (matches.length === 0) return null;
  return root.commitEdits(matches.map((m) => m.replace(substitute(rewrite, m))));
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
      files = args.paths.map((p) => p as RepoRelPath);
    } else {
      const ls = await gitLsFiles(root);
      if (!isOk(ls)) return fail(ls.failure);
      files = ls.data.map(brandGitPath);
    }
    files = files.filter((f) => /\.(tsx?|mts|cts)$/.test(f));

    const changes: MutationChange[] = [];
    try {
      for (const path of files) {
        const read = readTextFile(absOf(root, path));
        if (!read.ok) continue; // unreadable file — skip, never guess
        const after = rewriteFile(sg, path.endsWith('.tsx'), read.data, args.pattern, args.rewrite);
        if (after !== null && after !== read.data) changes.push({ path, before: read.data, after });
      }
    } catch (thrown) {
      return failFromThrown('ast-grep', thrown);
    }

    // Shape-based: a rewrite can break an un-matched importer, so widen the §2.8 gate to the
    // whole program (crossFileScope) — unlike symbol-anchored rename, whose changeset is complete.
    return applyMutation(ctx, changes, {
      crossFileScope: true,
      ...(args.dirtyOk !== undefined ? { dirtyOk: args.dirtyOk } : {}),
    });
  },
});
