#!/usr/bin/env python3
"""FORGE-ONTOLOGY-READY-1 validation: run forge's stored records through the project ontology pack's property schemas.

Read only. Core's own validator does the checking (``smartmemory.record_schema.validate_item_fields`` against an
``OntologyType`` built from each pack entry, annotation keys dropped), imported from the SmartMemory core checkout
on ``sys.path``; nothing is installed and no bytecode is written into it.

Pack lookup, first hit wins (the same order as forge/compose ``lib/ontology/resolve-pack.js``):
``--pack`` / ``PROJECT_ONTOLOGY_PACK``, core's ``.../packs/project-ontology/1.0.0/pack.json``, the draft
``SmartMemory/contracts/project-ontology-bundle.v1.json``. Missing pack or core: a WARNING and exit 1, never a pass.

Each dataset is checked AS STORED (the record's own field names) and, where the mapping in ``mapping.md`` renames
fields, MAPPED (renamed, nothing invented). Before any count is trusted, the preconditions prove the validator
rejects deliberately broken records; a false precondition prints ``VERDICT: INVALID <precondition>``.

    PYTHONDONTWRITEBYTECODE=1 python3 -I validate.py [--json out.json] [--pack P] [--sm DIR] [--forge DIR] [--wiki DIR]
"""

from __future__ import annotations

import argparse
import dataclasses
import glob
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
PACK_DIR = ("smartmemory", "ontology", "packs", "project-ontology", "1.0.0")
DRAFT = ("contracts", "project-ontology-bundle.v1.json")


def find_sm(start: Path) -> Path | None:
    for d in (start, *start.parents):
        for cand in (d / "SmartMemory", d):
            if (cand / "smart-memory-core").is_dir() or cand.joinpath(*DRAFT).is_file():
                return cand
    return None


def resolve_pack(arg: str | None, sm: Path | None) -> tuple[str, Path] | None:
    raw = arg or os.environ.get("PROJECT_ONTOLOGY_PACK")
    if raw:
        p = Path(raw)
        p = p / "pack.json" if p.is_dir() else p
        return ("env", p) if p.is_file() else None
    if sm:
        core_pack = sm.joinpath("smart-memory-core", *PACK_DIR, "pack.json")
        if core_pack.is_file():
            return ("pack", core_pack)
        if sm.joinpath(*DRAFT).is_file():
            return ("draft", sm.joinpath(*DRAFT))
    return None


def ontology_types(pack: dict, OntologyType, validate_properties_schema) -> dict:
    allowed = {f.name for f in dataclasses.fields(OntologyType)}
    out = {}
    for entry in pack["types"]:
        kw = {k: v for k, v in entry.items() if k in allowed}
        kw["required_properties"] = set(kw.get("required_properties") or ())
        validate_properties_schema(kw.get("properties_schema") or {}, kw["required_properties"])
        out[entry["name"]] = OntologyType(**kw)
    return out


