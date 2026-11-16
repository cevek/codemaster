// Emulated workspace links (t-403708): the `node_modules/<member>` symlinks a package manager would
// create for a monorepo's own packages, presented by the LS host on a tree that has no install (a
// read-only snapshot, a fresh clone). TS stays the only resolver (§4) — it walks `node_modules`,
// reads the member's `package.json` `exports`/`types`/`main` and picks the file exactly as it would
// over a real link; this module only answers the filesystem questions for the link path the manager
// would have made. `realpath` maps the link to the member's real dir, so the member's source loads
// ONCE under its real path and unifies with the member's own program (a second SourceFile under the
// synthetic path would split every usage set).
//
// The policy is the manager's, conservatively: a link exists only where the consumer's OWN
// package.json declares the member (pnpm: a `workspace:` spec — its `link-workspace-packages`
// default; npm/yarn `workspaces`: any spec). npm's hoisting of undeclared members to the root is NOT
// emulated, a path that exists on disk is never shadowed, and a member name two packages share is
// not linked. Whatever stays unresolved is the honest floor's (`unresolved-workspace-imports.ts`).

import { lstatSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { matchesAnyGlob } from '../../../common/glob/match.ts';
import { toPosix } from '../../../support/fs/canonicalize.ts';
import { readWorkspaceManifest } from './workspace-globs.ts';

export interface WorkspaceLinks {
  /** The member path a synthetic link path stands for, or `undefined` when `absPosix` is not under
   *  an emulated link. */
  translate(absPosix: string): string | undefined;
  /** A `node_modules` / `node_modules/@scope` directory that exists only as an emulated link's
   *  parent. */
  isSyntheticDir(absPosix: string): boolean;
  /** Member package names whose emulated link a lookup has gone through, sorted. */
  used(): readonly string[];
  /** Emulated links in the current map. */
  count(): number;
  /** Every workspace member's package name (linked or not) — what a bare specifier must name to be
   *  this repo's own package. */
  memberNames(): ReadonlySet<string>;
  /** `ts.sys` seen through the links — for module resolution outside an LS program, so an
   *  out-of-program resolve agrees with what a program under `options` resolved (a
   *  `preserveSymlinks` program sees no links, so neither does its resolve). */
  resolutionHost(options: ts.CompilerOptions): ts.ModuleResolutionHost;
  /** Drop the map (a `package.json` / workspace-manifest change); rebuilt on the next lookup. */
  refresh(): void;
  /** Bumps on every `refresh` — a program whose resolutions predate it must re-resolve. */
  generation(): number;
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const NM = '/node_modules/';

export function createWorkspaceLinks(
  root: string,
  /** The host's cached repo walk (repo-relative posix) — no walk of its own (§19). */
  repoFiles: () => readonly string[],
): WorkspaceLinks {
  let table: LinkTable | undefined;
  let generation = 0;
  const used = new Set<string>();
  const current = (): LinkTable => (table ??= buildLinks(toPosix(root), repoFiles()));
  const links = (): Map<string, string> => current().links;
  // TS probes `<dir>/node_modules` (and `@scope`) for existence before looking inside, so the
  // ancestors of a link must exist too — as directories only, holding nothing else.
  const isSyntheticDir = (absPosix: string): boolean =>
    absPosix.includes('/node_modules') && current().dirs.has(absPosix.replace(/\/+$/, ''));

  const translate = (absPosix: string): string | undefined => {
    if (!absPosix.includes(NM)) return undefined;
    const table = links();
    if (table.size === 0) return undefined;
    for (let at = absPosix.indexOf(NM); at !== -1; at = absPosix.indexOf(NM, at + 1)) {
      const name = packageNameAt(absPosix, at + NM.length);
      if (name === undefined) continue;
      const key = absPosix.slice(0, at + NM.length + name.length);
      const member = table.get(key);
      if (member === undefined) continue;
      used.add(name);
      return member + absPosix.slice(key.length);
    }
    return undefined;
  };
  const through = (p: string): string => translate(toPosix(p)) ?? p;

  const resolutionHost: ts.ModuleResolutionHost = {
    fileExists: (f) => ts.sys.fileExists(through(f)),
    readFile: (f) => ts.sys.readFile(through(f)),
    directoryExists: (d) => ts.sys.directoryExists(through(d)) || isSyntheticDir(toPosix(d)),
    getDirectories: (d) => ts.sys.getDirectories(through(d)),
    realpath: (f) => realpathOf(through(f)),
    getCurrentDirectory: () => root,
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  };

  return {
    translate,
    isSyntheticDir,
    used: () => [...used].sort(),
    count: () => links().size,
    memberNames: () => current().members,
    resolutionHost: (options) => (options.preserveSymlinks === true ? ts.sys : resolutionHost),
    refresh() {
      table = undefined;
      used.clear();
      generation++;
    },
    generation: () => generation,
  };
}

/** A changed path that can alter the link map: any `package.json` or the pnpm workspace manifest. */
export function changesWorkspaceLinks(rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  return base === 'package.json' || base === 'pnpm-workspace.yaml';
}

/** `sys.realpath` that never throws (a dangling path realpaths to itself, as in the LS host). */
export function realpathOf(p: string): string {
  try {
    return ts.sys.realpath ? ts.sys.realpath(p) : p;
  } catch {
    return p;
  }
}

/** The package name starting at `from` (`name` or `@scope/name`), or `undefined` when empty. */
function packageNameAt(p: string, from: number): string | undefined {
  const first = p.indexOf('/', from);
  const seg1 = p.slice(from, first === -1 ? undefined : first);
  if (seg1.length === 0) return undefined;
  if (!seg1.startsWith('@')) return seg1;
  if (first === -1) return undefined;
  const second = p.indexOf('/', first + 1);
  const seg2 = p.slice(first + 1, second === -1 ? undefined : second);
  return seg2.length > 0 ? `${seg1}/${seg2}` : undefined;
}

interface PackageJson {
  name: string | undefined;
  version: string | undefined;
  /** Every spec the manifest gives a dependency name, across the dependency fields. */
  deps: Map<string, string[]>;
}

function readPackageJson(file: string): PackageJson | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const deps = new Map<string, string[]>();
  for (const field of DEP_FIELDS) {
    const block = record[field];
    if (typeof block !== 'object' || block === null) continue;
    for (const [name, spec] of Object.entries(block)) {
      if (typeof spec === 'string') deps.set(name, [...(deps.get(name) ?? []), spec]);
    }
  }
  return {
    name: typeof record.name === 'string' ? record.name : undefined,
    version: typeof record.version === 'string' ? record.version : undefined,
    deps,
  };
}

function existsOnDisk(p: string): boolean {
  try {
    lstatSync(p); // a dangling symlink is still the install's own entry — never shadow it
    return true;
  } catch {
    return false;
  }
}

interface Member {
  abs: string;
  version: string | undefined;
}

/** Would the manager link THIS member for THIS spec? Only where the answer is certain without a
 *  semver solver: `workspace:` with `*`/`^`/`~` or a range the member's own version trivially
 *  satisfies (`<v>`, `^<v>`, `~<v>`) — any other range may fail the install; under npm/yarn-classic
 *  `workspaces` a `*` or the member's exact version. A `workspace:foo@*` alias names ANOTHER member
 *  and `workspace:../x` is a path, so neither links. What is not certain stays unresolved (floored). */
function linksLocally(spec: string, member: Member, pnpm: boolean): boolean {
  const own = member.version;
  if (spec.startsWith('workspace:')) {
    const range = spec.slice('workspace:'.length);
    if (range === '*' || range === '^' || range === '~') return true;
    return own !== undefined && (range === own || range === `^${own}` || range === `~${own}`);
  }
  if (pnpm) return false;
  return spec === '*' || (own !== undefined && spec === own);
}

/** A real `node_modules/<name>` at the consumer or any ancestor up to the root: an install is
 *  present and resolution through it is the install's, never ours to shadow. */
function installedAbove(rootPosix: string, consumerAbs: string, name: string): boolean {
  for (let dir = consumerAbs; ; dir = path.posix.dirname(dir)) {
    if (existsOnDisk(`${dir}/node_modules/${name}`)) return true;
    if (dir === rootPosix || !dir.startsWith(`${rootPosix}/`)) return false;
  }
}

interface LinkTable {
  /** abs posix link dir → abs posix member dir */
  links: Map<string, string>;
  /** Synthetic ancestors of the links (`…/node_modules`, `…/node_modules/@scope`). */
  dirs: Set<string>;
  members: Set<string>;
}

function buildLinks(rootPosix: string, repoFiles: readonly string[]): LinkTable {
  const out = new Map<string, string>();
  const dirs = new Set<string>();
  const manifest = readWorkspaceManifest(rootPosix);
  if (manifest === undefined) return { links: out, dirs, members: new Set() };
  const memberDirs = repoFiles
    .filter((rel) => rel === 'package.json' || rel.endsWith('/package.json'))
    .map((rel) => path.posix.dirname(rel))
    .filter((dir) => dir !== '.' && matchesAnyGlob(dir, manifest.members))
    .filter((dir) => manifest.negative.length === 0 || !matchesAnyGlob(dir, manifest.negative));
  const byName = new Map<string, Member | null>(); // null = a name two members share
  const manifests = new Map<string, PackageJson>();
  for (const dir of memberDirs) {
    const pkg = readPackageJson(`${rootPosix}/${dir}/package.json`);
    if (pkg === undefined) continue;
    manifests.set(dir, pkg);
    if (pkg.name === undefined) continue;
    byName.set(
      pkg.name,
      byName.has(pkg.name) ? null : { abs: `${rootPosix}/${dir}`, version: pkg.version },
    );
  }
  const rootPkg = readPackageJson(`${rootPosix}/package.json`);
  if (rootPkg !== undefined) {
    manifests.set('.', rootPkg);
    // pnpm counts the root as a workspace package (npm/yarn `workspaces` do not).
    if (manifest.pnpm && rootPkg.name !== undefined) {
      byName.set(
        rootPkg.name,
        byName.has(rootPkg.name) ? null : { abs: rootPosix, version: rootPkg.version },
      );
    }
  }
  for (const [dir, pkg] of manifests) {
    const consumerAbs = dir === '.' ? rootPosix : `${rootPosix}/${dir}`;
    for (const [name, specs] of pkg.deps) {
      const member = byName.get(name);
      if (member === undefined || member === null || member.abs === consumerAbs) continue;
      // Every field naming it must link locally: which field the manager honours on a conflict is
      // its own precedence, not ours to guess.
      if (!specs.every((spec) => linksLocally(spec, member, manifest.pnpm))) continue;
      if (installedAbove(rootPosix, consumerAbs, name)) continue;
      out.set(`${consumerAbs}/node_modules/${name}`, member.abs);
      dirs.add(`${consumerAbs}/node_modules`);
      if (name.startsWith('@')) dirs.add(`${consumerAbs}/node_modules/${name.split('/')[0]}`);
    }
  }
  return { links: out, dirs, members: new Set(byName.keys()) };
}
