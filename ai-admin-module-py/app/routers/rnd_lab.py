"""
--- AI R&D Lab ------------------------------------------------------------------

Per project: pick the approved automation cases, bring the sources (BRDs are
linked automatically from each case's review request; Figma and other documents
are uploaded), and map every step against each source. The result is an
evidence matrix per case and a list of the work still to do.

Independent by construction: its own rnd_ tables and storage folder, reads
other modules only through services/rnd_lab/sources.py, writes to none of
them. RND_LAB_ENABLED=false turns every endpoint here into a 404.
"""
from __future__ import annotations

import csv
import io
import shutil
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import settings
from ..database.connection import get_db
from ..models.rnd_lab import RndCaseMap, RndDocument, RndStudy
from ..services.authz import require_permission
from ..services.rnd_lab import analysis, documents, sources

PERM_VIEW = "automation.view"
PERM_EXECUTE = "automation.execute"


def _enabled() -> None:
    if not settings.RND_LAB_ENABLED:
        raise HTTPException(status_code=404, detail="The AI R&D Lab is turned off (RND_LAB_ENABLED).")


router = APIRouter(dependencies=[Depends(_enabled)])


def _user(current_user) -> Optional[str]:
    return (current_user or {}).get("username") if isinstance(current_user, dict) else getattr(current_user, "username", None)


def _study(db: Session, study_id: int) -> RndStudy:
    study = db.get(RndStudy, study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="No such study.")
    return study


def _iso(value):
    return value.isoformat() if value else None


def _study_brief(study: RndStudy) -> dict:
    summary = study.summary or {}
    return {
        "id": study.id, "name": study.name, "project_id": study.project_id, "ppm_id": study.ppm_id,
        "project_name": study.project_name, "kb_app_id": study.kb_app_id, "has_design": bool(study.has_design),
        "case_ids": study.case_ids, "status": study.status, "progress": study.progress, "error": study.error,
        "created_by": study.created_by, "created_at": _iso(study.created_at), "analysed_at": _iso(study.analysed_at),
        "cases": summary.get("cases"), "avg_readiness": summary.get("avg_readiness"),
    }


def _sweep(db: Session, study: RndStudy) -> None:
    if study.status == "analysing" and not analysis.is_running(study.id):
        study.status, study.error = "interrupted", "The analysis stopped (the server restarted). Run it again."
        db.commit()
    documents.sweep_stuck(db, study.id)


# --- Lookups ------------------------------------------------------------------------

@router.get("/status")
def status(current_user=Depends(require_permission(PERM_VIEW))):
    from ..services.automation.llm import provider_status

    try:
        llm = provider_status()
    except Exception as exc:  # noqa: BLE001
        llm = {"error": str(exc)}
    return {"enabled": True, "llm": llm, "vision_available": documents.vision_available(),
            "max_upload_mb": settings.RND_LAB_MAX_UPLOAD_MB, "roles": list(documents.ROLES)}


@router.get("/kb-apps")
def kb_apps(current_user=Depends(require_permission(PERM_VIEW))):
    return {"items": sources.kb_apps()}


@router.get("/projects/{project_id}/cases")
def project_cases(project_id: int, include_unassigned: bool = Query(False), db: Session = Depends(get_db),
                  current_user=Depends(require_permission(PERM_VIEW))):
    """The cases a study could take: approved and classified for automation."""
    project = sources.project(db, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="No such project.")
    cases = sources.approved_cases(db, project_id, include_unassigned=include_unassigned)
    scripts = sources.current_scripts(db, [c.id for c in cases])
    linked = sources.request_documents(db, {c.origin_request_id for c in cases if c.origin_request_id})
    return {
        "project": project,
        "items": [{
            "id": c.id, "display_id": c.display_id, "title": sources.case_title(c), "priority": c.priority,
            "steps": len(sources.case_steps(c)), "project_id": c.project_id, "request_id": c.origin_request_id,
            "has_brd": c.origin_request_id in linked,
            "script": ({k: v for k, v in scripts[c.id].items() if k != "code"} if c.id in scripts else None),
        } for c in cases],
    }


# --- Studies ------------------------------------------------------------------------

class StudyCreate(BaseModel):
    project_id: int
    name: str = Field(min_length=1, max_length=255)
    kb_app_id: Optional[str] = None
    case_ids: Optional[List[int]] = None
    has_design: bool = False


class StudyUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=255)
    kb_app_id: Optional[str] = None
    case_ids: Optional[List[int]] = None
    has_design: Optional[bool] = None
    clear_case_ids: bool = False


