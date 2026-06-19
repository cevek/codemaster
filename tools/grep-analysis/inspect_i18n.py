import json, re
from collections import Counter

rows = [json.loads(l) for l in open("classified.jsonl")]
i18n = [r for r in rows if r["category"] == "I18N"]
print("I18N total:", len(i18n))

fn = Counter()
for r in i18n:
    s = " ".join([r.get("command") or "", r.get("path") or "", r.get("glob") or ""])
    for m in re.findall(r"[\w./*-]*\.json", s):
        fn[m.split("/")[-1]] += 1
print("json filenames seen in I18N:", fn.most_common(25))


def disp(r):
    if r["tool"] == "Bash":
        return r["command"].replace("\n", " ")[:170]
    return f"[Grep] pat={r.get('pattern')!r} glob={r.get('glob')!r} path={r.get('path')!r}"


print("\n--- 20 samples ---")
for r in i18n[:20]:
    print(disp(r))
