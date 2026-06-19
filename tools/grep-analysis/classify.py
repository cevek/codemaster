#!/usr/bin/env python3
"""
Classify the search commands extracted by extract_commands.py.

Goal: separate VALID greps (text search, command-output filtering, non-code files —
grep is the right tool, codemaster can't do better) from REPLACEABLE greps (symbol /
usages / i18n / scss / schema lookups codemaster answers with proof spans), and tie
each replaceable bucket to the specific codemaster op.

Design (per advisor):
  - Bias to VALID. Anything genuinely undecidable goes to AMBIGUOUS, never forced.
  - The discriminator inside code files is PATTERN SHAPE, not file extension:
    an identifier (or a `|`/`\\|`-alternation of identifiers, optionally \\b-bounded)
    is a symbol lookup; anything with anchors/char-classes/quantifiers/dots/spaces
    is literal-or-structural text search -> VALID.
  - Unit of classification = the FIRST grep that reads from FILES (not stdin).
    If every grep in the command reads stdin -> PIPE_FILTER (valid).

Reads:  commands.jsonl
Writes: classified.jsonl  (+ samples/<BUCKET>.txt for hand-validation)
Prints: per-bucket distribution + verdict rollup.
"""

import json
import os
import re
import shlex
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
IN = os.path.join(HERE, "commands.jsonl")
OUT = os.path.join(HERE, "classified.jsonl")
SAMPLE_DIR = os.path.join(HERE, "samples")

GREP_PROGS = {"grep", "egrep", "fgrep", "rg", "ripgrep", "ag", "ack", "ugrep"}

# A bare identifier (TS symbol / hook / component / type name).
IDENT_RE = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")

# TS/JS keywords & operators: lexically identifiers, but NOT symbols — `find_usages`
# of `satisfies`/`typeof` is meaningless (usually a code-metric grep `... | wc -l`).
TS_KEYWORDS = frozenset({
    "satisfies", "keyof", "typeof", "readonly", "extends", "infer", "as", "const",
    "let", "var", "function", "return", "import", "export", "default", "async",
    "await", "yield", "class", "interface", "type", "enum", "namespace", "declare",
    "public", "private", "protected", "static", "abstract", "implements", "new",
    "this", "super", "void", "null", "undefined", "true", "false", "instanceof",
    "in", "of", "for", "while", "if", "else", "switch", "case", "break", "continue",
    "throw", "try", "catch", "finally", "delete", "any", "unknown", "never", "string",
    "number", "boolean", "object", "symbol", "bigint",
})

# ---- domain detection on a target string (file / dir / glob / --include) ----
_JS_CONFIG_RE = re.compile(
    r"(\.config\.(js|mjs|cjs)\b)"
    r"|((^|/)(webpack|eslint|orval|vite|rollup|babel|jest|prettier|tailwind|postcss|"
    r"commitlint|stylelint|metro|next|nuxt)[\w.-]*\.(js|mjs|cjs)\b)"
)


def domain_of_target(t: str) -> str | None:
    tl = t.lower()
    if "locales" in tl or re.search(r"i18n", tl):
        return "I18N"
    # build/tool config in JS: not in tsconfig, so codemaster's TS plugin won't index it
    if _JS_CONFIG_RE.search(tl):
        return "NON_CODE"
    if tl.endswith((".scss", ".css")) or re.search(r"\.s?css\b", tl):
        return "SCSS"
    if "schema.d.ts" in tl or re.search(r"\bschema\b", tl):
        return "SCHEMA"
    if (
        "/tmp/" in tl
        or "node_modules" in tl
        or "dist/" in tl
        or "build/" in tl
        or tl.endswith((".log", ".txt", ".md", ".diff", ".patch", ".yaml", ".yml",
                        ".env", ".sh", ".html", ".lock"))
        or re.search(r"\.(log|txt|md|diff|patch|yaml|yml|env|sh|html|lock)\b", tl)
        # non-TS source languages: codemaster is TS/React-only, so grep is the right tool
        or re.search(r"\.(java|kt|py|go|rb|php|cs|rs|c|cc|cpp|h|hpp|swift|scala|sql)\b", tl)
    ):
        return "NON_CODE"
    if tl.endswith((".ts", ".tsx", ".js", ".jsx", ".mts", ".cts")) or \
       re.search(r"\.(ts|tsx|js|jsx)\b", tl) or re.search(r"(^|/)src(/|$)", tl):
        return "CODE"
    if tl.endswith(".json") or re.search(r"\.json\b", tl):
        # plain json that is not locales -> config/data, treat as non-code text
        return "NON_CODE"
    return None


def looks_like_identifier_pattern(pat: str) -> bool:
    """True if pat is an identifier or an alternation of identifiers (a symbol search)."""
    if not pat:
        return False
    p = pat.strip()
    # strip surrounding quotes already handled by shlex; strip leading/trailing word anchors
    p = re.sub(r"^\\b", "", p)
    p = re.sub(r"\\b$", "", p)
    # split on regex alternation in both BRE (\|) and ERE (|) forms
    alts = re.split(r"\\\||\|", p)
    if not alts:
        return False
    all_keywords = True
    for a in alts:
        a = a.strip()
        a = re.sub(r"^\\b", "", a)
        a = re.sub(r"\\b$", "", a)
        if not IDENT_RE.match(a):
            return False
        if a not in TS_KEYWORDS:
            all_keywords = False
    # a pattern made up ONLY of bare keywords is a code-metric/text grep, not a symbol lookup
    return not all_keywords


