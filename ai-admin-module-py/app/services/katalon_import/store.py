"""Imports on disk, and the run that turns their files into a result.

  <storage>/katalon_import/<id>/
    meta.json            name, who, when, the files and what each was recognised as
    inputs/...           the uploads, unpacked (nested zips too) -- except profiles
    profiles/<n>.json    each .glbl reduced to names, kinds and non-secret values
    result.json          analysis, model, KB draft, case list
    cases.json           every built case with its steps

No database table: an import is self-contained and deleting it is removing its folder.
"""
from __future__ import annotations

import io
import json
import re
import secrets
import shutil
import threading
import zipfile
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any, Optional

from ..automation import workspace as ws
from . import analysis, generate, model, parse

MAX_UNPACKED_BYTES = 300 * 1024 * 1024
MAX_FILES = 5000
MAX_DEPTH = 3
_ID = re.compile(r"^imp-\d{8}-\d{6}-[0-9a-f]{4}$")
_locks: dict[str, threading.Lock] = {}


class ImportError_(ValueError):
    """An upload or import that cannot be processed as asked."""


def root() -> Path:
    path = ws.storage_root() / "katalon_import"
    path.mkdir(parents=True, exist_ok=True)
    return path


def folder(import_id: str) -> Path:
    if not _ID.match(import_id or ""):
        raise ImportError_("No such import.")
    path = root() / import_id
    if not path.exists():
        raise ImportError_("No such import.")
    return path


def lock(import_id: str) -> threading.Lock:
    return _locks.setdefault(import_id, threading.Lock())


def _now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def _read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


# --- Recognising files -----------------------------------------------------------------

def classify(rel: str, data: bytes) -> Optional[str]:
    name = rel.lower()
    head = data[:4000].decode("utf-8", errors="ignore")
    if name.endswith(".md") and ("## Steps" in data.decode("utf-8", errors="ignore") or "Katalon test case" in head):
        return "converter_md"
    if name.endswith(".rs") and "<WebElementEntity" in head:
        return "object_repository"
    if name.endswith(".dat") and "<DataFileEntity" in head:
        return "test_data"
    if name.endswith((".csv", ".xlsx")):
        return "test_data"
    if name.endswith(".glbl") and "GlobalVariableEntity" in data.decode("utf-8", errors="ignore"):
        return "profile"
    if name.endswith(".groovy"):
        text = data.decode("utf-8", errors="ignore")
        if "@Keyword" in text or "/keywords/" in "/" + name or name.startswith("keywords/"):
            return "keywords"
        return "scripts"
    return None


def _safe_rel(rel: str) -> str:
    parts = [p for p in PurePosixPath(rel.replace("\\", "/")).parts if p not in ("", ".", "..", "/")]
    return "/".join(re.sub(r"[^\w .()\-]", "_", p) for p in parts) or "file"


def expand(name: str, data: bytes, depth: int = 0, budget: Optional[list[int]] = None) -> list[tuple[str, bytes]]:
    """A file, or every file inside a (nested) zip, with zip-bomb limits."""
    budget = budget if budget is not None else [MAX_UNPACKED_BYTES, MAX_FILES]
    if not name.lower().endswith(".zip"):
        return [(_safe_rel(name), data)]
    if depth >= MAX_DEPTH:
        raise ImportError_(f"{name}: zips nested more than {MAX_DEPTH} deep.")
    out: list[tuple[str, bytes]] = []
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ImportError_(f"{name} is not a readable zip.") from exc
    prefix = re.sub(r"\.zip$", "", _safe_rel(name), flags=re.I)
    for info in archive.infolist():
        if info.is_dir() or info.filename.startswith("__MACOSX/"):
            continue
        budget[0] -= info.file_size
        budget[1] -= 1
        if budget[0] < 0 or budget[1] < 0:
            raise ImportError_("The upload unpacks to more than 300 MB or 5,000 files.")
        inner = archive.read(info)
        out.extend(expand(f"{prefix}/{info.filename}", inner, depth + 1, budget))
    return out


# --- Imports ---------------------------------------------------------------------------

