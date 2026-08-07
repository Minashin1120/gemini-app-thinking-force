# -*- coding: utf-8 -*-
import json
import re

with open("gemini.google.com.har", "r", encoding="utf-8") as f:
    har = json.load(f)

for e in har["log"]["entries"]:
    r = (e["response"].get("content") or {}).get("text") or ""
    if "d.zR(c)" not in r:
        continue
    m = re.search(r"gLi=function\(a\)\{.{0,2500}", r)
    if m:
        print("=== gLi ===")
        print(m.group().replace("\n", " ")[:2500])
    # attrs array index 11 for mat-slide-toggle
    # Look for consts near thinking-level-toggle that define element attrs
    for m in re.finditer(
        r'\["data-test-id","thinking-level-toggle".{0,300}\]', r
    ):
        print("attrs:", m.group().replace("\n", " ")[:400])
    # Search checked binding with hA or TVd or HUd near slide
    for m in re.finditer(
        r"a&2&&.{0,200}slide|a&2\).{0,300}checked.{0,200}HUd|checked.{0,30}HUd.{0,80}",
        r,
    ):
        print("bind:", m.group().replace("\n", " ")[:400])
    # Full a&2 for gLi - find after zR stopPropagation closing
    m = re.search(
        r'zR\(c\)\}\)\("click".{0,200}\};if\(a&2\).{0,400}',
        r,
    )
    if m:
        print("a2:", m.group().replace("\n", " ")[:600])
    # simpler
    idx = r.find('return _.x(d.zR(c))}')
    if idx > 0:
        print("after zR:", r[idx : idx + 500].replace("\n", " "))
    break
