"""STRAT-CODEGRAPH-1 fallback bundle producer, used until `smartmemory code bundle` (CODE-BUNDLE-CLI-1) ships.

Imports the installed smartmemory, parses one checkout store-free with CodeIndexer.parse (prepare_bundle's checks minus its upload cap), adds item_id
to every entity, wraps the hosted bundle in the agreed snapshot envelope and writes it to --out.

usage: bundle_fallback.py PATH --repo NAME --out FILE [--language python|typescript ...] [--exclude DIR ...]
                          [--allow-partial] [--fields minimal] [--verbose]
       bundle_fallback.py --probe        (print the capability JSON and exit)

The argv is the CODE-BUNDLE-CLI-1 `smartmemory code bundle` argv (design.md, Interface), so Compose builds one argv
for both producers (snapshot.js bundleArgv). This file goes away once that command ships (plan.md AC).

Exit codes: 0 written, 2 usage, 3 smartmemory missing or too old (no store-free CodeIndexer.parse), 4 preparation refused.
"""
import argparse
import hashlib
import json
import logging
import os
import subprocess
import sys
import time
from dataclasses import asdict

sys.dont_write_bytecode = True
SCHEMA_VERSION = "1"


def _git(root, *args):
    try:
        done = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout if done.returncode == 0 else None


def _sm_version():
    from importlib import metadata

    for dist in ("smartmemory-core", "smartmemory"):
        try:
            return metadata.version(dist)
        except metadata.PackageNotFoundError:
            continue
    import smartmemory

    return getattr(smartmemory, "__version__", None)


def probe():
    """Capability report. Never raises: a missing package is a report, not a crash."""
    out = {"python": sys.version.split()[0], "smartmemory": False, "version": None, "store_free_parse": False,
           "typescript_grammar": False}
    try:
        from smartmemory.code.indexer import CodeIndexer
    except Exception as exc:  # noqa: BLE001 - any import failure means unavailable
        out["error"] = f"{type(exc).__name__}: {exc}"
        return out
    out["smartmemory"] = True
    out["version"] = _sm_version()
    out["store_free_parse"] = callable(getattr(CodeIndexer, "parse", None))
    try:
        import tree_sitter_javascript  # noqa: F401
        import tree_sitter_typescript  # noqa: F401

        out["typescript_grammar"] = True
    except Exception:  # noqa: BLE001
        pass
    return out


def source_block(root, repo):
    head = (_git(root, "rev-parse", "HEAD") or "").strip()
    porcelain = _git(root, "status", "--porcelain", "--", ".")
    dirty = bool(porcelain and porcelain.strip())
    status_hash = hashlib.sha256((porcelain or "").encode()).hexdigest()
    fingerprint = hashlib.sha256(f"{head}\0{int(dirty)}\0{status_hash}".encode()).hexdigest()
    remote = (_git(root, "remote", "get-url", "origin") or "").strip()
    return {"head": head or None, "dirty": dirty, "fingerprint": fingerprint, "commit_hash": head,
            "repo_identity": remote or repo}


# --fields minimal. SmartMemory's CLI flag of the same name drops framework_evidence and clean parse_diagnostic (accepted
# by SM 2026-10-08). This adapter drops more: it keeps exactly the fields Compose reads, with the contract's names and
# shapes, so normalizeBundle reads a minimal and a full bundle the same way. Full forge compose is 248 MB of JSON; most
# of it is call/test evidence that duplicates relations, per-entity parse diagnostics, and relation `basis` prose.
RELATION_KEEP = ("resolution", "confidence", "unresolved", "callee", "line", "candidates", "module_resolution",
                 "receiver_status")
EDGE_STATES = ("resolved", "ambiguous", "unresolved", "unsupported")


def edge_state(props):
    """The snapshot `edge_state` of one relation or call/test evidence record, from SmartMemory's own fields.

    The single producer of CALLS / REFERENCES / TESTS-with-callee properties is core indexer.py:1141-1148 (read at
    9ad526cb): `resolution` is always "name_only", `unresolved = not candidates`, confidence 0.5 with candidates and
    0.0 without. Ambiguity and unsupported sites are not `resolution` values; they are `module_resolution` (binding
    status: ts_bindings.py:109-157, python_bindings.py:498-499 / PythonAwareBindings._python_resolve) and
    `receiver_status` ("resolved" only for one candidate under a resolved binding, else "ambiguous", ts_bindings.py:808;
    "unresolved" with a receiver_reason, indexer.py:1101,1114 and ts_bindings.py:731-765). The rules below are the
    CODE-BUNDLE-CLI-1 contract's derivation_for_consumers table (confidence_enum), with its `inferred` and reserved
    `exact` states both reported as "resolved". Derived here, in one place; Compose's JS never re-derives it.
    """
    candidates = props.get("candidates")
    if candidates is None and "resolution" not in props:
        # A structural edge (IMPORTS, DEFINES, INHERITS, a TESTS edge with no callee) carries no resolution: it joins
        # two indexed entities by construction.
        return "unresolved" if props.get("unresolved") is True else "resolved"
    if props.get("resolution") == "exact":
        return "resolved"
    candidates = candidates if isinstance(candidates, list) else []
    if not candidates or props.get("unresolved") is True:
        if props.get("module_resolution") == "unsupported" or props.get("receiver_status") == "unresolved":
            return "unsupported"
        return "unresolved"
    if len(candidates) > 1 or "ambiguous" in (props.get("module_resolution"), props.get("receiver_status")):
        return "ambiguous"
    return "resolved"


