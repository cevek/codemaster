#!/usr/bin/env node
// Backlog validator — each rule guards ONE way the backlog starts lying.
//
// errors exit 1 (a structural falsehood: work invisible to the queue, a reference
// to nothing). Heuristics warn and exit 0 — a guard people learn to silence is dead.
// Every finding names a runnable next step, not a diagnosis (ops/guard/navigate.ts).

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TASKS_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'tasks');
const STRONG_EVIDENCE = ['measured', 'repro'];

// A body carrying a proof shows one of these. Printed with every hit so a false
// positive is recognizable rather than mysterious. Tuned on live data: this set
// flags 22 of 227 strong-evidence tasks; dropping the source-path or the number
// term pushes it past 70, most of them bodies that DO cite a location — noise the
// rule would be silenced for.
const PROOF_PATTERNS = [
  { what: 'a source path', re: /[\w/-]+\.(ts|tsx|mts|mjs|json|md|scss|yml)\b/ },
  { what: 'a :line reference', re: /:\d+/ },
  { what: 'a number (a count / an observed value)', re: /\d/ },
  { what: 'a runnable command', re: /(node src\/bin\.ts|npm run |npx |tm |git |codemaster )/ },
];

const DUP_JACCARD = 0.5; // tuned live: 0.5 → 1 pair (a real duplicate); 0.35 → 8 (mostly same-class siblings)
const DUP_CONTAINMENT = 0.9;
const STOPWORDS = new Set(
  `the a an is are of to in on for and or not it its with by as at from that this be no never
   only same one two but so what which when where how than then via per each all any`.split(/\s+/),
);

function tmList(query) {
  try {
    const raw = execFileSync('tm', ['--json', 'list', query], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) throw new Error('tm --json did not return an array');
    return rows.map((r) => r.task).filter(Boolean);
  } catch (err) {
    throw new Error(`tm failed — cannot read the backlog: ${err.message}`);
  }
}

/** Task bodies are not on the JSON surface — read them from the files, which ARE the truth. */
function loadBodies() {
  const bodies = new Map();
  let files;
  try {
    files = readdirSync(TASKS_DIR).filter((f) => f.endsWith('.md'));
  } catch (err) {
    throw new Error(`cannot read ${TASKS_DIR}: ${err.message}`);
  }
  for (const f of files) {
    let src;
    try {
      src = readFileSync(join(TASKS_DIR, f), 'utf8');
    } catch {
      continue; // a file that vanished mid-run is not a backlog defect
    }
    const id = (src.match(/^id:\s*(\S+)/m) ?? [])[1];
    if (!id) continue;
    const m = src.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    bodies.set(id, m ? m[1] : '');
  }
  return bodies;
}

const titleTokens = (title) =>
  new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );

// ── rules ────────────────────────────────────────────────────────────────────

function ruleInvisible(open, add) {
  for (const t of open) {
    const missing = ['type', 'complexity', 'evidence'].filter((k) => !t.fields?.[k]);
    if (missing.length)
      add(
        'error',
        t.id,
        `no ${missing.join('/')} — invisible to the queue at ANY priority; tm update_task ${t.id} ${missing.map((k) => `${k}=…`).join(' ')}`,
      );
  }
}

function ruleEpics(open, add) {
  for (const t of open) {
    const kids = t.children?.length ?? 0;
    const tagged = t.tags?.includes('epic');
    if (tagged && kids === 0)
      add(
        'error',
        t.id,
        `tag:epic with no children — either the work is not filed, or it is not an axis; create the subtasks or drop the tag`,
      );
    if (!tagged && kids > 0)
      add(
        'warn',
        t.id,
        `has ${kids} children but no tag:epic — the structural gate drops it from the queue silently; tm update_task ${t.id} tags+=epic`,
      );
  }
}

function ruleDeps(open, byId, add, info) {
  let satisfied = 0;
  for (const t of open) {
    for (const d of t.depends_on ?? []) {
      const dep = byId.get(d);
      if (!dep)
        add(
          'error',
          t.id,
          `depends_on ${d} — no such task (deleted?); tm remove_dependency ${t.id} ${d}`,
        );
      else if (dep.status === 'done' || dep.status === 'rejected') satisfied++;
    }
  }
  if (satisfied)
    info(
      `${satisfied} depends_on edge(s) point at completed tasks — satisfied history, not a blockage (not reported per-task)`,
    );
}

