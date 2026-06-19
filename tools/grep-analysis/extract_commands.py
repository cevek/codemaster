#!/usr/bin/env python3
"""
Extract AI tool commands from all Claude transcripts.

Source files:  /Users/cody/.myclaude/projects/{projectId}/sessions/{sessionId}/transcript.jsonl

Pulls every assistant `tool_use` for the search-relevant tools:
  - Bash  -> the `command` string  (matches the trigger the user gave)
  - Grep  -> the dedicated Grep tool (pattern + path/glob/flags)
  - Glob  -> file globbing (often a grep precursor)

Each Bash command is classified as "search-like" when it shells out to a code
search tool (grep / rg / ag / ast-grep / find -name ...). This is the population
we care about for "when could codemaster replace grep?".

Outputs (into /Users/cody/grep-analysis/):
  - commands.jsonl   one JSON record per extracted tool_use, in transcript order
  - summary printed to stdout (counts, top tools, search-command breakdown)

Run:  python3 extract_commands.py
"""

import glob
import json
import os
import re
import sys
from collections import Counter

PROJECTS_ROOT = "/Users/cody/.myclaude/projects"
OUT_DIR = "/Users/cody/grep-analysis"
OUT_JSONL = os.path.join(OUT_DIR, "commands.jsonl")

# Tools we extract. Bash is the primary one (per the trigger spec); Grep/Glob are
# the dedicated search tools whose use is the same "instead of codemaster" signal.
EXTRACT_TOOLS = {"Bash", "Grep", "Glob"}

# A Bash command is "search-like" when its program is one of these (word-boundary,
# so `grepped` in a path doesn't match but `... | grep foo` does).
SEARCH_TOOLS_RE = re.compile(r"(?<![\w./-])(grep|egrep|fgrep|rg|ripgrep|ag|ack|ast-grep|sg|ugrep)(?![\w-])")
# `find ... -name/-path/-regex` is also a structural search worth counting.
FIND_SEARCH_RE = re.compile(r"(?<![\w./-])find\b.*\s-(name|iname|path|ipath|regex|iregex)\b")


def project_id_from_path(path: str) -> str:
    # .../projects/<projectId>/sessions/<sessionId>/transcript.jsonl
    parts = path.split(os.sep)
    try:
        i = parts.index("projects")
        return parts[i + 1]
    except (ValueError, IndexError):
        return "?"


def session_id_from_path(path: str) -> str:
    parts = path.split(os.sep)
    try:
        i = parts.index("sessions")
        return parts[i + 1]
    except (ValueError, IndexError):
        return "?"


def search_tools_in(cmd: str) -> list[str]:
    hits = sorted(set(m.group(1) for m in SEARCH_TOOLS_RE.finditer(cmd)))
    if FIND_SEARCH_RE.search(cmd):
        hits.append("find")
    return hits


def iter_tool_uses(path: str):
    """Yield (block, raw_obj) for every assistant tool_use block in a transcript."""
    try:
        fh = open(path, encoding="utf-8")
    except OSError:
        return
    with fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") != "assistant":
                continue
            msg = obj.get("message") or {}
            content = msg.get("content")
            if not isinstance(content, list):
                continue
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    yield block, obj, msg


def main() -> int:
    files = sorted(glob.glob(os.path.join(PROJECTS_ROOT, "*", "sessions", "*", "transcript.jsonl")))
    if not files:
        print(f"no transcripts found under {PROJECTS_ROOT}", file=sys.stderr)
        return 1

    tool_counts = Counter()
    extracted = 0
    bash_total = 0
    bash_search = 0
    search_tool_counts = Counter()
    first_token_counts = Counter()

    with open(OUT_JSONL, "w", encoding="utf-8") as out:
        for f in files:
            project = project_id_from_path(f)
            session = session_id_from_path(f)
            for block, obj, msg in iter_tool_uses(f):
                name = block.get("name")
                tool_counts[name] += 1
                if name not in EXTRACT_TOOLS:
                    continue
                inp = block.get("input") or {}
                rec = {
                    "project": project,
                    "session": session,
                    "uuid": obj.get("uuid"),
                    "ts": obj.get("_t"),
                    "model": msg.get("model"),
                    "tool": name,
                }
                if name == "Bash":
                    cmd = inp.get("command", "") or ""
                    rec["command"] = cmd
                    rec["description"] = inp.get("description")
                    bash_total += 1
                    hits = search_tools_in(cmd)
                    rec["is_search"] = bool(hits)
                    rec["search_tools"] = hits
                    if hits:
                        bash_search += 1
                        for h in hits:
                            search_tool_counts[h] += 1
                    m = re.match(r"\s*([A-Za-z0-9_./-]+)", cmd)
                    if m:
                        first_token_counts[m.group(1)] += 1
                elif name == "Grep":
                    rec["pattern"] = inp.get("pattern")
                    rec["path"] = inp.get("path")
                    rec["glob"] = inp.get("glob")
                    rec["output_mode"] = inp.get("output_mode")
                    rec["is_search"] = True
                    rec["search_tools"] = ["Grep"]
                    search_tool_counts["Grep"] += 1
                elif name == "Glob":
                    rec["pattern"] = inp.get("pattern")
                    rec["path"] = inp.get("path")
                    rec["is_search"] = True
                    rec["search_tools"] = ["Glob"]
                    search_tool_counts["Glob"] += 1
                out.write(json.dumps(rec, ensure_ascii=False) + "\n")
                extracted += 1

    # ---- summary ----
    print(f"transcripts scanned : {len(files)}")
    print(f"tool_use blocks      : {sum(tool_counts.values())}")
    print(f"extracted records    : {extracted}  -> {OUT_JSONL}")
    print()
    print("top tools overall:")
    for name, n in tool_counts.most_common(15):
        print(f"  {n:7d}  {name}")
    print()
    print(f"Bash commands        : {bash_total}")
    print(f"  search-like (grep/rg/ast-grep/find): {bash_search}  ({bash_search * 100 // max(bash_total,1)}%)")
    print()
    print("search-tool usage (Bash programs + Grep/Glob tools):")
    for name, n in search_tool_counts.most_common():
        print(f"  {n:7d}  {name}")
    print()
    print("top Bash first-tokens:")
    for name, n in first_token_counts.most_common(20):
        print(f"  {n:7d}  {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
