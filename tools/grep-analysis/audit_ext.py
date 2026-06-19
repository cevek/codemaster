import json, re
from collections import Counter

rows = [json.loads(l) for l in open("classified.jsonl")]
repl = [r for r in rows if r["verdict"] == "replaceable"]

# reconstruct the targets the classifier saw
import classify as C

ext = Counter()
no_ext_dir = 0
js_examples = []
for r in repl:
    targets = []
    if r["tool"] == "Bash":
        g = C.primary_grep(r["command"])
        if g:
            targets = list(g["targets"]) + list(g["includes"])
    else:
        targets = [t for t in [r.get("glob"), r.get("path")] if t]
    found_ext = False
    for t in targets:
        m = re.findall(r"\.(ts|tsx|js|jsx|mts|cts|scss|css|json|d\.ts)\b", t.lower())
        for e in m:
            ext[e] += 1
            found_ext = True
        if t.lower().endswith((".js", ".jsx")):
            if len(js_examples) < 12:
                js_examples.append((r["category"], (r.get("command") or r.get("path") or "")[:140]))
    if not found_ext and targets:
        no_ext_dir += 1
    if not targets:
        no_ext_dir += 1  # bare recursive grep over cwd, no explicit target

print("replaceable total:", len(repl))
print("target extensions in replaceable:", ext.most_common())
print("replaceable with NO file-extension target (dir/cwd only):", no_ext_dir)
print("\n.js/.jsx examples:")
for c, s in js_examples:
    print(f"  [{c}] {s}")
