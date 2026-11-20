"""Load a rubric TOML file and turn it into a prompt and an output schema."""

from __future__ import annotations

import hashlib
import json
import math
import tomllib
from dataclasses import dataclass
from pathlib import Path


TERNARY = {"type": "string", "enum": ["yes", "partly", "no"]}
MAX_ABSTRACT_CHARS = 6000  # some OpenAlex "abstracts" are full-text dumps

SYSTEM_TEMPLATE = """You are an expert reviewer screening literature for the IPBES Second Global Assessment, chapter on Nature's Contributions to People (NCP). You are screening titles and abstracts for relevance to ONE NCP:

NCP {ncp_number} - {ncp_name_upper}
{definition}

PURPOSE OF THE SCREEN
{purpose}

Rate three criteria, each as "yes", "partly" or "no".
{criteria}

EXCLUSIONS - if any applies, the decision is 0. Report the most relevant code:
{exclusions}
Use "none" if no exclusion applies.

DECISION RULE (apply mechanically after rating the criteria):
  1 (relevant)          : A = yes AND B = yes AND C = yes, and no exclusion.
  2 (uncertain - human) : No exclusion and no criterion rated "no", but at least one rated "partly"; OR the record lacks an abstract / gives too little information but the title suggests it could satisfy A and B.
  0 (not relevant)      : Any exclusion applies, OR any criterion is "no" (with adequate information to judge).

Judge only from the information provided. Do not infer content that is not stated. Do not reward topical vocabulary; reward evidence. Keep the rationale to at most 60 words, referring to the criteria."""

USER_TEMPLATE = """Screen this record for NCP {ncp_number} ({ncp_name}).

TITLE: {title}
PUBLICATION TYPE: {type}
SOURCE: {source}
YEAR: {year}
OPENALEX TOPIC: {topic}
KEYWORDS: {keywords}
ABSTRACT: {abstract}"""


@dataclass
class Rubric:
    path: Path
    ncp_number: int
    ncp_name: str
    system_prompt: str
    schema: dict
    version: str

    @property
    def stem(self) -> str:
        return f"ncp{self.ncp_number}"


def load_rubric(path: str | Path) -> Rubric:
    path = Path(path)
    with path.open("rb") as f:
        cfg = tomllib.load(f)

    for key in ("ncp_number", "ncp_name", "definition", "purpose", "criteria",
                "exclusions", "subject_categories"):
        if key not in cfg:
            raise ValueError(f"{path.name}: missing '{key}'")
    for c in ("A", "B", "C"):
        for part in ("name", "yes", "partly", "no"):
            if part not in cfg["criteria"].get(c, {}):
                raise ValueError(f"{path.name}: criteria.{c} needs '{part}'")

    criteria_txt = "\n".join(
        f"\nCRITERION {c} - {cfg['criteria'][c]['name']}.\n"
        f"  yes    : {cfg['criteria'][c]['yes']}\n"
        f"  partly : {cfg['criteria'][c]['partly']}\n"
        f"  no     : {cfg['criteria'][c]['no']}"
        for c in ("A", "B", "C"))
    codes = [e["code"] for e in cfg["exclusions"]]
    if len(set(codes)) != len(codes) or any(" " in c for c in codes):
        raise ValueError(f"{path.name}: exclusion codes must be unique and contain no spaces")
    excl_txt = "\n".join(f"  {e['code']} : {e['description']}" for e in cfg["exclusions"])

    system = SYSTEM_TEMPLATE.format(
        ncp_number=cfg["ncp_number"], ncp_name_upper=cfg["ncp_name"].upper(),
        definition=cfg["definition"].strip(), purpose=cfg["purpose"].strip(),
        criteria=criteria_txt, exclusions=excl_txt)

    schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "criterion_A": TERNARY,
            "criterion_B": TERNARY,
            "criterion_C": TERNARY,
            "exclusion_code": {"type": "string", "enum": ["none"] + codes},
            "decision": {"type": "integer", "enum": [0, 1, 2]},
            "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
            "ncp_dimension": {"type": "string", "enum": [
                "potential", "realised_supply", "impact_on_people", "multiple",
                "not_applicable"]},
            "subject_category": {"type": "array", "items": {
                "type": "string", "enum": list(cfg["subject_categories"])}},
            "spatial_scale": {"type": "string", "enum": [
                "global", "multi_regional", "continental_regional", "national",
                "subnational_landscape", "site", "not_stated"]},
            "ipbes_region": {"type": "string", "enum": [
                "global", "Africa", "Americas", "Asia-Pacific", "Europe-Central_Asia",
                "multiple", "not_stated"]},
            "temporal_coverage": {"type": "string", "enum": [
                "multi_decadal", "multi_year", "single_period", "projection_scenario",
                "not_stated"]},
            "evidence_type": {"type": "string", "enum": [
                "primary_empirical", "remote_sensing_or_modelling",
                "systematic_review_or_meta_analysis", "narrative_review",
                "dataset_or_indicator", "scenario_projection", "conceptual_or_other"]},
            "rationale": {"type": "string"},
        },
    }
    schema["required"] = list(schema["properties"])

    version = hashlib.sha256(
        (system + USER_TEMPLATE + json.dumps(schema, sort_keys=True)).encode()
    ).hexdigest()[:12]
    return Rubric(path, int(cfg["ncp_number"]), cfg["ncp_name"], system, schema, version)


def _clean(v, default="not provided") -> str:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return default
    s = str(v).strip()
    return s or default


def build_user_message(rubric: Rubric, row) -> str:
    abstract = _clean(row.get("abstract"), "NO ABSTRACT AVAILABLE")
    if len(abstract) > MAX_ABSTRACT_CHARS:
        abstract = abstract[:MAX_ABSTRACT_CHARS] + " [...truncated]"
    year = row.get("year")
    try:
        year = int(year)
    except (TypeError, ValueError):
        year = "not provided"
    return USER_TEMPLATE.format(
        ncp_number=rubric.ncp_number, ncp_name=rubric.ncp_name,
        title=_clean(row.get("title")), type=_clean(row.get("type")),
        source=_clean(row.get("source")), year=year, topic=_clean(row.get("topic")),
        keywords=_clean(row.get("keywords")), abstract=abstract)


def validate_result(rubric: Rubric, r: dict) -> None:
    missing = [k for k in rubric.schema["required"] if k not in r]
    if missing:
        raise ValueError(f"missing keys: {missing}")
    for k, spec in rubric.schema["properties"].items():
        v = r[k]
        if "enum" in spec and v not in spec["enum"]:
            raise ValueError(f"{k}={v!r} not allowed")
        if spec.get("type") == "array":
            bad = [x for x in v if x not in spec["items"]["enum"]]
            if bad:
                raise ValueError(f"{k} has invalid values {bad}")


def rule_decision(r: dict) -> int:
    """Re-derive the decision from the criteria so inconsistencies can be flagged."""
    crit = [r["criterion_A"], r["criterion_B"], r["criterion_C"]]
    if r["exclusion_code"] != "none":
        return 0
    if all(c == "yes" for c in crit):
        return 1
    if "no" in crit:
        return 0
    return 2
