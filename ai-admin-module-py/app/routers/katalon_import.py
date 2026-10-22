"""
--- Katalon Import ----------------------------------------------------------------

Upload what the QA team exports from Katalon (converted test cases, Object
Repository, test data, keywords, profile), and get back: findings, a draft
Automation KB (components + flow + profile), a manual test case per data row,
and Playwright/Katalon scripts built from the same steps, with a conformance
check that they match. See services/katalon_import.

Self-contained: imports live in their own storage folder; the only write into
another module is a DRAFT Automation KB change set, approved on the Knowledge
Base page.
"""
from __future__ import annotations

import re
from typing import List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..database.connection import get_db
from ..services.authz import require_permission
from ..services.katalon_import import generate, publish, store

PERM_VIEW = "automation.view"
PERM_EXECUTE = "automation.execute"
MAX_UPLOAD_BYTES = 150 * 1024 * 1024
_KEY = re.compile(r"^[a-z0-9][a-z0-9_-]{1,99}$")

router = APIRouter()


def _user(current_user) -> Optional[str]:
    return (current_user or {}).get("username") if isinstance(current_user, dict) else getattr(current_user, "username", None)


def _guard(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except store.ImportError_ as exc:
        raise HTTPException(status_code=404 if "No such import" in str(exc) else 400, detail=str(exc)) from exc


def _detail(import_id: str) -> dict:
    meta = _guard(store.meta, import_id)
    return {"meta": meta, "result": store.result(import_id)}


def _download(content: bytes, name: str, media: str) -> Response:
    return Response(content=content, media_type=media, headers={"Content-Disposition": f'attachment; filename="{name}"'})


# --- Imports ----------------------------------------------------------------------------

class ImportCreate(BaseModel):
    name: str = Field(default="", max_length=200)


class ImportUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=200)
    app_key: Optional[str] = Field(default=None, max_length=100)
    app_name: Optional[str] = Field(default=None, max_length=200)


@router.get("/imports")
def list_imports(current_user=Depends(require_permission(PERM_VIEW))):
    return {"items": store.list_imports()}


@router.post("/imports", status_code=201)
def create_import(body: ImportCreate, current_user=Depends(require_permission(PERM_EXECUTE))):
    return store.create(body.name or "Katalon import", _user(current_user))


@router.get("/imports/{import_id}")
def get_import(import_id: str, current_user=Depends(require_permission(PERM_VIEW))):
    return _detail(import_id)


@router.patch("/imports/{import_id}")
def update_import(import_id: str, body: ImportUpdate, current_user=Depends(require_permission(PERM_EXECUTE))):
    with store.lock(import_id):
        meta = _guard(store.meta, import_id)
        if body.name is not None and body.name.strip():
            meta["name"] = body.name.strip()
        if body.app_key is not None:
            key = body.app_key.strip().lower()
            if key and not _KEY.match(key):
                raise HTTPException(status_code=400, detail="The KB key is 2-100 lower-case letters, digits, '_' or '-'.")
            meta["app_key"] = key or None
        if body.app_name is not None:
            meta["app_name"] = body.app_name.strip() or None
        store.save_meta(import_id, meta)
        if meta.get("status") in ("analysed", "uploaded") and any(f.get("kind") for f in meta.get("files") or []):
            store.run(import_id)
    return _detail(import_id)


@router.delete("/imports/{import_id}")
def delete_import(import_id: str, current_user=Depends(require_permission(PERM_EXECUTE))):
    _guard(store.folder, import_id)
    store.delete(import_id)
    return {"deleted": import_id}


@router.post("/imports/{import_id}/files")
async def upload_files(import_id: str, files: List[UploadFile] = File(...),
                       current_user=Depends(require_permission(PERM_EXECUTE))):
    _guard(store.folder, import_id)
    uploads, total = [], 0
    for f in files:
        data = await f.read()
        total += len(data)
        if total > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="The upload is over 150 MB.")
        uploads.append((f.filename or "upload", data))
    with store.lock(import_id):
        _guard(store.add_files, import_id, uploads)
        try:
            store.run(import_id)
        except Exception as exc:  # noqa: BLE001 - the files are kept; the reason goes to the screen
            meta = store.meta(import_id)
            meta.update(status="failed", error=str(exc))
            store.save_meta(import_id, meta)
            raise HTTPException(status_code=500, detail=f"The files were saved but could not be analysed: {exc}") from exc
    return _detail(import_id)


@router.delete("/imports/{import_id}/files")
def remove_file(import_id: str, path: str = Query(...), current_user=Depends(require_permission(PERM_EXECUTE))):
    with store.lock(import_id):
        _guard(store.remove_file, import_id, path)
        store.run(import_id)
    return _detail(import_id)


@router.post("/imports/{import_id}/analyse")
def analyse(import_id: str, current_user=Depends(require_permission(PERM_EXECUTE))):
    with store.lock(import_id):
        _guard(store.run, import_id)
    return _detail(import_id)


# --- Cases and scripts --------------------------------------------------------------------

def _case(import_id: str, case_id: str) -> tuple[dict, dict, dict]:
    result = store.result(import_id)
    if not result:
        raise HTTPException(status_code=404, detail="This import has not been analysed yet.")
    case = next((c for c in store.cases(import_id) if c["case_id"] == case_id), None)
    if case is None:
        raise HTTPException(status_code=404, detail="No such test case in this import.")
    model = result["models"][case["model"]]
    return case, model, model["test_case"]