def create(name: str, actor: Optional[str]) -> dict:
    import_id = f"imp-{datetime.utcnow():%Y%m%d-%H%M%S}-{secrets.token_hex(2)}"
    meta = {"id": import_id, "name": name.strip() or import_id, "created_by": actor, "created_at": _now(),
            "updated_at": _now(), "files": [], "status": "empty", "app_key": None, "app_name": None,
            "change_sets": [], "error": None}
    _write_json(root() / import_id / "meta.json", meta)
    return meta


def meta(import_id: str) -> dict:
    return _read_json(folder(import_id) / "meta.json", {})


def save_meta(import_id: str, value: dict) -> dict:
    value["updated_at"] = _now()
    _write_json(folder(import_id) / "meta.json", value)
    return value


def list_imports() -> list[dict]:
    items = []
    for path in sorted(root().iterdir(), reverse=True):
        m = _read_json(path / "meta.json")
        if m and _ID.match(m.get("id", "")):
            result = _read_json(path / "result.json", {}) or {}
            items.append({**{k: m.get(k) for k in ("id", "name", "created_by", "created_at", "updated_at", "status", "app_key", "app_name")},
                          "files": len(m.get("files") or []), "summary": (result.get("analysis") or {}).get("summary")})
    return items


def add_files(import_id: str, uploads: list[tuple[str, bytes]]) -> dict:
    base = folder(import_id)
    m = meta(import_id)
    known = {f["path"]: f for f in m.get("files") or []}
    for upload_name, data in uploads:
        for rel, content in expand(upload_name, data):
            kind = classify(rel, content)
            entry = {"path": rel, "kind": kind, "size": len(content), "from": upload_name, "added_at": _now()}
            if kind == "profile":
                try:
                    profile = parse.parse_profile(content.decode("utf-8", errors="replace"), rel.rsplit("/", 1)[-1])
                except Exception as exc:  # noqa: BLE001 - reported per file
                    entry.update(kind=None, note=f"Not a readable profile: {exc}")
                else:
                    counts = {k: sum(1 for v in profile["variables"] if v["kind"] == k) for k in ("secret", "user")}
                    entry.update(note=f"Secrets dropped on read: {counts['secret']} secret and {counts['user']} user-name values were not stored.",
                                 dropped=counts)
                    _write_json(base / "profiles" / (_safe_rel(rel).replace("/", "__") + ".json"), profile)
                known[rel] = entry
                continue
            if kind is None:
                entry["note"] = "Not a Katalon export file; ignored."
                known[rel] = entry
                continue
            target = base / "inputs" / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            known[rel] = entry
    m["files"] = sorted(known.values(), key=lambda f: (f["kind"] or "~", f["path"]))
    m["status"] = "uploaded"
    return save_meta(import_id, m)


def remove_file(import_id: str, rel: str) -> dict:
    base = folder(import_id)
    m = meta(import_id)
    entry = next((f for f in m.get("files") or [] if f["path"] == rel), None)
    if entry is None:
        raise ImportError_("No such file in this import.")
    if entry["kind"] == "profile":
        (base / "profiles" / (_safe_rel(rel).replace("/", "__") + ".json")).unlink(missing_ok=True)
    else:
        (base / "inputs" / rel).unlink(missing_ok=True)
    m["files"] = [f for f in m["files"] if f["path"] != rel]
    return save_meta(import_id, m)


def delete(import_id: str) -> None:
    shutil.rmtree(folder(import_id), ignore_errors=True)


# --- The run ------------------------------------------------------------------------------

def _key_column(table: Optional[dict], key: Optional[str]) -> Optional[str]:
    if not table:
        return None
    if key:
        for col in table["columns"]:
            if any(r.get(col) == key for r in table["rows"]):
                return col
    return table["columns"][0] if table["columns"] else None