def load_json(path: Path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


# ---- datasets: (label, pack type, [(record id, fields)], mapper or None) -------------------------------------------

def features(forge: Path):
    rows = []
    for f in sorted(glob.glob(str(forge / "compose" / "docs" / "features" / "*" / "feature.json"))):
        rows.append((Path(f).parent.name, load_json(Path(f))))
    return rows


def manifests(sm: Path, forge: Path):
    found = {"project": [], "module": [], "lane": [], "no_project": []}
    for path in (sm / ".compose" / "compose.json", forge / ".compose" / "compose.json", forge / "compose" / ".compose" / "compose.json"):
        cfg = load_json(path)
        block = cfg.get("project")
        rel = str(path.relative_to(path.parents[2])) if len(path.parents) > 2 else str(path)
        if not isinstance(block, dict):
            found["no_project"].append(rel)
            continue
        found["project"].append((rel, block))
        found["module"] += [(f"{rel}#{m.get('name')}", m) for m in block.get("modules", [])]
        found["lane"] += [(f"{rel}#{lane.get('id')}", lane) for lane in block.get("lanes", [])]
    return found


def fluid_ideas(forge: Path):
    rows = []
    for f in sorted(glob.glob(str(forge / "compose" / "docs" / "product" / "fluid" / "records" / "*.json"))):
        rec = load_json(Path(f))
        if rec.get("kind") == "idea":
            rows.append((rec.get("handle") or Path(f).stem, rec))
    return rows


def ops_units(sm: Path):
    rows = []
    for f in sorted(glob.glob(str(sm / "smart-memory-ops" / "queues" / "*-units.json"))):
        units = load_json(Path(f)).get("units")
        items = units.items() if isinstance(units, dict) else ((u.get("id"), u) for u in units or [] if isinstance(u, dict))
        rows += [(f"{Path(f).name}#{uid}", {"id": uid, **row}) for uid, row in items if isinstance(row, dict)]
    return rows


def wiki_records(wiki: Path):
    corpus = load_json(wiki / "fixtures" / "corpus" / "records.json")
    return {k: v for k, v in corpus.items() if k.startswith("wiki_") and isinstance(v, list)}


def ren(**names):
    """Mapper that renames stored fields to pack properties; only fields present are copied (nothing invented)."""
    def m(fields):
        return {pack: fields[stored] for pack, stored in names.items() if fields.get(stored) is not None}
    return m


# ---- run -----------------------------------------------------------------------------------------------------------

def check(rows, ot, validate_item_fields, mapper=None):
    passed, reasons, examples, extra = 0, Counter(), {}, Counter()
    props = set(ot.properties_schema or {})
    for rid, fields in rows:
        rec = mapper(fields) if mapper else fields
        vs = validate_item_fields(rec, ot)
        if not mapper:
            extra.update(k for k in fields if k not in props)
        if not vs:
            passed += 1
            continue
        for v in vs:
            key = f"{v.property}: {v.message}"
            reasons[key] += 1
            examples.setdefault(key, rid)
    return {"n": len(rows), "pass": passed, "fail": len(rows) - passed,
            "reasons": [{"reason": r, "count": c, "example": examples[r]} for r, c in reasons.most_common(5)],
            "unmapped_fields": extra.most_common(8)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack")
    ap.add_argument("--sm")
    ap.add_argument("--forge")
    ap.add_argument("--wiki")
    ap.add_argument("--json")
    a = ap.parse_args()
    sm = Path(a.sm) if a.sm else find_sm(HERE)
    if not sm:
        print("WARNING: no SmartMemory checkout found above this script; pass --sm", file=sys.stderr)
        return 1
    forge = Path(a.forge) if a.forge else next((d / "forge" for d in HERE.parents if (d / "forge" / "compose").is_dir()), None)
    wiki = Path(a.wiki) if a.wiki else next((p for p in (forge.parent / "forge" / "wiki", sm / "smart-memory-wiki") if (p / "fixtures").is_dir()), None)
    found = resolve_pack(a.pack, sm)
    if not found:
        print("WARNING: project ontology pack not found (no --pack, no PROJECT_ONTOLOGY_PACK, no core pack, no draft)", file=sys.stderr)
        return 1
    source, pack_file = found
    sys.path.insert(0, str(sm / "smart-memory-core"))
    try:
        from smartmemory.ontology_types import OntologyType
        from smartmemory.record_schema import validate_item_fields, validate_properties_schema
    except ImportError as e:
        print(f"WARNING: SmartMemory core not importable from {sm / 'smart-memory-core'}: {e}", file=sys.stderr)
        return 1
    pack = load_json(pack_file)
    ots = ontology_types(pack, OntologyType, validate_properties_schema)

    # Preconditions: the validator must reject deliberately broken records and accept a minimal good one.
    pre = {
        "Feature with no code is rejected": bool(validate_item_fields({"status": "PLANNED"}, ots["Feature"])),
        "Feature code 123 (not a string) is rejected": bool(validate_item_fields({"code": 123}, ots["Feature"])),
        "Gate round '1' (string, not integer) is rejected": bool(validate_item_fields({"id": "X:r1:codex", "round": "1"}, ots["Gate"])),
        "Unit repos 'core' (string, not list) is rejected": bool(validate_item_fields({"id": "U-1", "repos": "core"}, ots["Unit"])),
        "a minimal good Feature passes": not validate_item_fields({"code": "COMP-X-1", "status": "PLANNED"}, ots["Feature"]),
        "unknown extra fields pass (core parity)": not validate_item_fields({"code": "COMP-X-1", "zzz": 1}, ots["Feature"]),
    }
    for name, ok in pre.items():
        if not ok:
            print(f"VERDICT: INVALID {name}")
            return 2

    feats = features(forge)
    man = manifests(sm, forge)
    ideas = fluid_ideas(forge)
    units = ops_units(sm)
    wk = wiki_records(wiki) if wiki else {}
    code_re = re.compile(r"^[A-Z][A-Z0-9-]*[A-Z0-9]$")
    by_kind = lambda k: [(r.get("entry_id"), r) for r in wk.get("wiki_entry", []) if r.get("kind") == k]  # noqa: E731

    runs = [
        ("Compose feature.json (as stored)", "Feature", feats, None),
        ("Project manifests: project block (as stored)", "Project", man["project"], None),
        ("Project manifests: modules[] (as stored)", "Module", man["module"], None),
        ("Project manifests: lanes[] (as stored)", "Lane", man["lane"], None),
        ("Project manifests: lanes[] (mapped opsLane->ops_lane)", "Lane", man["lane"],
         ren(id="id", label="label", ops_lane="opsLane", repo="repo", module="module")),
        ("Compose fluid ideas (as stored)", "Idea", ideas, None),
        ("Compose fluid ideas (mapped handle->id)", "Idea", ideas, ren(id="handle", title="title")),
        ("ops queue unit rows (as stored)", "Unit", units, None),
        ("wiki fixtures wiki_feature (as stored)", "Feature", [(r.get("feature_id"), r) for r in wk.get("wiki_feature", [])], None),
        ("wiki fixtures wiki_feature (mapped)", "Feature", [(r.get("feature_id"), r) for r in wk.get("wiki_feature", [])],
         ren(code="feature_id", description="title", status="roadmap_status")),
        ("wiki fixtures wiki_doc (as stored)", "Artifact", [(r.get("doc_id"), r) for r in wk.get("wiki_doc", [])], None),
        ("wiki fixtures wiki_entry kind=decision (as stored)", "ProjectDecision", by_kind("decision"), None),
        ("wiki fixtures wiki_entry kind=decision (mapped)", "ProjectDecision", by_kind("decision"), ren(id="entry_id", statement="text")),
        ("wiki fixtures wiki_entry kind=idea (as stored)", "Idea", by_kind("idea"), None),
        ("wiki fixtures wiki_entry kind=idea (mapped)", "Idea", by_kind("idea"), ren(id="entry_id", title="text")),
    ]
    results = []
    for label, tname, rows, mapper in runs:
        r = check(rows, ots[tname], validate_item_fields, mapper)
        results.append({"dataset": label, "type": tname, **r})

    key_fail = [c for c, f in feats if not (isinstance(f.get("code"), str) and code_re.match(f["code"]))]
    code_dir = [c for c, f in feats if f.get("code") != c]
    feature_dirs = sum(1 for d in (forge / "compose" / "docs" / "features").iterdir() if d.is_dir())
    out = {
        "pack": {"source": source, "file": str(pack_file), "pack_id": pack.get("pack_id"), "pack_version": pack.get("pack_version")},
        "preconditions": pre,
        "inputs": {"feature_dirs": feature_dirs, "feature_json": len(feats), "manifests_without_project": man["no_project"],
                   "wiki": str(wiki) if wiki else None, "wiki_records": {k: len(v) for k, v in wk.items()}},
        "feature_key_rule_failures": key_fail, "feature_code_ne_folder": code_dir,
        "results": results,
    }
    print(f"pack: {source} {pack_file}")
    print(f"preconditions: {sum(pre.values())}/{len(pre)} hold")
    print(f"inputs: {feature_dirs} feature dirs, {len(feats)} feature.json; manifests without a project block: {man['no_project']}; wiki {wiki}")
    print("| dataset | type | n | pass | fail |")
    print("|---|---|---|---|---|")
    for r in results:
        print(f"| {r['dataset']} | {r['type']} | {r['n']} | {r['pass']} | {r['fail']} |")
    print(f"Feature key rule (^[A-Z][A-Z0-9-]*[A-Z0-9]$) failures: {len(key_fail)} {key_fail[:5]}; code != folder: {len(code_dir)} {code_dir[:5]}")
    if a.json:
        Path(a.json).write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