@router.get("/studies")
def list_studies(project_id: Optional[int] = Query(None), db: Session = Depends(get_db),
                 current_user=Depends(require_permission(PERM_VIEW))):
    query = db.query(RndStudy)
    if project_id is not None:
        query = query.filter(RndStudy.project_id == project_id)
    return {"items": [_study_brief(s) for s in query.order_by(RndStudy.id.desc()).limit(200)]}


@router.post("/studies", status_code=201)
def create_study(payload: StudyCreate, db: Session = Depends(get_db),
                 current_user=Depends(require_permission(PERM_EXECUTE))):
    project = sources.project(db, payload.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="No such project. Save the PPM ID and Project Name first.")
    username = _user(current_user)
    study = RndStudy(project_id=project["id"], ppm_id=project["ppm_id"], project_name=project["name"],
                     name=payload.name.strip(), kb_app_id=payload.kb_app_id or None,
                     case_ids=payload.case_ids, has_design=1 if payload.has_design else 0,
                     status="draft", created_by=username)
    db.add(study)
    db.commit()
    # Link the BRDs now, so the Sources panel shows them before any analysis.
    cases = sources.approved_cases(db, study.project_id, case_ids=study.case_ids)
    documents.sync_linked(db, study.id, sources.request_documents(db, {c.origin_request_id for c in cases if c.origin_request_id}), username)
    return _study_brief(study)


@router.get("/studies/{study_id}")
def get_study(study_id: int, db: Session = Depends(get_db), current_user=Depends(require_permission(PERM_VIEW))):
    study = _study(db, study_id)
    _sweep(db, study)
    docs = db.query(RndDocument).filter(RndDocument.study_id == study.id).order_by(RndDocument.id).all()
    maps = db.query(RndCaseMap).filter(RndCaseMap.study_id == study.id).all()
    return {
        **_study_brief(study),
        "summary": study.summary,
        "requirements": study.requirements or [],
        "documents": [documents.detail(d) for d in docs],
        "case_rows": sorted([{
            "test_case_id": m.test_case_id, "display_id": m.display_id, "title": m.title,
            "readiness": m.readiness, "verdict": m.verdict, "method": m.method,
            "steps": len(m.matrix or []), "gaps": len(m.gaps or []),
            "high_gaps": sum(1 for g in (m.gaps or []) if g.get("severity") == "high"),
            "script": m.script, "error": m.error, "analysed_at": _iso(m.analysed_at),
        } for m in maps], key=lambda c: (c["readiness"] if c["readiness"] is not None else 101, c["display_id"] or "")),
        # Every gap across the study, flat: the "work still to do" list.
        "work": [{**g, "test_case_id": m.test_case_id, "display_id": m.display_id}
                 for m in sorted(maps, key=lambda m: m.display_id or "") for g in (m.gaps or [])],
    }


@router.get("/studies/{study_id}/cases/{test_case_id}")
def get_case_map(study_id: int, test_case_id: int, db: Session = Depends(get_db),
                 current_user=Depends(require_permission(PERM_VIEW))):
    _study(db, study_id)
    row = db.query(RndCaseMap).filter_by(study_id=study_id, test_case_id=test_case_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="This case has not been analysed in this study.")
    return {"test_case_id": row.test_case_id, "display_id": row.display_id, "title": row.title,
            "readiness": row.readiness, "verdict": row.verdict, "method": row.method,
            "matrix": row.matrix or [], "gaps": row.gaps or [], "script": row.script,
            "error": row.error, "analysed_at": _iso(row.analysed_at)}


@router.patch("/studies/{study_id}")
def update_study(study_id: int, payload: StudyUpdate, db: Session = Depends(get_db),
                 current_user=Depends(require_permission(PERM_EXECUTE))):
    study = _study(db, study_id)
    if analysis.is_running(study.id):
        raise HTTPException(status_code=409, detail="Wait for the analysis to finish.")
    if payload.name is not None and payload.name.strip():
        study.name = payload.name.strip()
    if "kb_app_id" in payload.model_fields_set:
        study.kb_app_id = payload.kb_app_id or None
    if payload.clear_case_ids:
        study.case_ids = None
    elif payload.case_ids is not None:
        study.case_ids = payload.case_ids
    if payload.has_design is not None:
        study.has_design = 1 if payload.has_design else 0
    db.commit()
    return _study_brief(study)