def _merge_profiles(base: Path) -> Optional[dict]:
    profiles = [_read_json(p) for p in sorted((base / "profiles").glob("*.json"))] if (base / "profiles").exists() else []
    profiles = [p for p in profiles if p]
    if not profiles:
        return None
    merged: dict[str, dict] = {}
    for p in profiles:
        for v in p["variables"]:
            merged[v["name"]] = v
    return {"name": ", ".join(p["name"] for p in profiles), "variables": list(merged.values())}


def run(import_id: str) -> dict:
    """Parse everything, build the model and every case, analyse. Writes result.json and cases.json."""
    base = folder(import_id)
    m = meta(import_id)
    files = [f for f in m.get("files") or [] if f.get("kind")]
    mds, repository, tables, keyword_classes, notes = [], [], [], [], []
    for f in files:
        path = base / "inputs" / f["path"]
        if f["kind"] == "profile" or not path.exists():
            continue
        try:
            if f["kind"] == "converter_md":
                md = parse.parse_converter_md(path.read_text(encoding="utf-8", errors="replace"))
                md["file"] = f["path"]
                mds.append(md)
            elif f["kind"] == "object_repository":
                item = parse.parse_object_repository(f["path"], path.read_text(encoding="utf-8", errors="replace"))
                if item:
                    repository.append(item)
            elif f["kind"] == "test_data":
                if f["path"].lower().endswith(".dat"):
                    tables.append(parse.parse_katalon_dat(path.read_text(encoding="utf-8", errors="replace")))
                elif f["path"].lower().endswith(".csv"):
                    tables.append(parse.parse_csv_data(path.read_text(encoding="utf-8-sig", errors="replace"), path.stem))
                else:
                    tables.extend(parse.parse_xlsx_data(path.read_bytes(), path.stem))
            elif f["kind"] == "keywords":
                keyword_classes.append(parse.parse_groovy_keywords(f["path"], path.read_text(encoding="utf-8", errors="replace")))
        except Exception as exc:  # noqa: BLE001 - one bad file must not stop the rest
            notes.append({"file": f["path"], "error": str(exc)})
    profile = _merge_profiles(base)
    profile_values = {v["name"]: v.get("value") for v in (profile or {}).get("variables") or [] if v.get("kind") in ("url", "setting")}

    # Exports of the same Katalon test case (e.g. printed for different data rows) are one
    # test case: the best export is primary and the others fill the branches it skipped.
    groups: dict[str, list[dict]] = {}
    for md in mds:
        groups.setdefault(md.get("katalon_test_case") or md.get("title") or md["file"], []).append(md)
    exports: list[dict] = []
    merged_mds = []
    for group in groups.values():
        md, report = model.merge_exports(group)
        merged_mds.append(md)
        exports.extend({**r, "test_case": md.get("title")} for r in report)
    mds = merged_mds

    models, cases = [], []
    for index, md in enumerate(mds):
        ctx = model.make_context(md, repository, keyword_classes, profile)
        built = model.build_model(ctx)
        built["test_case"] = {k: md.get(k) for k in ("title", "katalon_test_case", "script", "data_sheet", "data_key", "file", "format")}
        built["index"] = index
        table = next((t for t in tables if t["name"] == md.get("data_sheet")), None) or (tables[0] if len(tables) == 1 else None)
        key_col = _key_column(table, md.get("data_key"))
        rows = table["rows"] if table else [{v["column"]: ("" if "masked" in v["example"] else v["example"]) for v in md.get("data_vars") or []}]
        built["data"] = {"table": table["name"] if table else None, "key_column": key_col, "rows": len(rows)}
        models.append(built)
        for row in rows:
            case = generate.build_case(built, row, key_column=key_col, title=md.get("title") or "Test case", profile_values=profile_values)
            case["model"] = index
            case["case_id"] = f"{case['case_id']}" if len(mds) == 1 else f"{slug_tc(md)}:{case['case_id']}"
            cases.append(case)

    dropped = {"secret": 0, "user": 0, "file": None}
    for f in m.get("files") or []:
        if f.get("kind") == "profile" and f.get("dropped"):
            dropped["secret"] += f["dropped"].get("secret", 0)
            dropped["user"] += f["dropped"].get("user", 0)
            dropped["file"] = f["path"]
    report = analysis.analyse(inputs=files, mds=mds, models=models, repository=repository, tables=tables, profile=profile,
                              keyword_classes=keyword_classes, cases=cases, secrets_dropped=dropped)
    for n in notes:
        report["findings"].insert(0, {"id": f"R{len(report['findings']) + 1}", "severity": "medium", "category": "inputs",
                                      "title": f"Could not read {n['file']}", "detail": n["error"], "action": "Check the file and upload it again."})
    for e in exports:
        if e["role"] == "branch_source":
            filled = "; ".join(f"'{b['expr']}' ({b['steps']} steps)" for b in e["branches"])
            report["findings"].append({"id": f"M{len(report['findings']) + 1}", "severity": "info", "category": "inputs",
                                       "title": f"{e['file']} filled {len(e['branches'])} branch(es) of {e['test_case']}",
                                       "detail": f"Exported for row {e.get('data_key') or '?'}; it supplied {filled}.",
                                       "action": "No action; rows that take these branches are now complete."})
        elif e["role"] == "superseded":
            report["findings"].append({"id": f"M{len(report['findings']) + 1}", "severity": "info", "category": "inputs",
                                       "title": f"{e['file']} adds nothing new",
                                       "detail": f"Another export of {e['test_case']} for the same branches is used instead (it has the locators or more steps).",
                                       "action": "You can remove this file; it is kept only for its locators, if any."})
    report["summary"]["findings"] = {s: sum(1 for f in report["findings"] if f["severity"] == s)
                                     for s in ("high", "medium", "info") if any(f["severity"] == s for f in report["findings"])}
    from . import publish

    result = {
        "generated_at": _now(), "analysis": report, "models": models, "profile_values": profile_values, "exports": exports,
        "kb": publish.kb_files(models, mds, profile, tables, app_key=m.get("app_key") or suggest_key(mds, profile),
                               app_name=m.get("app_name") or suggest_name(mds, profile)),
        "cases": [{k: c[k] for k in ("case_id", "title", "status", "problems", "model")} | {"steps": len(c["steps"])} for c in cases],
        "suggested": {"app_key": suggest_key(mds, profile), "app_name": suggest_name(mds, profile)},
    }
    _write_json(base / "result.json", result)
    _write_json(base / "cases.json", cases)
    m["status"] = "analysed"
    m["error"] = None
    save_meta(import_id, m)
    return result