@router.get("/imports/{import_id}/cases/{case_id}")
def get_case(import_id: str, case_id: str, current_user=Depends(require_permission(PERM_VIEW))):
    case, model, meta = _case(import_id, case_id)
    playwright = generate.playwright_spec(case, model, meta)
    katalon = generate.katalon_script(case, model, meta)
    return {
        "case_id": case["case_id"], "title": case["title"], "status": case["status"], "problems": case["problems"],
        "row": case["row"], "steps": generate.manual_rows(case, model),
        "scripts": {"playwright": playwright, "katalon": katalon},
        "conformance": {"playwright": generate.conformance(case, playwright, "playwright"),
                        "katalon": generate.conformance(case, katalon, "katalon")},
    }


class ScriptCheck(BaseModel):
    framework: str = Field(pattern="^(playwright|katalon)$")
    script: str = Field(max_length=5_000_000)


@router.post("/imports/{import_id}/cases/{case_id}/conformance")
def check_script(import_id: str, case_id: str, body: ScriptCheck, current_user=Depends(require_permission(PERM_VIEW))):
    """An edited script against its test case: same steps, same order, same locators."""
    case, _, _ = _case(import_id, case_id)
    return generate.conformance(case, body.script, body.framework)


def _chosen(import_id: str, status: str, ids: Optional[str]) -> tuple[list[dict], dict]:
    result = store.result(import_id)
    if not result:
        raise HTTPException(status_code=404, detail="This import has not been analysed yet.")
    every = store.cases(import_id)
    if ids:
        wanted = {i.strip() for i in ids.split(",") if i.strip()}
        chosen = [c for c in every if c["case_id"] in wanted]
    elif status == "all":
        chosen = every
    else:
        chosen = [c for c in every if c["status"] == status]
    if not chosen:
        raise HTTPException(status_code=400, detail="No test cases match. Pick cases or another status.")
    return chosen, result


@router.get("/imports/{import_id}/download/test-cases.xlsx")
def download_cases(import_id: str, status: str = Query("ready"), ids: Optional[str] = Query(None),
                   current_user=Depends(require_permission(PERM_VIEW))):
    chosen, result = _chosen(import_id, status, ids)
    return _download(publish.cases_xlsx(chosen, result["models"]), f"{import_id}-test-cases.xlsx",
                     "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@router.get("/imports/{import_id}/download/scripts.zip")
def download_scripts(import_id: str, status: str = Query("ready"), ids: Optional[str] = Query(None),
                     frameworks: str = Query("playwright,katalon"), current_user=Depends(require_permission(PERM_VIEW))):
    chosen, result = _chosen(import_id, status, ids)
    wanted = [f for f in frameworks.split(",") if f in ("playwright", "katalon")] or ["playwright"]
    content, _ = publish.scripts_zip(chosen, result["models"], [m["test_case"] for m in result["models"]], wanted)
    return _download(content, f"{import_id}-scripts.zip", "application/zip")


@router.get("/imports/{import_id}/download/kb.zip")
def download_kb(import_id: str, current_user=Depends(require_permission(PERM_VIEW))):
    result = store.result(import_id)
    if not result:
        raise HTTPException(status_code=404, detail="This import has not been analysed yet.")
    key = result["kb"]["app_profile.json"]["app_id"]
    return _download(publish.kb_zip(result["kb"]), f"{key}-automation-kb.zip", "application/zip")


@router.get("/imports/{import_id}/download/report.md")
def download_report(import_id: str, current_user=Depends(require_permission(PERM_VIEW))):
    result = store.result(import_id)
    if not result:
        raise HTTPException(status_code=404, detail="This import has not been analysed yet.")
    meta = store.meta(import_id)
    return _download(publish.report_markdown(meta, result).encode("utf-8"), f"{import_id}-report.md", "text/markdown")


# --- Into the Knowledge Base ------------------------------------------------------------------

class ChangeSetIn(BaseModel):
    app_key: str = Field(min_length=2, max_length=100)
    app_name: str = Field(min_length=1, max_length=200)


@router.post("/imports/{import_id}/kb-change-set", status_code=201)
def kb_change_set(import_id: str, body: ChangeSetIn, db: Session = Depends(get_db),
                  current_user=Depends(require_permission(PERM_EXECUTE))):
    key = body.app_key.strip().lower()
    if not _KEY.match(key):
        raise HTTPException(status_code=400, detail="The KB key is 2-100 lower-case letters, digits, '_' or '-'.")
    with store.lock(import_id):
        meta = _guard(store.meta, import_id)
        meta.update(app_key=key, app_name=body.app_name.strip())
        store.save_meta(import_id, meta)
        result = store.run(import_id)
        try:
            cs_id = publish.draft_change_set(db, app_key=key, files=result["kb"], actor=_user(current_user),
                                             title=f"Katalon import: {meta['name']}", import_id=import_id)
        except Exception as exc:  # noqa: BLE001 - a change set that does not apply says why
            raise HTTPException(status_code=400, detail=f"The draft could not be made: {exc}") from exc
        meta = store.meta(import_id)
        meta.setdefault("change_sets", []).append({"id": cs_id, "app_key": key, "at": store._now(), "by": _user(current_user)})
        store.save_meta(import_id, meta)
    return {"change_set_id": cs_id, "app_key": key}
