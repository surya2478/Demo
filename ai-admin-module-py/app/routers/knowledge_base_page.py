"""
--- Automation Studio: Knowledge Base page -----------------------------------------

The read API behind the Knowledge Base page's own stages -- sources, Journey
KB, application model, test data and reconcile. Crawl and Automation KB stages
reuse the Discovery endpoints in routers/automation.py unchanged.

Nothing here edits a Knowledge Base file directly. Every change arrives as a
change set (services/journeys/changesets.py): drafted with automation.execute,
published or rejected with automation.approve, versioned, and revertible.
Test-data coverage names which stored key answered each variable; values
never leave services/automation/test_data.py.
"""
from __future__ import annotations

import logging
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..database.connection import get_db
from ..services.authz import require_permission, user_has_permission
from ..models.kb_changes import KbChangeSet, KbCrawlRun, KbHeal, KbSourceDocument, KbVersion
from ..services.journeys import changesets, crawl_runs, diff, documents, editing, heal, impact, store, workspace

logger = logging.getLogger(__name__)

router = APIRouter()

PERM_VIEW = "automation.view"
PERM_EXECUTE = "automation.execute"
PERM_APPROVE = "automation.approve"


def _kb(app_id: str) -> store.JourneyKB:
    try:
        return workspace.load_or_raise(app_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/apps")
def list_apps(current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    """Applications that have a Journey KB, keyed like the Automation KB."""
    apps = []
    for app_id in store.list_apps():
        kb = store.load(app_id)
        if kb:
            apps.append({"app_id": kb.app_id, "app_name": kb.app_name, "automation_app_id": kb.automation_app_id})
    return {"apps": apps}


@router.get("/{app_id}/overview")
def get_overview(app_id: str, current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    return workspace.overview(_kb(app_id))


@router.get("/{app_id}/sources")
def get_sources(app_id: str, current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    return {"sources": workspace.sources(_kb(app_id))}


@router.get("/{app_id}/taxonomy")
def get_taxonomy(app_id: str, current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    kb = _kb(app_id)
    keep = ("id", "title", "kind", "level", "chapter", "parent", "children", "status", "audience")
    return {
        "summary": kb.taxonomy.get("summary", {}),
        "roots": kb.taxonomy.get("roots", []),
        "nodes": [{k: n.get(k) for k in keep} for n in kb.taxonomy.get("nodes", [])],
        "authored": sorted(kb.journeys),
    }


@router.get("/{app_id}/journeys/{journey_id}")
def get_journey(app_id: str, journey_id: str, current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    try:
        return workspace.journey_detail(_kb(app_id), journey_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{app_id}/model")
def get_model(app_id: str, current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    return workspace.model(_kb(app_id))


@router.get("/{app_id}/reconcile")
def get_reconcile(app_id: str, current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    kb = _kb(app_id)
    return diff.reconcile_elements(kb, workspace._profile(kb))


@router.get("/{app_id}/test-data")
def get_test_data(
    app_id: str,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
) -> dict[str, Any]:
    return workspace.test_data_coverage(_kb(app_id), db)


# --- Change sets and versions --------------------------------------------------------------

def _actor(user: dict) -> str:
    return (user or {}).get("username") or "unknown"


def _fail(exc: Exception):
    if isinstance(exc, changesets.Conflict):
        raise HTTPException(status_code=409, detail={"message": str(exc), "conflicts": exc.conflicts}) from exc
    if isinstance(exc, LookupError):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    raise HTTPException(status_code=400, detail=str(exc)) from exc


class ChangeIn(BaseModel):
    file: str
    op: Literal["set", "remove"] = "set"
    path: str
    value: Any = None
    note: Optional[str] = None


class ChangeSetIn(BaseModel):
    kb: Literal["journey", "automation"] = "journey"
    title: str = Field(min_length=1, max_length=300)
    description: Optional[str] = None
    source: str = "manual"
    changes: list[ChangeIn] = Field(default_factory=list)


class DecisionIn(BaseModel):
    decision: Literal["app", "both", "design", "unlink", "add"]
    screen_id: Optional[str] = None
    element_id: Optional[str] = None
    automation_ref: Optional[str] = None
    app_label: Optional[str] = None
    label: Optional[str] = None
    note: Optional[str] = None


class DecideIn(BaseModel):
    note: Optional[str] = None


@router.get("/{app_id}/change-sets")
def list_change_sets(
    app_id: str,
    status: Optional[str] = Query(default=None, description="draft | published | rejected | conflicted"),
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
) -> dict[str, Any]:
    query = db.query(KbChangeSet).filter(KbChangeSet.app_id == app_id)
    if status:
        query = query.filter(KbChangeSet.status.in_(status.split(",")))
    rows = query.order_by(KbChangeSet.id.desc()).limit(200).all()
    pending = db.query(KbChangeSet).filter(KbChangeSet.app_id == app_id, KbChangeSet.status.in_(("draft", "conflicted"))).count()
    return {"change_sets": [changesets.change_set_view(c, with_changes=False) for c in rows], "pending": pending}


@router.post("/{app_id}/change-sets")
def create_change_set(
    app_id: str,
    body: ChangeSetIn,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
) -> dict[str, Any]:
    try:
        created = changesets.draft(
            db, app_id=app_id, kb=body.kb, title=body.title, description=body.description, source=body.source,
            changes=[c.model_dump() for c in body.changes], actor=_actor(current_user),
        )
    except Exception as exc:  # noqa: BLE001 - mapped to 400/404/409
        _fail(exc)
    return changesets.change_set_view(created)


@router.post("/{app_id}/reconcile/decide")
def decide_reconcile(
    app_id: str,
    body: DecisionIn,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
) -> dict[str, Any]:
    try:
        created = changesets.reconcile_decision(db, app_id=app_id, actor=_actor(current_user), **body.model_dump())
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    return changesets.change_set_view(created)


@router.get("/change-sets/{change_set_id}")
def get_change_set(change_set_id: int, db: Session = Depends(get_db), current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    found = db.get(KbChangeSet, change_set_id)
    if found is None:
        raise HTTPException(status_code=404, detail="No such change set.")
    return changesets.change_set_view(found)


@router.post("/change-sets/{change_set_id}/approve")
def approve_change_set(
    change_set_id: int,
    body: DecideIn,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_APPROVE)),
) -> dict[str, Any]:
    return _approve(db, change_set_id, current_user, body.note)


def _approve(db: Session, change_set_id: int, current_user: dict, note: Optional[str]) -> dict[str, Any]:
    try:
        versions = changesets.publish_with_pair(db, change_set_id, actor=_actor(current_user), note=note)
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    change_set = db.get(KbChangeSet, change_set_id)
    heal_id = None
    if versions and versions[-1].kb == "journey":
        # The change is published whatever happens here: a heal that fails is
        # logged and can be looked into, it never undoes an approval.
        try:
            record = heal.record(db, change_set=change_set, version=versions[-1], actor=_actor(current_user))
            heal_id = record.id if record else None
        except Exception:  # noqa: BLE001
            db.rollback()
            logger.exception("Recording the heal of change set %s failed", change_set_id)
    return {
        # The last one is this change set's; earlier ones are a crawl partner published first.
        "version": changesets.version_view(versions[-1]) if versions else None,
        "versions": [changesets.version_view(v) for v in versions],
        "change_set": changesets.change_set_view(change_set),
        "heal_id": heal_id,
    }


@router.post("/change-sets/{change_set_id}/reject")
def reject_change_set(
    change_set_id: int,
    body: DecideIn,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_APPROVE)),
) -> dict[str, Any]:
    try:
        rejected = changesets.reject(db, change_set_id, actor=_actor(current_user), note=body.note)
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    return changesets.change_set_view(rejected)


@router.delete("/change-sets/{change_set_id}")
def discard_change_set(
    change_set_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
) -> dict[str, Any]:
    try:
        changesets.discard(db, change_set_id)
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    return {"deleted": change_set_id}


# --- Editing journeys: the tree and a journey's steps -----------------------------------------
# Each edit is drafted as a change set (services/journeys/editing.py). With
# publish=true and the approve permission it is published at once, through the
# same approval -- versioned, revertable, and healed -- as one from the drawer.

class JourneyRenameIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    publish: bool = False


class JourneyAddIn(BaseModel):
    parent_id: Optional[str] = None
    title: str = Field(min_length=1, max_length=200)
    publish: bool = False


class JourneyStepIn(BaseModel):
    from_step: Optional[int] = None
    action: str = ""
    expected_result: str = ""
    screen_id: Optional[str] = None
    element_id: Optional[str] = None


class JourneyStepsIn(BaseModel):
    steps: list[JourneyStepIn]
    publish: bool = False


def _edited(db: Session, change_set: KbChangeSet, current_user: dict, publish: bool) -> dict[str, Any]:
    if publish:
        if not user_has_permission(current_user, PERM_APPROVE):
            return {"change_set": changesets.change_set_view(change_set), "published": False,
                    "message": "Saved as a change set; publishing it needs the approve permission."}
        result = _approve(db, change_set.id, current_user, "Published from the journey editor")
        return {**result, "published": True}
    return {"change_set": changesets.change_set_view(change_set), "published": False}


@router.post("/{app_id}/journeys")
def add_journey(app_id: str, body: JourneyAddIn, db: Session = Depends(get_db),
                current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    try:
        created = editing.add(db, _kb(app_id), body.parent_id, body.title, actor=_actor(current_user))
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    return _edited(db, created, current_user, body.publish)


@router.post("/{app_id}/journeys/{journey_id}/rename")
def rename_journey(app_id: str, journey_id: str, body: JourneyRenameIn, db: Session = Depends(get_db),
                   current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    try:
        created = editing.rename(db, _kb(app_id), journey_id, body.title, actor=_actor(current_user))
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    return _edited(db, created, current_user, body.publish)


@router.get("/{app_id}/journeys/{journey_id}/removal")
def preview_journey_removal(app_id: str, journey_id: str,
                            current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    """What removing a journey takes with it, for the confirmation."""
    kb = _kb(app_id)
    if kb.node(journey_id) is None:
        raise HTTPException(status_code=404, detail=f"No journey '{journey_id}'.")
    subtree = editing._subtree(kb, journey_id)
    return {"journeys": len(subtree), "authored": sorted(j for j in subtree if j in kb.journeys),
            "dependents": editing.dependents(kb, subtree)}


@router.delete("/{app_id}/journeys/{journey_id}")
def remove_journey(app_id: str, journey_id: str, publish: bool = Query(default=False), db: Session = Depends(get_db),
                   current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    try:
        created = editing.remove(db, _kb(app_id), journey_id, actor=_actor(current_user))
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    return _edited(db, created, current_user, publish)


@router.put("/{app_id}/journeys/{journey_id}/steps")
def edit_journey_steps(app_id: str, journey_id: str, body: JourneyStepsIn, db: Session = Depends(get_db),
                       current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    try:
        created = editing.edit_steps(db, _kb(app_id), journey_id, [s.model_dump() for s in body.steps],
                                     actor=_actor(current_user))
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    return _edited(db, created, current_user, body.publish)


class JourneyMoveIn(BaseModel):
    direction: Literal["up", "down"]
    publish: bool = False


class JourneyListIn(BaseModel):
    items: list[dict[str, Any]]
    publish: bool = False


class JourneyLinksIn(BaseModel):
    prerequisite_journeys: Optional[list[str]] = None
    next_journeys: Optional[list[str]] = None
    publish: bool = False


class TextEditIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    publish: bool = False


class RuleEditIn(BaseModel):
    statement: str = Field(min_length=1, max_length=2000)
    message: Optional[str] = None
    publish: bool = False


class StepsReviseIn(BaseModel):
    steps: list[JourneyStepIn]


def _run_edit(db: Session, current_user: dict, publish: bool, make) -> dict[str, Any]:
    try:
        created = make()
    except Exception as exc:  # noqa: BLE001 - mapped to 400/404/409
        _fail(exc)
    return _edited(db, created, current_user, publish)


@router.post("/{app_id}/journeys/{journey_id}/move")
def move_journey(app_id: str, journey_id: str, body: JourneyMoveIn, db: Session = Depends(get_db),
                 current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    return _run_edit(db, current_user, body.publish,
                     lambda: editing.move(db, _kb(app_id), journey_id, body.direction, actor=_actor(current_user)))


@router.put("/{app_id}/journeys/{journey_id}/branches")
def edit_journey_branches(app_id: str, journey_id: str, body: JourneyListIn, db: Session = Depends(get_db),
                          current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    return _run_edit(db, current_user, body.publish,
                     lambda: editing.edit_branches(db, _kb(app_id), journey_id, body.items, actor=_actor(current_user)))


@router.put("/{app_id}/journeys/{journey_id}/scenarios")
def edit_journey_scenarios(app_id: str, journey_id: str, body: JourneyListIn, db: Session = Depends(get_db),
                           current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    return _run_edit(db, current_user, body.publish,
                     lambda: editing.edit_scenarios(db, _kb(app_id), journey_id, body.items, actor=_actor(current_user)))


@router.put("/{app_id}/journeys/{journey_id}/links")
def edit_journey_links(app_id: str, journey_id: str, body: JourneyLinksIn, db: Session = Depends(get_db),
                       current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    links = {k: v for k, v in body.model_dump().items() if k in editing.LINK_KEYS and v is not None}
    return _run_edit(db, current_user, body.publish,
                     lambda: editing.edit_links(db, _kb(app_id), journey_id, links, actor=_actor(current_user)))


@router.get("/{app_id}/screens/{screen_id}")
def get_screen(app_id: str, screen_id: str, current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    try:
        return editing.screen_detail(_kb(app_id), screen_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/{app_id}/screens/{screen_id}/rename")
def rename_screen(app_id: str, screen_id: str, body: TextEditIn, db: Session = Depends(get_db),
                  current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    return _run_edit(db, current_user, body.publish,
                     lambda: editing.rename_screen(db, _kb(app_id), screen_id, body.text, actor=_actor(current_user)))


@router.post("/{app_id}/screens/{screen_id}/elements/{element_id}/label")
def relabel_element(app_id: str, screen_id: str, element_id: str, body: TextEditIn, db: Session = Depends(get_db),
                    current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    return _run_edit(db, current_user, body.publish,
                     lambda: editing.edit_element(db, _kb(app_id), screen_id, element_id, body.text, actor=_actor(current_user)))


@router.delete("/{app_id}/screens/{screen_id}/elements/{element_id}")
def remove_element(app_id: str, screen_id: str, element_id: str, publish: bool = Query(default=False),
                   db: Session = Depends(get_db),
                   current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    return _run_edit(db, current_user, publish,
                     lambda: editing.remove_element(db, _kb(app_id), screen_id, element_id, actor=_actor(current_user)))


@router.put("/{app_id}/rules/{rule_id}")
def edit_rule(app_id: str, rule_id: str, body: RuleEditIn, db: Session = Depends(get_db),
              current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    return _run_edit(db, current_user, body.publish,
                     lambda: editing.edit_rule(db, _kb(app_id), rule_id, body.statement, body.message, actor=_actor(current_user)))


@router.delete("/{app_id}/rules/{rule_id}")
def remove_rule(app_id: str, rule_id: str, publish: bool = Query(default=False), db: Session = Depends(get_db),
                current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    return _run_edit(db, current_user, publish,
                     lambda: editing.remove_rule(db, _kb(app_id), rule_id, actor=_actor(current_user)))


@router.put("/change-sets/{change_set_id}/changes/{position}/steps")
def revise_change_steps(change_set_id: int, position: int, body: StepsReviseIn, db: Session = Depends(get_db),
                        current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    """Correct the steps a drafted change set proposes, before it is approved."""
    try:
        revised = editing.revise_steps(db, change_set_id, position, [s.model_dump() for s in body.steps],
                                       actor=_actor(current_user))
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    return changesets.change_set_view(revised)


@router.get("/{app_id}/versions")
def list_versions(
    app_id: str,
    kb: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
) -> dict[str, Any]:
    query = db.query(KbVersion).filter(KbVersion.app_id == app_id)
    if kb:
        query = query.filter(KbVersion.kb == kb)
    rows = query.order_by(KbVersion.id.desc()).limit(200).all()
    return {"versions": [changesets.version_view(v) for v in rows]}


@router.get("/versions/{version_id}")
def get_version(version_id: int, db: Session = Depends(get_db), current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    found = db.get(KbVersion, version_id)
    if found is None:
        raise HTTPException(status_code=404, detail="No such version.")
    return changesets.version_view(found, with_files=True)


@router.post("/versions/{version_id}/revert")
def revert_version(
    version_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_APPROVE)),
) -> dict[str, Any]:
    try:
        undo = changesets.revert(db, version_id, actor=_actor(current_user))
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    if undo.kb == "journey":
        try:
            heal.record_revert(db, undo=undo, reverted=db.get(KbVersion, version_id), actor=_actor(current_user))
        except Exception:  # noqa: BLE001
            db.rollback()
            logger.exception("Recording the heal of reverting version %s failed", version_id)
    return changesets.version_view(undo)


# --- Journey-guided crawl --------------------------------------------------------------

class CrawlIn(BaseModel):
    journey_id: str
    application_id: int
    profile_id: Optional[str] = None
    environment: Optional[str] = None


@router.get("/{app_id}/journey-crawl/plan")
def preview_crawl_plan(
    app_id: str,
    journey_id: str = Query(...),
    profile_id: Optional[str] = Query(default=None),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
) -> dict[str, Any]:
    try:
        return crawl_runs.preview(app_id, journey_id, profile_id)
    except Exception as exc:  # noqa: BLE001
        _fail(exc)


@router.post("/{app_id}/journey-crawl", status_code=202)
def start_crawl(
    app_id: str,
    body: CrawlIn,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
) -> dict[str, Any]:
    try:
        run = crawl_runs.start(db, app_id=app_id, actor=_actor(current_user), **body.model_dump())
    except crawl_runs.Unavailable as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    return crawl_runs.view(run)


@router.get("/{app_id}/journey-crawls")
def list_crawls(
    app_id: str,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
) -> dict[str, Any]:
    rows = db.query(KbCrawlRun).filter(KbCrawlRun.app_id == app_id).order_by(KbCrawlRun.id.desc()).limit(20).all()
    # Absorb the newest on the way, so a poll of the list is enough.
    if rows and rows[0].status in ("queued", "running"):
        crawl_runs.absorb(db, rows[0])
    return {"crawls": [crawl_runs.view(r, with_result=(i == 0)) for i, r in enumerate(rows)]}


@router.get("/journey-crawls/{crawl_id}")
def get_crawl(crawl_id: int, db: Session = Depends(get_db), current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    run = db.get(KbCrawlRun, crawl_id)
    if run is None:
        raise HTTPException(status_code=404, detail="No such crawl.")
    return crawl_runs.view(crawl_runs.absorb(db, run))


@router.post("/journey-crawls/{crawl_id}/propose")
def propose_from_crawl(
    crawl_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
) -> dict[str, Any]:
    try:
        run = crawl_runs.propose(db, crawl_id, actor=_actor(current_user))
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    return crawl_runs.view(run)


# --- Design documents: upload, extract, review ---------------------------------------------
# A PDF or BRD is kept next to the Journey KB, a model proposes what it
# describes, and the reviewer turns the items they keep into a Journey KB
# change set. Nothing here writes the Knowledge Base itself.

def _document(db: Session, doc_id: int) -> KbSourceDocument:
    doc = db.get(KbSourceDocument, doc_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="No such document.")
    return doc


@router.get("/{app_id}/documents")
def list_documents(app_id: str, db: Session = Depends(get_db),
                   current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    _kb(app_id)
    rows = db.query(KbSourceDocument).filter(KbSourceDocument.app_id == app_id).order_by(KbSourceDocument.id.desc()).all()
    return {"documents": [documents.view(db, d) for d in rows], "vision_model": documents.vision_model()}


@router.post("/{app_id}/documents", status_code=201)
async def upload_document(
    app_id: str,
    response: Response,
    file: UploadFile = File(...),
    doc_kind: str = Form("screen_flow"),
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
) -> dict[str, Any]:
    kb = _kb(app_id)
    contents = await file.read(documents.MAX_BYTES + 1)
    try:
        doc, is_new = documents.store_upload(db, kb, filename=file.filename or "document", contents=contents,
                                             doc_kind=doc_kind, actor=_actor(current_user))
    except documents.DocumentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not is_new:
        response.status_code = 200
    return {**documents.view(db, doc), "duplicate": not is_new}


@router.get("/documents/{doc_id}")
def get_document(doc_id: int, db: Session = Depends(get_db),
                 current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    return documents.view(db, _document(db, doc_id), with_extraction=True)


@router.get("/documents/{doc_id}/pages")
def get_document_pages(doc_id: int, db: Session = Depends(get_db),
                       current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    doc = _document(db, doc_id)
    try:
        return {"pages": documents.read_pages(_kb(doc.app_id), doc), "images": doc.filename.lower().endswith(".pdf")}
    except documents.DocumentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/documents/{doc_id}/pages/{page}.png")
def get_document_page_image(doc_id: int, page: int, db: Session = Depends(get_db),
                            current_user: dict = Depends(require_permission(PERM_VIEW))) -> Response:
    doc = _document(db, doc_id)
    try:
        png = documents.page_png(_kb(doc.app_id), doc, page)
    except documents.DocumentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return Response(content=png, media_type="image/png", headers={"Cache-Control": "private, max-age=3600"})


@router.post("/documents/{doc_id}/extract", status_code=202)
def extract_document(doc_id: int, db: Session = Depends(get_db),
                     current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    _document(db, doc_id)
    try:
        doc = documents.start_extraction(db, doc_id)
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    return documents.view(db, doc)


class DocumentDraftIn(BaseModel):
    selected: list[str]
    edits: dict[str, dict[str, Any]] = Field(default_factory=dict)
    # Screens and elements the reviewer adds (what the model missed).
    additions: list[dict[str, Any]] = Field(default_factory=list)


@router.post("/documents/{doc_id}/draft")
def draft_from_document(doc_id: int, body: DocumentDraftIn, db: Session = Depends(get_db),
                        current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    doc = _document(db, doc_id)
    try:
        change_set, added = documents.draft_change_set(db, _kb(doc.app_id), doc_id, selected=body.selected, additions=body.additions,
                                                       edits=body.edits, actor=_actor(current_user))
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    return {"document": documents.view(db, doc), "change_set": changesets.change_set_view(change_set, with_changes=False),
            "auto_included": added}


@router.delete("/documents/{doc_id}", status_code=204)
def delete_document(doc_id: int, db: Session = Depends(get_db),
                    current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> Response:
    doc = _document(db, doc_id)
    try:
        documents.delete(db, _kb(doc.app_id), doc_id)
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    return Response(status_code=204)


# --- Change & Heal -------------------------------------------------------------------------
# What a change touches (before approval, for a draft) and what was done about
# it after (a heal per published Journey KB version).

@router.get("/change-sets/{change_set_id}/impact")
def change_set_impact(change_set_id: int, db: Session = Depends(get_db),
                      current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    change_set = db.get(KbChangeSet, change_set_id)
    if change_set is None:
        raise HTTPException(status_code=404, detail="No such change set.")
    if change_set.kb != "journey":
        return {"counts": {}, "journeys": [], "elements": [], "rules": [], "test_cases": [], "screens": [],
                "automation": {"selectors_to_reverify": [], "flows": []}, "crawl_journeys": []}
    kb = _kb(change_set.app_id)
    return impact.analyse(kb, [{"file": c.file, "path": c.path, "after": c.after or {}} for c in change_set.changes], db)


@router.post("/documents/{doc_id}/impact")
def document_impact(doc_id: int, body: DocumentDraftIn, db: Session = Depends(get_db),
                    current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    """The impact the current selection would have, without drafting anything."""
    doc = _document(db, doc_id)
    kb = _kb(doc.app_id)
    try:
        changes, _, _ = documents.build_changes(kb, doc, selected=body.selected, edits=body.edits, additions=body.additions)
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    return impact.analyse(kb, changes, db)


@router.get("/{app_id}/heals")
def list_heals(app_id: str, db: Session = Depends(get_db),
               current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    rows = db.query(KbHeal).filter(KbHeal.app_id == app_id).order_by(KbHeal.id.desc()).limit(30).all()
    return {"heals": [heal.view(db, h) for h in rows]}


@router.get("/heals/{heal_id}")
def get_heal(heal_id: int, db: Session = Depends(get_db),
             current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    row = db.get(KbHeal, heal_id)
    if row is None:
        raise HTTPException(status_code=404, detail="No such heal.")
    return heal.view(db, row)


@router.post("/heals/{heal_id}/recheck")
def heal_recheck(heal_id: int, db: Session = Depends(get_db),
                 current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    try:
        row = heal.recheck(db, heal_id, actor=_actor(current_user))
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    return heal.view(db, row)


class HealCrawlIn(BaseModel):
    journey_id: str
    application_id: int
    environment: Optional[str] = None


@router.post("/heals/{heal_id}/crawl", status_code=202)
def heal_crawl(heal_id: int, body: HealCrawlIn, db: Session = Depends(get_db),
               current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    try:
        row = heal.crawl(db, heal_id, journey_id=body.journey_id, application_id=body.application_id,
                         environment=body.environment, actor=_actor(current_user))
    except crawl_runs.Unavailable as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    return heal.view(db, row)
