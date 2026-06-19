import json, random

random.seed(42)
rows = [json.loads(l) for l in open("classified.jsonl")]
repl = [r for r in rows if r["verdict"] == "replaceable"]
print("total replaceable:", len(repl))
pick = random.sample(repl, 20)
for i, r in enumerate(pick, 1):
    if r["tool"] == "Bash":
        disp = r["command"].replace("\n", " ")
    else:
        disp = f"[{r['tool']}] pat={r.get('pattern')!r} glob={r.get('glob')!r} path={r.get('path')!r} mode={r.get('output_mode')!r}"
    print(f"\n#{i} [{r['category']} -> {r['suggested_op']}]  ({r['project']})")
    print("   ", disp[:300])
