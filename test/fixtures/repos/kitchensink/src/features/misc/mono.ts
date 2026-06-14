// trap T12 (large monolithic file with deeply-nested local helpers + local types + closures,
// and an EXTRACT ANCHOR that captures outer-scope types/vars). Stresses extract_symbol scope
// analysis (port Stage G): the extracted symbol's outer-scope type/closure deps must move or
// import correctly, never silently break. Mined from a real repo (10k-line files, 80+
// symbols); this is a representative ~250-line condensation. Also calls the high-fan-in
// formatLabel (T2) and instantiates Registry (T3).
import { formatLabel } from '@/core/format.ts';
import { Registry } from '@/core/registry.ts';
import type { Status } from '@/core/status.ts';

// ---- local types (must travel with an extracted helper that references them) ----------
interface Node {
  id: string;
  weight: number;
  children: Node[];
}

interface Accumulator {
  total: number;
  seen: Set<string>;
}

type Visitor = (node: Node, depth: number) => void;
type Reducer<T> = (acc: T, node: Node) => T;

// ---- outer-scope constants the EXTRACT ANCHOR captures (closure capture) --------------
const ROOT_WEIGHT = 100;
const registry = new Registry<Node>('mono-nodes'); // T3 instantiation

function makeNode(id: string, weight: number): Node {
  return { id, weight, children: [] };
}

function attach(parent: Node, child: Node): Node {
  parent.children.push(child);
  registry.register(child.id, child);
  return parent;
}

// ---- a deeply nested helper that captures ROOT_WEIGHT + the local `Node`/`Accumulator`
// types: THE EXTRACT ANCHOR. Extracting `summarize` must carry ROOT_WEIGHT (or import it)
// and the `Node`/`Accumulator` types, or it silently breaks. -----------------------------
export function buildReport(roots: readonly Node[]): string {
  const acc: Accumulator = { total: 0, seen: new Set() };

  // nested closure capturing outer `acc` + `ROOT_WEIGHT` (the extract target).
  function summarize(node: Node, depth: number): void {
    if (acc.seen.has(node.id)) return;
    acc.seen.add(node.id);
    acc.total += node.weight + (depth === 0 ? ROOT_WEIGHT : 0);
    for (const child of node.children) summarize(child, depth + 1);
  }

  for (const root of roots) summarize(root, 0);
  return formatLabel(`nodes=${acc.seen.size} total=${acc.total}`);
}

// ---- a pile of distinct local helpers (density — the "many symbols in one file" shape) --
function walk(node: Node, visit: Visitor, depth = 0): void {
  visit(node, depth);
  for (const child of node.children) walk(child, visit, depth + 1);
}

function reduceTree<T>(node: Node, seed: T, reduce: Reducer<T>): T {
  let acc = reduce(seed, node);
  for (const child of node.children) acc = reduceTree(child, acc, reduce);
  return acc;
}

function depthOf(node: Node): number {
  if (node.children.length === 0) return 1;
  return 1 + Math.max(...node.children.map(depthOf));
}

function countNodes(node: Node): number {
  return reduceTree(node, 0, (n) => n + 1);
}

function sumWeights(node: Node): number {
  return reduceTree(node, 0, (n, x) => n + x.weight);
}

function heaviest(node: Node): Node {
  return reduceTree(node, node, (best, x) => (x.weight > best.weight ? x : best));
}

function flatten(node: Node): Node[] {
  const out: Node[] = [];
  walk(node, (n) => out.push(n));
  return out;
}

function findById(node: Node, id: string): Node | undefined {
  return flatten(node).find((n) => n.id === id);
}

function pathTo(node: Node, id: string, trail: string[] = []): string[] | undefined {
  const next = [...trail, node.id];
  if (node.id === id) return next;
  for (const child of node.children) {
    const found = pathTo(child, id, next);
    if (found !== undefined) return found;
  }
  return undefined;
}

function prune(node: Node, predicate: (n: Node) => boolean): Node {
  return {
    ...node,
    children: node.children.filter(predicate).map((c) => prune(c, predicate)),
  };
}

function relabel(node: Node, fn: (id: string) => string): Node {
  return { ...node, id: fn(node.id), children: node.children.map((c) => relabel(c, fn)) };
}

function statusOf(node: Node): Status {
  if (node.weight === 0) return 'idle';
  if (node.weight < 10) return 'loading';
  if (node.weight < 100) return 'ready';
  return 'error';
}

// ---- a public builder that ties the helpers together (entry point) ----------------------
export function demoTree(): Node {
  const root = makeNode('root', ROOT_WEIGHT);
  const a = makeNode('a', 5);
  const b = makeNode('b', 50);
  const c = makeNode('c', 0);
  attach(root, a);
  attach(root, b);
  attach(b, c);
  return root;
}

export function analyze(root: Node): {
  count: number;
  depth: number;
  weight: number;
  top: string;
  status: Status;
  report: string;
} {
  return {
    count: countNodes(root),
    depth: depthOf(root),
    weight: sumWeights(root),
    top: heaviest(root).id,
    status: statusOf(root),
    report: buildReport([root]),
  };
}

export function locate(root: Node, id: string): { node?: Node; path?: string[] } {
  return { node: findById(root, id), path: pathTo(root, id) };
}

export function transform(root: Node): Node {
  const pruned = prune(root, (n) => n.weight >= 0);
  return relabel(pruned, (id) => id.toUpperCase());
}