function ruleRefs(open, byId, add) {
  for (const t of open) {
    for (const r of t.fields?.relates ?? [])
      if (!byId.get(r))
        add('error', t.id, `relates → ${r}, no such task; drop the ref or repoint it`);
    if (t.parent && !byId.get(t.parent))
      add('error', t.id, `parent → ${t.parent}, no such task; reparent it or clear the field`);
  }
}

function ruleProof(open, bodies, add) {
  for (const t of open) {
    if (!STRONG_EVIDENCE.includes(t.fields?.evidence)) continue;
    const body = bodies.get(t.id) ?? '';
    if (PROOF_PATTERNS.some((p) => p.re.test(body))) continue;
    add(
      'warn',
      t.id,
      `evidence:${t.fields.evidence} but the body shows none of [${PROOF_PATTERNS.map((p) => p.what).join(' | ')}] — add the proof, or downgrade to reported`,
    );
  }
}

function ruleDuplicates(open, add) {
  const toks = open.map((t) => ({ id: t.id, title: t.title, w: titleTokens(t.title) }));
  const pairs = [];
  for (let i = 0; i < toks.length; i++) {
    for (let j = i + 1; j < toks.length; j++) {
      const a = toks[i];
      const b = toks[j];
      if (a.w.size < 3 || b.w.size < 3) continue;
      let inter = 0;
      for (const w of a.w) if (b.w.has(w)) inter++;
      if (!inter) continue;
      const jac = inter / (a.w.size + b.w.size - inter);
      const cont = inter / Math.min(a.w.size, b.w.size);
      if (jac >= DUP_JACCARD || cont >= DUP_CONTAINMENT) pairs.push({ a, b, jac, cont });
    }
  }
  for (const p of pairs)
    add(
      'warn',
      `${p.a.id}+${p.b.id}`,
      `title overlap ${p.jac.toFixed(2)} (containment ${p.cont.toFixed(2)}) — check by eye, may be one capability filed twice: "${p.a.title.slice(0, 60)}" vs "${p.b.title.slice(0, 60)}"`,
    );
}

// ── driver ───────────────────────────────────────────────────────────────────

const RULES = [
  ['invisible-to-queue', (ctx, add) => ruleInvisible(ctx.open, add)],
  ['epic-structure', (ctx, add) => ruleEpics(ctx.open, add)],
  ['dead-dependency', (ctx, add, info) => ruleDeps(ctx.open, ctx.byId, add, info)],
  ['broken-reference', (ctx, add) => ruleRefs(ctx.open, ctx.byId, add)],
  ['evidence-without-proof', (ctx, add) => ruleProof(ctx.open, ctx.bodies, add)],
  ['duplicate-candidate', (ctx, add) => ruleDuplicates(ctx.open, add)],
];

const LEVEL_RANK = { error: 0, warn: 1 };

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write('usage: node scripts/backlog-lint.mjs [--json]\n');
    return;
  }
  const asJson = argv.includes('--json');

  const open = tmList('-status:done -status:rejected');
  const byId = new Map(tmList('').map((t) => [t.id, t]));
  const ctx = { open, byId, bodies: loadBodies() };

  const findings = [];
  const infos = [];
  const info = (msg) => infos.push(msg);
  for (const [rule, fn] of RULES) {
    const add = (level, id, message) => findings.push({ rule, level, id, message });
    fn(ctx, add, info);
  }
  // deterministic: same input → same output, whatever order the rules ran in
  findings.sort(
    (a, b) =>
      LEVEL_RANK[a.level] - LEVEL_RANK[b.level] ||
      (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const errors = findings.filter((f) => f.level === 'error');
  const warns = findings.filter((f) => f.level === 'warn');

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        { checked: open.length, rules: RULES.map(([r]) => r), errors, warns, infos },
        null,
        2,
      ) + '\n',
    );
  } else {
    const out = [
      `${open.length} open task(s) · ${RULES.length} rules · ${errors.length} error(s), ${warns.length} warning(s)`,
    ];
    for (const i of infos) out.push(`   ${i}`);
    if (findings.length) out.push('');
    for (const f of findings)
      out.push(`${f.level === 'error' ? 'ERR ' : 'warn'} [${f.rule}] ${f.id}: ${f.message}`);
    if (!findings.length) out.push('clean.');
    process.stdout.write(out.join('\n') + '\n');
  }
  process.exitCode = errors.length ? 1 : 0;
}

try {
  main();
} catch (err) {
  process.stderr.write(`backlog-lint: ${err.message}\n`);
  process.exitCode = 1;
}
