# -*- coding: utf-8 -*-
import json
import re

with open("gemini.google.com.har", "r", encoding="utf-8") as f:
    har = json.load(f)

for i, e in enumerate(har["log"]["entries"]):
    r = (e["response"].get("content") or {}).get("text") or ""
    if "thinking-level-toggle" not in r:
        continue
    print(f"=== Entry {i} len={len(r)} ===")

    # Extract larger template chunks around thinking-level
    for pat in [
        r"thinking-level-toggle.{0,800}",
        r"slideToggle.{0,500}",
        r"zR\(a\).{0,600}",
        r"aPi=class\{.{0,2500}",
        r"mat-slide-toggle.{0,300}",
        r"gem-slide-toggle.{0,300}",
        r"thinking-level-option.{0,400}",
        r"onSelect\(a\).{0,500}",
        r"thinkingLevelSelected.{0,300}",
        r"yR\(.{0,400}",
        r"HUd.{0,200}",
        r"強化版.{0,200}",
        r"\\u5f37\\u5316\\u7248.{0,300}",
    ]:
        for m in re.finditer(pat, r):
            print("---", pat[:40], "---")
            print(m.group().replace("\n", " ")[:700])
            print()
    break