@router.delete("/studies/{study_id}")
def delete_study(study_id: int, db: Session = Depends(get_db),
                 current_user=Depends(require_permission(PERM_EXECUTE))):
    """Removes the study's own rows and files -- nothing in any other module."""
    study = _study(db, study_id)
    if analysis.is_running(study.id):
        raise HTTPException(status_code=409, detail="Wait for the analysis to finish.")
    db.query(RndCaseMap).filter(RndCaseMap.study_id == study.id).delete()
    db.query(RndDocument).filter(RndDocument.study_id == study.id).delete()
    db.delete(study)
    db.commit()
    shutil.rmtree(documents.storage_dir(study_id), ignore_errors=True)
    return {"deleted": study_id}


# --- Documents ----------------------------------------------------------------------

@router.post("/studies/{study_id}/documents", status_code=201)
def upload_document(study_id: int, role: str = Form("figma"), file: UploadFile = File(...),
                    db: Session = Depends(get_db), current_user=Depends(require_permission(PERM_EXECUTE))):
    study = _study(db, study_id)
    try:
        doc = documents.store_upload(db, study.id, role, file.filename or "document", file.file, _user(current_user))
    except (documents.UploadError, Exception) as exc:  # noqa: BLE001 - the reason goes back to the screen
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if role == "figma" and not study.has_design:
        study.has_design = 1
        db.commit()
    documents.start_extraction(db, doc)
    return documents.detail(doc)


@router.post("/studies/{study_id}/documents/{doc_id}/retry")
def retry_document(study_id: int, doc_id: int, db: Session = Depends(get_db),
                   current_user=Depends(require_permission(PERM_EXECUTE))):
    doc = db.get(RndDocument, doc_id)
    if doc is None or doc.study_id != study_id or doc.origin != "upload":
        raise HTTPException(status_code=404, detail="No such uploaded document in this study.")
    documents.start_extraction(db, doc)
    return documents.detail(doc)


@router.delete("/studies/{study_id}/documents/{doc_id}")
def delete_document(study_id: int, doc_id: int, db: Session = Depends(get_db),
                    current_user=Depends(require_permission(PERM_EXECUTE))):
    doc = db.get(RndDocument, doc_id)
    if doc is None or doc.study_id != study_id:
        raise HTTPException(status_code=404, detail="No such document in this study.")
    documents.delete(db, doc)
    return {"deleted": doc_id}


# --- Analysis -----------------------------------------------------------------------

class AnalyseRequest(BaseModel):
    use_ai: bool = True


@router.post("/studies/{study_id}/analyse", status_code=202)
def analyse(study_id: int, payload: AnalyseRequest, db: Session = Depends(get_db),
            current_user=Depends(require_permission(PERM_EXECUTE))):
    study = _study(db, study_id)
    if db.query(RndDocument).filter(RndDocument.study_id == study.id, RndDocument.status == "extracting").count():
        raise HTTPException(status_code=409, detail="A document is still being read. Analyse once it is ready.")
    if not analysis.start(study.id, use_ai=payload.use_ai, username=_user(current_user)):
        raise HTTPException(status_code=409, detail="This study is already being analysed.")
    study.status = "analysing"
    study.progress = {"phase": "queued", "done": 0, "total": 0, "message": "Starting"}
    db.commit()
    return _study_brief(study)


@router.get("/studies/{study_id}/gaps.csv")
def export_gaps(study_id: int, db: Session = Depends(get_db), current_user=Depends(require_permission(PERM_VIEW))):
    study = _study(db, study_id)
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["PPM ID", "Project", "Study", "Test case", "Readiness", "Verdict", "Step", "Gap", "Severity", "Detail", "Suggested action"])
    for m in db.query(RndCaseMap).filter(RndCaseMap.study_id == study.id).order_by(RndCaseMap.display_id):
        for g in m.gaps or []:
            writer.writerow([study.ppm_id, study.project_name, study.name, m.display_id, m.readiness, m.verdict,
                             g.get("step_number") or "", g.get("label"), g.get("severity"), g.get("detail"), g.get("action")])
    for req in study.requirements or []:
        if not req.get("covered_by"):
            writer.writerow([study.ppm_id, study.project_name, study.name, "", "", "", "", "Requirement with no test case",
                             "medium", f"{req['id']}: {req['statement']}", "Add a test case or confirm it is out of scope."])
    name = f"rnd-lab-{study.ppm_id or study.project_id}-study-{study.id}-gaps.csv"
    return Response(content=out.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})
