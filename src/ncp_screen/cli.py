"""Command-line entry point:  uv run ncp-screen <command> ...

Commands:
  check    verify setup (Python, API keys, config, rubric, optional CSV)
  claude   screen records with Claude
  openai   screen records with an OpenAI model
  compare  compare the two models and build the human-review queue
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tomllib
from pathlib import Path

from dotenv import load_dotenv

from .rubric import build_user_message, load_rubric


def load_config(path: str) -> dict:
    p = Path(path)
    if not p.exists():
        sys.exit(f"Config file not found: {p.resolve()}\n"
                 "Run commands from the project folder, or pass --config.")
    try:
        with p.open("rb") as f:
            return tomllib.load(f)
    except tomllib.TOMLDecodeError as e:
        sys.exit(f"Problem in {p}:\n  {e}")


def add_screen_args(sp):
    sp.add_argument("csv", help="OpenAlex export CSV (e.g. data/openalex_results.csv)")
    sp.add_argument("--model", help="override the model set in config.toml")
    sp.add_argument("--sample", type=int, help="screen a random sample of N records")
    sp.add_argument("--seed", type=int, default=42, help="random seed for --sample")
    sp.add_argument("--limit", type=int, help="screen only the first N records")
    sp.add_argument("--workers", type=int, help="parallel requests")
    sp.add_argument("--dry-run", action="store_true",
                    help="show the exact prompt for the first record, call no API")


def main(argv=None):
    load_dotenv(Path.cwd() / ".env")
    p = argparse.ArgumentParser(prog="ncp-screen", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--config", default="config.toml")
    p.add_argument("--rubric", help="override the rubric file set in config.toml")
    p.add_argument("--out-dir", help="override the output folder set in config.toml")
    sub = p.add_subparsers(dest="command", required=True)
    chk = sub.add_parser("check", help="verify setup")
    chk.add_argument("csv", nargs="?", help="optionally check a CSV too")
    add_screen_args(sub.add_parser("claude", help="screen with Claude"))
    add_screen_args(sub.add_parser("openai", help="screen with OpenAI"))
    sub.add_parser("compare", help="compare results and build review queue")
    args = p.parse_args(argv)

    cfg = load_config(args.config)
    run = cfg.get("run", {})
    rubric_path = args.rubric or run.get("rubric", "rubrics/ncp12_food_feed.toml")
    try:
        rubric = load_rubric(rubric_path)
    except FileNotFoundError:
        sys.exit(f"Rubric file not found: {rubric_path}")
    except (ValueError, tomllib.TOMLDecodeError) as e:
        sys.exit(f"Problem in rubric file {rubric_path}:\n  {e}")
    out_dir = Path(args.out_dir or run.get("output_dir", "output"))

    if args.command == "check":
        return cmd_check(args, rubric)
    if args.command == "compare":
        from .compare import compare
        from .runner import output_paths
        _, c_csv = output_paths(rubric, "claude", out_dir)
        _, o_csv = output_paths(rubric, "openai", out_dir)
        for f in (c_csv, o_csv):
            if not f.exists():
                sys.exit(f"Missing {f}. Run both 'claude' and 'openai' first.")
        compare(c_csv, o_csv, out_dir / f"{rubric.stem}_comparison.csv")
        return

    from .runner import run_screening, select_records
    df = select_records(args.csv, rubric.ncp_number, args.sample, args.seed, args.limit)
    if df.empty:
        sys.exit("No records to screen (check the CSV and the rubric's ncp_number).")
    if args.dry_run:
        print("=== SYSTEM PROMPT ===\n" + rubric.system_prompt)
        print("\n=== RECORD MESSAGE (first record) ===\n" + build_user_message(rubric, df.iloc[0]))
        print("\n=== OUTPUT SCHEMA ===\n" + json.dumps(rubric.schema, indent=2))
        print(f"\nPrompt version: {rubric.version}")
        return

    pcfg = cfg.get(args.command, {})
    workers = args.workers or run.get("workers", 4)
    if args.command == "claude":
        _need_key("ANTHROPIC_API_KEY")
        from .providers import make_claude
        model = args.model or pcfg.get("model", "claude-opus-5-5")
        fn = make_claude(rubric, model, pcfg.get("temperature", 0.0),
                         pcfg.get("max_tokens", 1024))
    else:
        _need_key("OPENAI_API_KEY")
        from .providers import make_openai
        model = args.model or pcfg.get("model", "gpt-5.6")
        fn = make_openai(rubric, model, pcfg.get("reasoning_effort", "medium"),
                         pcfg.get("temperature"), pcfg.get("max_output_tokens", 4000))
    run_screening(df, rubric, fn, model, args.command, out_dir, workers)


def _need_key(name: str):
    if not os.environ.get(name):
        sys.exit(f"{name} is not set. Copy .env.example to .env and paste your key in.")


def cmd_check(args, rubric):
    ok = True
    print(f"Python {sys.version.split()[0]}  OK")
    print(f"Rubric {rubric.path}  OK  (NCP {rubric.ncp_number}: {rubric.ncp_name}, "
          f"prompt version {rubric.version})")
    for k in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY"):
        present = bool(os.environ.get(k))
        print(f"{k}: {'set' if present else 'NOT SET'}")
        ok &= present
    if args.csv:
        from .runner import load_records
        df = load_records(args.csv, rubric.ncp_number)
        print(f"CSV OK: {len(df)} records; {df['abstract'].notna().sum()} with abstracts")
    print("\nReady." if ok else "\nAdd the missing keys to .env (see .env.example).")


if __name__ == "__main__":
    main()
