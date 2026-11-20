"""Compare two models' screening results and build a human-review queue.

Consensus rule (conservative):
    include       both models = 1, each consistent with its own criterion ratings
    exclude       both models = 0, each consistent with its own criterion ratings
    human_review  anything else
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from .runner import CSV_OUT_ENCODING, read_csv_any


def cohen_kappa(a: pd.Series, b: pd.Series, labels) -> float:
    if len(a) == 0:
        return float("nan")
    po = (a == b).mean()
    pe = sum((a == k).mean() * (b == k).mean() for k in labels)
    return (po - pe) / (1 - pe) if pe < 1 else float("nan")


def _truthy(v) -> bool:
    if isinstance(v, str):
        return v.strip().lower() == "true"
    return True if pd.isna(v) else bool(v)


def compare(claude_csv: Path, openai_csv: Path, out_csv: Path) -> pd.DataFrame:
    c, o = read_csv_any(claude_csv), read_csv_any(openai_csv)
    df = c.merge(o[["id"] + [k for k in o.columns if k.startswith("openai_")]],
                 on="id", how="inner")
    both = df.dropna(subset=["claude_decision", "openai_decision"]).copy()
    for col in ("claude_decision", "openai_decision"):
        both[col] = both[col].astype(int)
    a, b = both["claude_decision"], both["openai_decision"]

    lines = [f"Records screened by both models: {len(both)} (of {len(df)})", "",
             "Confusion matrix (rows = Claude, columns = OpenAI):",
             pd.crosstab(a, b, rownames=["claude"], colnames=["openai"])
               .reindex(index=[0, 1, 2], columns=[0, 1, 2], fill_value=0).to_string(), "",
             f"Raw agreement (0/1/2):          {(a == b).mean():.3f}",
             f"Cohen's kappa (0/1/2):          {cohen_kappa(a, b, [0, 1, 2]):.3f}",
             f"Cohen's kappa (include vs not): "
             f"{cohen_kappa((a == 1).astype(int), (b == 1).astype(int), [0, 1]):.3f}"]
    for crit in ("A", "B", "C"):
        agree = (both[f"claude_criterion_{crit}"] == both[f"openai_criterion_{crit}"]).mean()
        lines.append(f"Agreement on criterion {crit}:      {agree:.3f}")

    consistent = (both["claude_rule_consistent"].map(_truthy)
                  & both["openai_rule_consistent"].map(_truthy))
    agree01 = (a == b) & a.isin([0, 1]) & consistent
    both["consensus"] = "human_review"
    both.loc[agree01 & (a == 1), "consensus"] = "include"
    both.loc[agree01 & (a == 0), "consensus"] = "exclude"
    both["review_reason"] = ""
    rev = both["consensus"] == "human_review"
    both.loc[rev & (a != b), "review_reason"] = "models disagree"
    both.loc[rev & (a == b) & (a == 2), "review_reason"] = "both uncertain"
    both.loc[rev & (both["review_reason"] == ""), "review_reason"] = "decision inconsistent with criteria"
    both["human_decision"] = ""
    both["human_notes"] = ""

    lines += ["", "Consensus:", both["consensus"].value_counts().to_string(),
              "", "Reasons for human review:",
              both.loc[rev, "review_reason"].value_counts().to_string()]
    report = "\n".join(lines)
    print(report)

    front = ["consensus", "review_reason", "human_decision", "human_notes",
             "claude_decision", "openai_decision", "title", "abstract",
             "claude_rationale", "openai_rationale", "claude_exclusion_code",
             "openai_exclusion_code", "doi", "id"]
    front = [f for f in front if f in both.columns]
    both = both.sort_values("consensus",
                            key=lambda s: s.map({"human_review": 0, "include": 1, "exclude": 2}))
    both = both[front + [k for k in both.columns if k not in front]]
    both.to_csv(out_csv, index=False, encoding=CSV_OUT_ENCODING)
    out_csv.with_suffix(".txt").write_text(report + "\n", encoding="utf-8")
    print(f"\nWrote {out_csv}\nWrote {out_csv.with_suffix('.txt')} (agreement report)")
    return both