def stamp_edge_states(bundle):
    """Every relation, and every call/test evidence record, carries `edge_state` (snapshot amendment, SM 2026-10-08)."""
    for row in bundle["relations"]:
        row["edge_state"] = edge_state(row.get("properties") or {})
    for entity in bundle["entities"]:
        for key in ("call_evidence", "test_evidence"):
            for ev in entity.get(key) or []:
                ev["edge_state"] = edge_state(ev.get("properties") or {})


def _slim_relation(row):
    props = row.get("properties") or {}
    kept = {k: props[k] for k in RELATION_KEEP if k in props}
    if isinstance(kept.get("candidates"), list):
        kept["candidates"] = kept["candidates"][:5]  # edge_state is stamped before this, from the full list
    return {"source_id": row["source_id"], "target_id": row["target_id"], "relation_type": row["relation_type"],
            "properties": kept, "edge_state": row["edge_state"]}


def slim_bundle(bundle):
    ids = {e["item_id"] for e in bundle["entities"]}
    for entity in bundle["entities"]:
        entity.pop("source_snapshot", None)
        entity.pop("framework_evidence", None)
        diag = entity.get("parse_diagnostic") or {}
        if diag.get("status") == "clean":
            entity.pop("parse_diagnostic", None)  # as SM's --fields minimal: an absent diagnostic means clean
        else:
            entity["parse_diagnostic"] = {k: diag.get(k) for k in ("status", "failure_class")}
        for key in ("call_evidence", "test_evidence"):
            # Evidence that is also a graph relation is redundant; keep what the graph cannot traverse. The owner is
            # the entity itself and an unresolved target id is synthetic, so slim evidence drops both ids.
            entity[key] = [{"relation_type": ev["relation_type"], "properties": _slim_relation(ev)["properties"],
                            "edge_state": ev["edge_state"]}
                           for ev in entity.get(key) or []
                           if (ev.get("properties") or {}).get("unresolved") or ev.get("target_id") not in ids]
    bundle["relations"] = [_slim_relation(r) for r in bundle["relations"]]
    summary = bundle.get("parse_summary") or {}
    if isinstance(summary.get("diagnostics"), list):
        summary["diagnostics"] = [{k: d.get(k) for k in ("file_path", "status", "failure_class")}
                                  for d in summary["diagnostics"]]
    return bundle


SKIP_PREFIX = "Extraction skipped for "
# record_run_exhaustion (core budgets.py:153-181) writes this hint into its one summary error in both arms.
RUN_BUDGET_HINT = "Raise SMARTMEMORY_CODE_MAX_RUN_ENTITIES to index this checkout."
GRAMMAR_MISSING = "tree-sitter not installed"  # ts_parser.py:160-162, the ImportError arm of TSParser.parse_file
GRAMMAR_UNAVAILABLE = "grammar_unavailable"  # the CLI's skip reason for it (sm-scanner, 2026-10-08)


def skip_report(result):
    """`files_skipped`, `skipped_paths` and `budget_exhausted` (snapshot amendment) from an IndexResult.

    Core records every policy skip with budgets.record_skip (budgets.py:139-147): `files_skipped += 1` and the message
    "Extraction skipped for <path>: <reason>" appended to `result.errors` after the failures (indexer.py:465). Policy
    skips are oversize and generated-pattern files (source_guard), per-file entity budgets (file_entity_guard),
    escaping symlinks (indexer.py:340-342), and a default-language TS/JS file that failed to extract (indexer.py:430-
    442), which is how missing TS/JS grammars show up (that reason becomes `grammar_unavailable`, the CLI's reason code). A spent run entity budget
    (record_run_exhaustion) counts every file it did not reach in `files_skipped` but names only the first; it sets
    `budget_exhausted`, and the consumer treats the whole snapshot as partial coverage.
    """
    skipped_paths = []
    for message in result.errors:
        if not message.startswith(SKIP_PREFIX):
            continue
        path, _, reason = message[len(SKIP_PREFIX):].partition(": ")
        if GRAMMAR_MISSING in reason:
            reason = GRAMMAR_UNAVAILABLE
        skipped_paths.append({"path": path, "reason": reason})
    budget_exhausted = any(RUN_BUDGET_HINT in message for message in result.errors)
    return {"files_skipped": int(result.files_skipped or 0), "skipped_paths": skipped_paths,
            "budget_exhausted": budget_exhausted}


def entity_languages(entities):
    """Languages that produced at least one entity, JS folded into typescript (contract top_level.languages)."""
    found = set()
    for entity in entities:
        ext = os.path.splitext(entity.file_path)[1].lower()
        if ext == ".py":
            found.add("python")
        elif ext in (".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"):
            found.add("typescript")
    return sorted(found)


