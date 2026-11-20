#!/usr/bin/env python3
"""
Build the static website into _site/.

- Validates every rubrics/*.toml file (the deploy fails if one is broken).
- Renders each rubric into the exact system prompt, output schema and version
  code, using the same code as the command-line tool, and writes rubrics/*.json.
- Writes rubrics/index.json (the list of rubrics in the dropdown) and
  config.json (default models etc. from config.toml).

Run locally to preview:
    python tools/build_site.py
    python -m http.server 8000 -d _site     # then open http://localhost:8000
"""

import json
import shutil
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
from ncp_screen.rubric import MAX_ABSTRACT_CHARS, USER_TEMPLATE, load_rubric  # noqa: E402

SITE = ROOT / "_site"


def main() -> int:
    if SITE.exists():
        shutil.rmtree(SITE)
    (SITE / "rubrics").mkdir(parents=True)
    shutil.copy(ROOT / "index.html", SITE / "index.html")
    shutil.copytree(ROOT / "assets", SITE / "assets")
    (SITE / ".nojekyll").write_text("")

    index, errors = [], []
    for path in sorted((ROOT / "rubrics").glob("*.toml")):
        try:
            r = load_rubric(path)
            raw = tomllib.loads(path.read_text(encoding="utf-8"))
        except Exception as e:  # report every broken file, not just the first
            errors.append(f"{path.name}: {e}")
            continue
        out = {
            "file": path.name,
            "ncp_number": r.ncp_number,
            "ncp_name": r.ncp_name,
            "version": r.version,
            "system_prompt": r.system_prompt,
            "user_template": USER_TEMPLATE,
            "max_abstract_chars": MAX_ABSTRACT_CHARS,
            "schema": r.schema,
            "criteria": {k: raw["criteria"][k]["name"] for k in ("A", "B", "C")},
        }
        name = path.stem + ".json"
        (SITE / "rubrics" / name).write_text(json.dumps(out, indent=1), encoding="utf-8")
        index.append({"json": name, "toml": path.name, "ncp_number": r.ncp_number,
                      "ncp_name": r.ncp_name, "version": r.version})
        print(f"  ok  {path.name}  (NCP {r.ncp_number}: {r.ncp_name}, version {r.version})")

    if errors:
        print("\nBROKEN RUBRIC FILES (fix these, the site was not updated):")
        for e in errors:
            print("  " + e)
        return 1
    if len({i["ncp_number"] for i in index}) != len(index):
        print("\nNOTE: more than one rubric uses the same ncp_number (allowed, e.g. variants).")

    index.sort(key=lambda i: (i["ncp_number"], i["toml"]))
    (SITE / "rubrics" / "index.json").write_text(json.dumps(index, indent=1), encoding="utf-8")
    with (ROOT / "config.toml").open("rb") as f:
        cfg = tomllib.load(f)
    (SITE / "config.json").write_text(json.dumps(cfg, indent=1), encoding="utf-8")
    print(f"\nBuilt {SITE} with {len(index)} rubric(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