def slug_tc(md: dict) -> str:
    raw = (md.get("katalon_test_case") or md.get("title") or "tc").rsplit("/", 1)[-1]
    return model.slug(raw)[:40]


def suggest_key(mds: list[dict], profile: Optional[dict]) -> str:
    # The team's own name for the application (USP) wins over the URL's (cim).
    for md in mds:
        found = re.search(r"\b(?:Launch USP|USP\w*Tab|uspTestObjects)\b", json.dumps(md.get("steps") or [])[:50000], re.I)
        if found:
            return "usp"
    url = next((v.get("value") for v in (profile or {}).get("variables") or [] if v["name"] == "appUrl"), None) or ""
    host = re.sub(r"^https?://", "", url).split("/")[0].split(".")[0]
    path = re.search(r"https?://[^/]+/([\w-]+)", url)
    if path:
        return model.slug(path.group(1))[:40] or "katalon_app"
    if host:
        return model.slug(host)[:40]
    for md in mds:
        m = re.search(r"\b(usp|cim)\b", (md.get("title") or "") + " " + json.dumps(md.get("steps") or [])[:20000], re.I)
        if m:
            return m.group(1).lower()
    return "katalon_app"


def suggest_name(mds: list[dict], profile: Optional[dict]) -> str:
    key = suggest_key(mds, profile)
    return {"cim": "USP (CIM)", "usp": "USP (Unified Sales Portal)"}.get(key, key.replace("_", " ").title())


def result(import_id: str) -> Optional[dict]:
    return _read_json(folder(import_id) / "result.json")


def cases(import_id: str) -> list[dict]:
    return _read_json(folder(import_id) / "cases.json", []) or []
