# -*- coding: utf-8 -*-
import json
import re

with open("gemini.google.com.har", "r", encoding="utf-8") as f:
    har = json.load(f)

for e in har["log"]["entries"]:
    r = (e["response"].get("content") or {}).get("text") or ""
    if "mat-slide-toggle" not in r or "zR" not in r:
        continue

    # Find function that creates mat-slide-toggle with zR
    for m in re.finditer(
        r".{0,100}mat-slide-toggle.{0,20}.{{0,800}?zR.{0,200}", r
    ):
        print(m.group().replace("\n", " ")[:900])
        print("---")

    # Find gLi / template with thinking-level-header
    for name in ["gLi", "hLi", "iLi", "fLi", "eLi", "dLi"]:
        for m in re.finditer(rf"{name}=function\(a\).{{0,1200}}", r):
            s = m.group()
            if "thinking" in s or "slide-toggle" in s or "強化" in s or "slideToggle" in s:
                print(f"=== {name} ===")
                print(s.replace("\n", " ")[:1200])
                print()

    # Host bindings for checked on slide toggle
    for m in re.finditer(r".{0,80}slideToggle.{0,200}checked.{0,200}", r):
        print("checked bind:", m.group().replace("\n", " ")[:400])

    # How is checked computed for the toggle
    for m in re.finditer(
        r".{0,100}THINKING_LEVEL_EXTENDED.{0,150}checked|checked.{0,100}THINKING_LEVEL_EXTENDED.{0,150}",
        r,
    ):
        print("checked/ext:", m.group().replace("\n", " ")[:400])

    for m in re.finditer(r"hA\(\)===.{0,80}|selectedThinkingLevel.{0,200}", r):
        s = m.group().replace("\n", " ")
        if "THINKING" in s or "HUd" in s or "EXTENDED" in s or "checked" in s:
            print("sel:", s[:350])

    break
