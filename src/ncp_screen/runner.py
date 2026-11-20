"""Load records, run a screening function over them in parallel, write results."""

from __future__ import annotations

import datetime as dt
import json
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import pandas as pd

from .rubric import Rubric, build_user_message, rule_decision, validate_result

CSV_OUT_ENCODING = "utf-8-sig"  # UTF-8 with BOM: Excel on Windows/Mac shows accents correctly


def read_csv_any(path: str | Path) -> pd.DataFrame:
    """Read a CSV even if someone re-saved it from Excel in a non-UTF-8 encoding."""
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return pd.read_csv(path, encoding=enc)
        except UnicodeDecodeError:
            continue
    raise ValueError(f"Could not decode {path}")


def load_records(path: str | Path, ncp_number: int) -> pd.DataFrame:
    df = read_csv_any(path)
    for col in ("id", "title", "abstract"):
        if col not in df.columns:
            raise ValueError(f"{path}: required column '{col}' not found")
    n0 = len(df)
    df = df.dropna(subset=["id"])
    if "ncp_number" in df.columns:
        df = df[df["ncp_number"] == ncp_number]
    n1 = len(df)
    df = df.drop_duplicates(subset=["id"])
    print(f"Loaded {n0} rows -> {n1} non-blank NCP {ncp_number} rows -> {len(df)} unique records")
    return df.reset_index(drop=True)


def select_records(path, ncp_number, sample=None, seed=42, limit=None) -> pd.DataFrame:
    df = load_records(path, ncp_number)
    if sample:
        df = df.sample(n=min(sample, len(df)), random_state=seed)
    if limit:
        df = df.head(limit)
    return df.reset_index(drop=True)


def _done_ids(log_path: Path, version: str) -> set[str]:
    """IDs already screened successfully with THIS rubric version."""
    if not log_path.exists():
        return set()
    done = set()
    with log_path.open(encoding="utf-8") as f:
        for line in f:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("status") == "ok" and rec.get("prompt_version") == version:
                done.add(rec["id"])
    return done


def output_paths(rubric: Rubric, provider: str, out_dir: str | Path):
    out_dir = Path(out_dir)
    stem = f"{rubric.stem}_{provider}"
    return out_dir / f"{stem}_log.jsonl", out_dir / f"{stem}_results.csv"


def run_screening(df: pd.DataFrame, rubric: Rubric, screen_fn, model: str,
                  provider: str, out_dir: str | Path, workers: int = 4) -> pd.DataFrame:
    """
    screen_fn(user_message) -> (result_dict, usage_dict). Every call is appended to a
    JSONL log straight away, so an interrupted run resumes where it stopped.
    """
    log_path, csv_path = output_paths(rubric, provider, out_dir)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    done = _done_ids(log_path, rubric.version)
    todo = df[~df["id"].isin(done)]
    print(f"Model: {model} | rubric: {rubric.path.name} | prompt version: {rubric.version}\n"
          f"{len(done)} already screened, {len(todo)} to go")

    lock = threading.Lock()
    counts = {"ok": 0, "error": 0}

    def work(row):
        rec = {"id": row["id"], "model": model, "rubric": rubric.path.name,
               "prompt_version": rubric.version,
               "timestamp": dt.datetime.now(dt.timezone.utc).isoformat()}
        try:
            result, usage = screen_fn(build_user_message(rubric, row))
            validate_result(rubric, result)
            rec.update(status="ok", result=result, usage=usage)
        except Exception as e:  # logged; retried automatically on the next run
            rec.update(status="error", error=f"{type(e).__name__}: {e}")
        with lock:
            with log_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            counts[rec["status"]] += 1
            n = sum(counts.values())
            if n % 25 == 0 or n == len(todo):
                print(f"  {n}/{len(todo)} done ({counts['error']} errors)")
            if rec["status"] == "error" and counts["error"] <= 3:
                print(f"  error on {rec['id']}: {rec['error'][:200]}")

    try:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            for fut in as_completed([ex.submit(work, r) for _, r in todo.iterrows()]):
                fut.result()
    except KeyboardInterrupt:
        print("\nInterrupted. Progress is saved; run the same command again to continue.")
        raise SystemExit(1)

    if counts["error"]:
        print(f"{counts['error']} records failed; run the same command again to retry them.")
    return write_results(log_path, df, csv_path, provider, rubric.version)


def write_results(log_path: Path, records: pd.DataFrame, csv_path: Path,
                  prefix: str, version: str) -> pd.DataFrame:
    """Keep the latest successful result per record from the CURRENT rubric version."""
    latest = {}
    with log_path.open(encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            if rec.get("status") == "ok" and rec.get("prompt_version") == version:
                latest[rec["id"]] = rec
    rows = []
    for rid, rec in latest.items():
        res = rec["result"]
        d = {"id": rid}
        for k, v in res.items():
            d[f"{prefix}_{k}"] = "; ".join(v) if isinstance(v, list) else v
        d[f"{prefix}_rule_consistent"] = rule_decision(res) == res["decision"]
        d[f"{prefix}_model"] = rec["model"]
        d[f"{prefix}_prompt_version"] = rec["prompt_version"]
        d[f"{prefix}_timestamp"] = rec["timestamp"]
        rows.append(d)
    res_df = pd.DataFrame(rows, columns=["id"] if not rows else None)
    merged = records.merge(res_df, on="id", how="left")
    merged.to_csv(csv_path, index=False, encoding=CSV_OUT_ENCODING)

    dec = merged.get(f"{prefix}_decision", pd.Series(dtype=float))
    return merged