_TOKEN_RE = re.compile(r"""'[^']*'|"[^"]*"|\S+""")


def tokenize(seg: str) -> list[str]:
    """Split a shell segment into tokens, treating a quoted run as one atomic token
    and backslash as a literal char (grep BRE patterns are full of \\|, \\., \\b —
    shlex would wrongly eat the backslash as an escape)."""
    return [m.group(0) for m in _TOKEN_RE.finditer(seg)]


def strip_quotes(tok: str) -> str:
    if len(tok) >= 2 and tok[0] == tok[-1] and tok[0] in ("'", '"', "`"):
        return tok[1:-1]
    return tok


def parse_grep_segment(seg_tokens: list[str]):
    """From tokens of one grep invocation, return (pattern, targets, flags_str, recursive, includes, files_only).

    Tokens come from shlex posix=False, so quotes are still attached and backslashes
    (BRE \\|, \\., \\b) are preserved verbatim — we strip the surrounding quotes ourselves.
    """
    flags = []
    positionals = []
    includes = []
    pattern = None
    recursive = False
    files_only = False
    i = 1  # skip prog
    expect_pattern_flag = False
    while i < len(seg_tokens):
        tok = seg_tokens[i]
        if expect_pattern_flag:
            pattern = strip_quotes(tok)
            expect_pattern_flag = False
            i += 1
            continue
        if tok.startswith("--include") or tok.startswith("--exclude"):
            if tok.startswith("--include"):
                if "=" in tok:
                    includes.append(strip_quotes(tok.split("=", 1)[1]))
                elif i + 1 < len(seg_tokens):
                    includes.append(strip_quotes(seg_tokens[i + 1]))
                    i += 1
            i += 1
            continue
        if tok in ("-e", "--regexp"):
            expect_pattern_flag = True
            i += 1
            continue
        if tok.startswith("-") and tok != "-":
            flags.append(tok)
            if re.search(r"[rR]", tok):
                recursive = True
            if "l" in tok.lstrip("-"):
                files_only = True
            i += 1
            continue
        positionals.append(strip_quotes(tok))
        i += 1
    if pattern is None and positionals:
        pattern = positionals.pop(0)
    targets = positionals
    return pattern, targets, " ".join(flags), recursive, includes, files_only


def split_pipelines(cmd: str):
    """Yield (segment_text, is_pipeline_leader) splitting on shell operators
    (| && || ; > >> <) but ONLY outside quotes — a `|` inside a grep BRE pattern
    ("a\\|b") is part of the pattern, not a pipe. is_pipeline_leader is False only
    when the segment is fed by a real `|` pipe (i.e. it reads stdin)."""
    segs: list[tuple[str, bool]] = []
    cur: list[str] = []
    q: str | None = None
    preceded_by_pipe = False
    i, n = 0, len(cmd)

    def flush(next_is_piped: bool):
        nonlocal cur, preceded_by_pipe
        segs.append(("".join(cur).strip(), not preceded_by_pipe))
        cur = []
        preceded_by_pipe = next_is_piped

    while i < n:
        ch = cmd[i]
        if q:
            cur.append(ch)
            if ch == q:
                q = None
            i += 1
            continue
        if ch in ("'", '"', "`"):
            q = ch
            cur.append(ch)
            i += 1
            continue
        two = cmd[i:i + 2]
        if two in ("&&", "||", ">>"):
            flush(False)
            i += 2
            continue
        if ch in (";", ">", "<"):
            flush(False)
            i += 1
            continue
        if ch == "|":
            flush(True)  # the NEXT segment is fed by this pipe
            i += 1
            continue
        cur.append(ch)
        i += 1
    flush(False)
    for text, is_leader in segs:
        if text:
            yield text, is_leader


def primary_grep(cmd: str):
    """Return the first grep invocation that reads from FILES, as a parsed dict; else None."""
    first_any = None
    for seg, is_leader in split_pipelines(cmd):
        if not seg:
            continue
        toks = tokenize(seg)
        if not toks:
            continue
        prog = os.path.basename(toks[0])
        if prog not in GREP_PROGS:
            continue
        pattern, targets, flags, recursive, includes, files_only = parse_grep_segment(toks)
        reads_files = recursive or (is_leader and bool(targets)) or bool(includes)
        info = {
            "prog": prog, "pattern": pattern, "targets": targets, "flags": flags,
            "recursive": recursive, "includes": includes, "files_only": files_only,
            "reads_files": reads_files, "is_leader": is_leader,
        }
        if first_any is None:
            first_any = info
        if reads_files:
            return info
    return None  # no file-reading grep