def build(args):
    from smartmemory.code.indexer import CodeIndexer

    if not callable(getattr(CodeIndexer, "parse", None)):
        print(json.dumps({"ok": False, "error": "installed smartmemory has no store-free CodeIndexer.parse",
                          "version": _sm_version()}), file=sys.stderr)
        return 3
    root = os.path.abspath(args.path)
    # No --language: SmartMemory's default set, in which a TS/JS file that fails to extract is a skip, not a refusal
    # (indexer.py:270-272). An explicit --language keeps core's refusal, as the CLI does.
    languages = args.language or None
    source = source_block(root, args.repo)
    # Caller excludes are additive to SmartMemory's own defaults (core ExcludePolicy.build, U4 82f52990).
    excludes = set(args.exclude)
    indexer = CodeIndexer(graph=None, repo=args.repo, repo_root=root, exclude_dirs=excludes or None,
                          commit_hash=source["commit_hash"])
    started = time.monotonic()
    # prepare_bundle() is the hosted-upload preparer: it also enforces the 64 MiB request-body cap
    # (MAX_REQUEST_BODY_BYTES), which forge's stratum/ts exceeds with zero failed files (measured 2026-10-08).
    # A local snapshot is not an upload, so this mirrors prepare_bundle's checks minus the transport cap:
    # refuse failed files (unless --allow-partial), refuse paths that escape the checkout, and keep only
    # relations whose two ends are indexed.
    result, relations = indexer.parse(languages)
    skips = skip_report(result)
    failures = [message for message in result.errors if not message.startswith(SKIP_PREFIX)]
    complete, failed_paths = not result.files_failed, failures if result.files_failed else []
    if not complete and not args.allow_partial:
        print(json.dumps({"ok": False, "error": f"{result.files_failed} failed file(s)", "failed_paths": failed_paths}),
              file=sys.stderr)
        return 4
    for entity in result.entities:
        if os.path.isabs(entity.file_path) or ".." in entity.file_path.replace("\\", "/").split("/"):
            print(json.dumps({"ok": False, "error": f"source escapes checkout: {entity.file_path}"}), file=sys.stderr)
            return 4
    ids = {e.item_id for e in result.entities}
    entities = []
    for entity in result.entities:
        row = asdict(entity)
        row["item_id"] = entity.item_id  # asdict() drops the item_id property
        entities.append(row)
    bundle = {"repo": args.repo, "entities": entities,
              "relations": [asdict(r) for r in relations if r.source_id in ids and r.target_id in ids],
              "commit_hash": source["commit_hash"], "parse_summary": result.parse_summary()}
    stamp_edge_states(bundle)
    minimal = args.fields == "minimal"
    if minimal:
        slim_bundle(bundle)
    envelope = {"schema_version": SCHEMA_VERSION, "languages": entity_languages(result.entities),
                "generator": {"smartmemory_version": _sm_version(), "core_sha": None,
                              "producer": "compose/lib/codegraph/bundle_fallback.py",
                              "fields": "minimal" if minimal else "full"},
                "source": source, "complete": complete, "failed_paths": failed_paths, **skips, **bundle}
    tmp = f"{args.out}.tmp.{os.getpid()}"
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(envelope, handle, ensure_ascii=False)
        os.replace(tmp, args.out)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    print(json.dumps({"ok": True, "entities": len(bundle["entities"]), "relations": len(bundle["relations"]),
                      "complete": complete, "files_skipped": skips["files_skipped"],
                      "budget_exhausted": skips["budget_exhausted"], "seconds": round(time.monotonic() - started, 3)}))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("path", nargs="?", help="checkout to index")
    parser.add_argument("--repo")
    parser.add_argument("--out")
    parser.add_argument("--language", action="append", choices=("python", "typescript", "javascript"),
                        help="language group to index (repeatable; default: SmartMemory's default set)")
    parser.add_argument("--allow-partial", action="store_true")
    parser.add_argument("--exclude", action="append", default=[], help="extra directory name to skip (repeatable)")
    parser.add_argument("--fields", choices=("full", "minimal"), default="full",
                        help="minimal: keep only the fields Compose reads (see RELATION_KEEP)")
    parser.add_argument("--verbose", action="store_true", help="keep SmartMemory's per-call WARNING log lines")
    args = parser.parse_args(argv)
    if args.probe:
        print(json.dumps(probe()))
        return 0
    if not (args.path and args.repo and args.out):
        parser.print_usage(sys.stderr)
        return 2
    # SmartMemory logs one WARNING per unresolved import/call (10 MB of stderr on forge compose); keep errors only.
    logging.basicConfig(level=logging.WARNING if args.verbose else logging.ERROR, stream=sys.stderr)
    try:
        import smartmemory.code.indexer  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"smartmemory not importable: {exc}"}), file=sys.stderr)
        return 3
    return build(args)


if __name__ == "__main__":
    sys.exit(main())