FIND_SEARCH_RE = re.compile(r"(?<![\w./-])find\b.*\s-(name|iname|path|ipath|regex|iregex)\b")


def classify_bash(cmd: str):
    g = primary_grep(cmd)
    if g is None:
        # no file-reading grep: either pure file discovery (find -name) or grep over a pipe
        if FIND_SEARCH_RE.search(cmd):
            return "FILE_FIND", "valid", None
        return "PIPE_FILTER", "valid", None
    targets = list(g["targets"]) + list(g["includes"])
    domains = [d for d in (domain_of_target(t) for t in targets) if d]
    # pick the most specific domain present
    domain = None
    for pref in ("I18N", "SCSS", "SCHEMA", "CODE", "NON_CODE"):
        if pref in domains:
            domain = pref
            break
    ident = looks_like_identifier_pattern(g["pattern"] or "")

    if domain == "I18N":
        return "I18N", "replaceable", "find_unused_i18n_keys / i18n_lookup"
    if domain == "SCSS":
        return "SCSS", "replaceable", "find_unused_scss_classes"
    if domain == "SCHEMA":
        return "SCHEMA", "replaceable", "list_endpoints / search_symbol"
    if domain == "NON_CODE":
        return "NON_CODE", "valid", None
    if domain == "CODE":
        if ident:
            op = "find_usages / importers_of" if g["files_only"] else "search_symbol / find_usages"
            return "CODE_SYMBOL", "replaceable", op
        return "CODE_TEXT", "valid", None
    # No domain resolved (e.g. recursive grep over cwd, no path/ext given)
    if g["recursive"] or g["includes"]:
        if ident:
            # very likely a symbol-usage sweep in a TS repo, but target unproven
            return "AMBIGUOUS_SYMBOL", "ambiguous", "search_symbol / find_usages (verify repo is TS)"
        return "AMBIGUOUS_TEXT", "ambiguous", None
    return "AMBIGUOUS", "ambiguous", None


def classify_grep_tool(rec):
    glob = rec.get("glob") or ""
    path = rec.get("path") or ""
    pat = rec.get("pattern") or ""
    domain = domain_of_target(glob) or domain_of_target(path) or "CODE"  # Grep tool defaults to repo files
    ident = looks_like_identifier_pattern(pat)
    if domain == "I18N":
        return "I18N", "replaceable", "find_unused_i18n_keys / i18n_lookup"
    if domain == "SCSS":
        return "SCSS", "replaceable", "find_unused_scss_classes"
    if domain == "SCHEMA":
        return "SCHEMA", "replaceable", "list_endpoints / search_symbol"
    if domain == "NON_CODE":
        return "NON_CODE", "valid", None
    # CODE
    if ident:
        op = "find_usages / importers_of" if rec.get("output_mode") == "files_with_matches" else "search_symbol / find_usages"
        return "CODE_SYMBOL", "replaceable", op
    return "CODE_TEXT", "valid", None


def main():
    os.makedirs(SAMPLE_DIR, exist_ok=True)
    bucket = Counter()
    verdict = Counter()
    op_counter = Counter()
    samples = defaultdict(list)

    with open(IN, encoding="utf-8") as fin, open(OUT, "w", encoding="utf-8") as fout:
        for line in fin:
            o = json.loads(line)
            tool = o.get("tool")
            if tool == "Bash":
                if not o.get("is_search"):
                    continue
                cat, verd, op = classify_bash(o.get("command", ""))
                display = o["command"].replace("\n", " ")
            elif tool == "Grep":
                cat, verd, op = classify_grep_tool(o)
                display = f"[Grep] pattern={o.get('pattern')!r} glob={o.get('glob')!r} path={o.get('path')!r} mode={o.get('output_mode')!r}"
            elif tool == "Glob":
                cat, verd, op = "FILE_FIND", "valid", None
                display = f"[Glob] pattern={o.get('pattern')!r} path={o.get('path')!r}"
            else:
                continue

            o["category"] = cat
            o["verdict"] = verd
            o["suggested_op"] = op
            fout.write(json.dumps(o, ensure_ascii=False) + "\n")

            bucket[cat] += 1
            verdict[verd] += 1
            if op:
                op_counter[op] += 1
            if len(samples[cat]) < 25:
                samples[cat].append(display[:200])

    # write per-bucket samples for hand validation
    for cat, lines in samples.items():
        with open(os.path.join(SAMPLE_DIR, f"{cat}.txt"), "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")

    total = sum(bucket.values())
    print(f"classified search records: {total}  -> {OUT}\n")
    print("VERDICT rollup:")
    for v, n in verdict.most_common():
        print(f"  {n:7d}  ({n*100//max(total,1):2d}%)  {v}")
    print("\nBUCKET distribution:")
    for c, n in bucket.most_common():
        print(f"  {n:7d}  ({n*100//max(total,1):2d}%)  {c}")
    print("\nSuggested-op tally (replaceable):")
    for op, n in op_counter.most_common():
        print(f"  {n:7d}  {op}")
    print(f"\nsamples per bucket -> {SAMPLE_DIR}/<BUCKET>.txt")


if __name__ == "__main__":
    main()
