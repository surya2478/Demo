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
import re
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Query, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..database.connection import get_db
from ..services.authz import require_permission, user_has_permission
from ..models.kb_changes import KbChangeSet, KbCrawlRun, KbHeal, KbSourceDocument, KbVersion
from ..services.journeys import browser_collector, changesets, crawl_runs, diff, doc_convert, documents, editing, heal, impact, journey_map, journey_record, local_runner, store, workspace

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


# --- Registering an application and naming it -------------------------------------------

class ApplicationIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    # The folder both Knowledge Bases share; derived from the name when omitted.
    app_key: Optional[str] = Field(default=None, max_length=100)
    # {environment: address}, e.g. {"SIT": "https://sit.example.com/portal"}
    addresses: dict[str, str] = Field(default_factory=dict)
    default_environment: Optional[str] = Field(default=None, max_length=40)
    id_prefix: Optional[str] = Field(default=None, max_length=12)
    # The master topic list: one journey per line, two spaces per level.
    outline: Optional[str] = Field(default=None, max_length=200_000)


class JourneyKbIn(BaseModel):
    name: Optional[str] = Field(default=None, max_length=200)
    id_prefix: Optional[str] = Field(default=None, max_length=12)
    outline: Optional[str] = Field(default=None, max_length=200_000)


class NameIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)


def _registration(db: Session, app_key: str) -> dict[str, Any]:
    from ..models.automation import AutomationApplication
    from ..services.automation import registry

    data_app = registry.data_app_for_kb(db, app_key)
    crawl = db.query(AutomationApplication).filter(AutomationApplication.app_key == app_key).first()
    return {
        "data_app_id": data_app.id if data_app else None,
        "crawl_app_id": crawl.id if crawl and crawl.is_active else None,
        **registry.environments_for_kb(db, app_key),
    }


@router.post("/applications")
def register_application(body: ApplicationIn, db: Session = Depends(get_db),
                         current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    """One step from nothing to a usable application: registered with its
    address per environment (as Test Data does) and given a Journey KB --
    unless one already exists under that key, which is then linked."""
    from ..models.automation import AutomationDataApp
    from ..services.automation import registry
    from ..services.journeys import onboarding
    from .test_data import AppIn, _apply_addresses, _run_environment

    name = re.sub(r"\s+", " ", body.name).strip()
    key = (body.app_key or "").strip().lower() or onboarding.slug(name)
    if not onboarding.KEY.match(key):
        raise HTTPException(status_code=400, detail="The key is 2-100 lower-case letters, digits, '_' or '-'.")
    if db.query(AutomationDataApp).filter(AutomationDataApp.name == name).first():
        raise HTTPException(status_code=409, detail=f"An application called {name} already exists.")
    if registry.data_app_for_kb(db, key):
        raise HTTPException(status_code=409, detail=f"An application with the key {key} is already registered.")
    addresses = {k.strip().upper(): (v or "").strip() for k, v in body.addresses.items() if k.strip() and (v or "").strip()}
    if not addresses:
        raise HTTPException(status_code=400, detail="Give the address of at least one environment.")
    environment = _run_environment(body.default_environment) or next(iter(addresses))
    if environment not in addresses:
        raise HTTPException(status_code=400, detail=f"The default environment {environment} needs an address.")

    actor = _actor(current_user)
    app = AutomationDataApp(name=name, kb_app_id=key, run_environment=environment, created_by=actor)
    db.add(app)
    db.flush()
    warnings = _apply_addresses(db, app, AppIn(name=name, addresses=addresses), actor)
    registry.sync_crawl_app(db, app, actor=actor)

    created_kb = False
    if store.load(key) is None:
        try:
            onboarding.create(key, name, id_prefix=body.id_prefix, outline=body.outline)
            created_kb = True
        except onboarding.OnboardingError as exc:
            db.rollback()
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001 - nothing is registered without its KB
            db.rollback()
            logger.exception("Creating the Journey KB for %s failed", key)
            raise HTTPException(status_code=500, detail=f"The Journey KB could not be written: {exc}") from exc
    else:
        onboarding.rename(key, name)
    # A new application's first browser crawl needs an app-scoped, empty
    # Automation KB to propose selectors against. This contains no selectors;
    # captured values still require a reviewed change set.
    registered_kb = store.load(key)
    if registered_kb is not None:
        store.ensure_automation_baseline(registered_kb, addresses[environment])
    db.commit()
    return {"app_key": key, "name": name, "journey_kb_created": created_kb, "warnings": warnings, **_registration(db, key)}


@router.post("/{app_id}/journey-kb")
def create_journey_kb(app_id: str, body: JourneyKbIn, db: Session = Depends(get_db),
                      current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    """A Journey KB for an application registered without one."""
    from ..services.automation import registry
    from ..services.journeys import onboarding

    data_app = registry.data_app_for_kb(db, app_id)
    name = (body.name or "").strip() or (data_app.name if data_app else "")
    try:
        kb = onboarding.create(app_id, name, id_prefix=body.id_prefix, outline=body.outline)
    except onboarding.OnboardingError as exc:
        raise HTTPException(status_code=409 if "already exists" in str(exc) else 400, detail=str(exc)) from exc
    if data_app is not None and not data_app.kb_app_id:
        data_app.kb_app_id = app_id  # pin it, so a later rename keeps this folder
        db.commit()
    return {"app_id": kb.app_id, "app_name": kb.app_name, "automation_app_id": kb.automation_app_id}


@router.get("/{app_id}/registration")
def get_registration(app_id: str, db: Session = Depends(get_db),
                     current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    """Where an application stands: registered, its environments, a Journey KB."""
    kb = store.load(app_id)
    return {"app_key": app_id, "journey_kb": bool(kb), "app_name": kb.app_name if kb else None, **_registration(db, app_id)}


@router.put("/{app_id}/name")
def rename_application(app_id: str, body: NameIn, db: Session = Depends(get_db),
                       current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    """Rename an application everywhere it is shown: Test Data, the crawl
    registry and the Journey KB. Its key -- the folder, and every id that
    names it -- stays, so nothing that points at it breaks."""
    from ..models.automation import AutomationApplication, AutomationDataApp
    from ..services.automation import registry
    from ..services.journeys import onboarding

    name = re.sub(r"\s+", " ", body.name).strip()
    if not name:
        raise HTTPException(status_code=400, detail="The application needs a name.")
    data_app = registry.data_app_for_kb(db, app_id)
    found = False
    if data_app is not None:
        clash = db.query(AutomationDataApp).filter(AutomationDataApp.name == name, AutomationDataApp.id != data_app.id).first()
        if clash:
            raise HTTPException(status_code=409, detail=f"An application called {name} already exists.")
        if not data_app.kb_app_id:
            data_app.kb_app_id = registry.crawl_key(data_app)
        data_app.name = name
        registry.sync_crawl_app(db, data_app, actor=_actor(current_user))
        found = True
    crawl = db.query(AutomationApplication).filter(AutomationApplication.app_key == app_id).first()
    if crawl is not None:
        crawl.name = name
        found = True
    db.flush()
    if onboarding.rename(app_id, name) is not None:
        found = True
    if not found:
        db.rollback()
        raise HTTPException(status_code=404, detail=f"No application '{app_id}'.")
    db.commit()
    return {"app_key": app_id, "name": name}


def _deletion(db: Session, app_id: str) -> dict[str, Any]:
    """Everything deleting `app_id` would touch, for the confirmation and the delete itself."""
    from ..models.automation import AutomationApplication, AutomationDiscoveryRun
    from ..services.automation import knowledge_base as automation_kb, registry

    data_app = registry.data_app_for_kb(db, app_id)
    crawl = db.query(AutomationApplication).filter(AutomationApplication.app_key == app_id).first()
    runs = (db.query(AutomationDiscoveryRun).filter(AutomationDiscoveryRun.application_id == crawl.id).count()
            if crawl is not None else 0)
    kb = store.load(app_id)
    journey_dir = store.journey_kb_root() / app_id
    automation_dir = automation_kb.KB_ROOT_DIR / app_id
    # Another Journey KB built on this crawled folder keeps it.
    shared = any(getattr(store.load(other), "automation_app_id", None) == app_id
                 for other in store.list_apps() if other != app_id)
    name = (data_app.name if data_app else None) or (crawl.name if crawl else None) or (kb.app_name if kb else None)
    return {
        "app_key": app_id,
        "name": name,
        "data_app": data_app,
        "crawl": crawl,
        "summary": {
            "app_key": app_id,
            "name": name,
            "test_data": {
                "registered": data_app is not None,
                "environments": sorted(e.environment for e in data_app.environments) if data_app else [],
                "values": len(data_app.entries) if data_app else 0,
            },
            "crawl": {"registered": crawl is not None, "runs": runs},
            "journey_kb": {
                "exists": kb is not None,
                "journeys": len(kb.journeys) if kb else 0,
                "screens": len(kb.screens) if kb else 0,
                "documents": db.query(KbSourceDocument).filter(KbSourceDocument.app_id == app_id).count(),
            },
            "automation_kb": {"exists": automation_dir.exists(), "shared": shared},
            "pending_change_sets": db.query(KbChangeSet).filter(KbChangeSet.app_id == app_id, KbChangeSet.status == "draft").count(),
        },
        "folders": {
            **({"journey_kb": journey_dir} if journey_dir.exists() else {}),
            **({"automation_kb": automation_dir} if automation_dir.exists() and not shared else {}),
        },
    }


@router.get("/{app_id}/deletion")
def preview_application_deletion(app_id: str, db: Session = Depends(get_db),
                                 current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    """What deleting this application would remove, shown before anyone confirms."""
    found = _deletion(db, app_id)
    if found["name"] is None:
        raise HTTPException(status_code=404, detail=f"No application '{app_id}'.")
    return found["summary"]


@router.delete("/{app_id}")
def delete_application(app_id: str, confirm: str = Query(..., description="The application's name, typed exactly"),
                       db: Session = Depends(get_db),
                       current_user: dict = Depends(require_permission(PERM_APPROVE))) -> dict[str, Any]:
    """Delete an application from the Knowledge Base page, Test Data and the crawl list.

    Its Journey KB and crawled Automation KB folders are moved to
    knowledge_base/_deleted/, never erased, so they can be restored by hand.
    A crawl application with discovery runs is deactivated rather than
    deleted: test cases grounded on those runs still point at them. Change
    sets, versions and uploaded-document records stay as history.
    """
    from ..services.audit_logger import audit_log
    from ..services.journeys import onboarding

    found = _deletion(db, app_id)
    name = found["name"]
    if name is None:
        raise HTTPException(status_code=404, detail=f"No application '{app_id}'.")
    if re.sub(r"\s+", " ", confirm or "").strip() != name:
        raise HTTPException(status_code=400, detail=f"Type the application's name, {name}, exactly to delete it.")

    crawl = found["crawl"]
    if found["data_app"] is not None:
        db.delete(found["data_app"])
    if crawl is not None:
        if found["summary"]["crawl"]["runs"]:
            crawl.is_active = False
        else:
            db.delete(crawl)
    db.flush()
    try:
        archived = onboarding.archive(app_id, found["folders"])
    except Exception as exc:  # noqa: BLE001 - nothing is deleted unless the folders moved
        db.rollback()
        logger.exception("Archiving the Knowledge Base folders of %s failed", app_id)
        raise HTTPException(status_code=500, detail=f"The Knowledge Base folders could not be moved, so nothing was deleted: {exc}") from exc
    db.commit()

    actor = _actor(current_user)
    audit_log(
        actor=actor,
        actor_role=(current_user or {}).get("role") or ", ".join((current_user or {}).get("roles") or []) or "user",
        module="Automation Studio",
        action="delete",
        resource_type="knowledge_base_application",
        resource_id=app_id,
        resource_name=name,
        status="success",
        details={"description": f"{actor} deleted application {name}", "archived_to": str(archived) if archived else None},
    )
    logger.info("Application %s (%s) deleted by %s; folders archived to %s", name, app_id, actor, archived)
    return {
        "deleted": app_id,
        "name": name,
        "archived_to": archived.name if archived else None,
        "crawl_deactivated": bool(crawl is not None and found["summary"]["crawl"]["runs"]),
    }


@router.get("/{app_id}/overview")
def get_overview(app_id: str, current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    return workspace.overview(_kb(app_id))


@router.get("/{app_id}/sources")
def get_sources(app_id: str, current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    return {"sources": workspace.sources(_kb(app_id))}


@router.get("/{app_id}/taxonomy")
def get_taxonomy(app_id: str, db: Session = Depends(get_db),
                 current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    kb = _kb(app_id)
    # Journeys whose flow matches them and whose every step a walk confirmed.
    verified = []
    for journey_id in sorted(kb.journeys):
        try:
            if journey_map.build_map(kb, journey_id, db=db)["summary"].get("verified"):
                verified.append(journey_id)
        except Exception:  # noqa: BLE001 - one broken journey must not hide the tree
            continue
    keep = ("id", "title", "kind", "level", "chapter", "parent", "children", "status", "audience")
    return {
        "summary": kb.taxonomy.get("summary", {}),
        "roots": kb.taxonomy.get("roots", []),
        "nodes": [{k: n.get(k) for k in keep} for n in kb.taxonomy.get("nodes", [])],
        "authored": sorted(kb.journeys),
        "verified": verified,
    }


@router.get("/{app_id}/journeys/{journey_id}")
def get_journey(app_id: str, journey_id: str, db: Session = Depends(get_db),
                current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    try:
        return workspace.journey_detail(_kb(app_id), journey_id, db=db)
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
    # How a recording did the step (kind, selector, field...); omitted: kept as it was.
    recorded: Optional[dict[str, Any]] = None


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
    # Through the Journey Map, so the journey's flow blueprint is regenerated
    # with its steps -- wherever a step is edited, the flow cannot drift.
    return _map_save(db, app_id, journey_id, [s.model_dump(exclude_unset=True) for s in body.steps], None, body.publish, current_user)


# --- Journey Map: the journey's steps, its flow blueprint and selectors, side by side --------

class JourneyMapSaveIn(BaseModel):
    # The edited steps, as the steps editor sends them; omitted: only regenerate the flow.
    steps: Optional[list[JourneyStepIn]] = None
    # For a journey with no flow blueprint: an existing flow_id to link, or "new".
    link_flow: Optional[str] = None
    publish: bool = False


@router.get("/{app_id}/journey-map")
def journey_map_overview(app_id: str, db: Session = Depends(get_db),
                         current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    return journey_map.overview(_kb(app_id), db=db)


@router.get("/{app_id}/journey-map/{journey_id}")
def journey_map_detail(app_id: str, journey_id: str, db: Session = Depends(get_db),
                       current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    try:
        return journey_map.build_map(_kb(app_id), journey_id, db=db)
    except Exception as exc:  # noqa: BLE001
        _fail(exc)


@router.post("/{app_id}/journey-map/{journey_id}")
def journey_map_save(app_id: str, journey_id: str, body: JourneyMapSaveIn, db: Session = Depends(get_db),
                     current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    steps = [s.model_dump(exclude_unset=True) for s in body.steps] if body.steps is not None else None
    return _map_save(db, app_id, journey_id, steps, body.link_flow, body.publish, current_user)


def _map_save(db: Session, app_id: str, journey_id: str, steps: Optional[list], link_flow: Optional[str],
              publish: bool, current_user: dict) -> dict[str, Any]:
    try:
        created = journey_map.propose(db, _kb(app_id), journey_id, steps=steps, link_flow=link_flow, actor=_actor(current_user))
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    # The journey half when there is one: approving it publishes its flow too.
    lead = created["journey"] or created["automation"]
    result = _edited(db, lead, current_user, publish)
    partner = created["automation"] if created["journey"] else None
    if partner is not None:
        db.refresh(partner)
        result["flow_change_set"] = changesets.change_set_view(partner)
    return result


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
        revised = editing.revise_steps(db, change_set_id, position, [s.model_dump(exclude_unset=True) for s in body.steps],
                                       actor=_actor(current_user))
        # A Journey Map draft: its flow half follows the revised steps.
        if (revised.origin or {}).get("map"):
            journey_map.refresh_pair(db, _kb(revised.app_id), revised)
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
    # A Journey KB journey id, or "flow:<flow_id>" for an Automation KB flow blueprint.
    journey_id: str
    application_id: int
    profile_id: Optional[str] = None
    environment: Optional[str] = None
    # The order (1-based) of the first step not to run.
    stop_before: Optional[int] = Field(default=None, ge=1)
    # Let the walk click through steps that submit, confirm, pay, save or delete.
    allow_risky: bool = False
    # A visible browser, where the server can show one (see /walk/capabilities).
    headed: bool = False


class LocalCrawlIn(CrawlIn):
    # Replay the steps before this order, then ask the person using the headed
    # device browser to click the element that this step should capture.
    capture_step: Optional[int] = Field(default=None, ge=1, le=500)


class BrowserCrawlIn(BaseModel):
    journey_id: str = Field(min_length=1, max_length=200)
    application_id: int
    profile_id: Optional[str] = Field(default=None, max_length=200)
    environment: Optional[str] = Field(default=None, max_length=40)
    max_pages: int = Field(default=20, ge=1, le=browser_collector.MAX_PAGES)
    wait_seconds: int = Field(default=20, ge=2, le=120)
    retry_count: int = Field(default=2, ge=0, le=10)
    # Replay actions through this order and pause in the collector so the
    # person can point at the element the generated journey could not find.
    capture_step: Optional[int] = Field(default=None, ge=1, le=500)
    # Completed crawl whose later confirmed evidence should survive this
    # intentionally shortened recapture replay.
    recapture_of: Optional[int] = Field(default=None, ge=1)


class BrowserPageIn(BaseModel):
    page_id: str = Field(min_length=1, max_length=120)
    name: str = Field(default="", max_length=120)
    url: str = Field(min_length=1, max_length=1000)
    title: Optional[str] = Field(default=None, max_length=200)
    captured_at: Optional[str] = Field(default=None, max_length=80)
    browser: Optional[str] = Field(default=None, max_length=100)
    viewport: Optional[dict[str, int]] = None
    elements: list[dict[str, Any]] = Field(min_length=1, max_length=browser_collector.journey_capture.MAX_ELEMENTS)
    picked: list[dict[str, Any]] = Field(default_factory=list, max_length=100)
    links: list[str] = Field(default_factory=list, max_length=browser_collector.MAX_LINKS)


class BrowserFailIn(BaseModel):
    message: str = Field(default="The browser collector stopped.", max_length=1000)


class BrowserCancelIn(BaseModel):
    message: str = Field(default="Browser crawl stopped by the user.", max_length=1000)


class BrowserProgressIn(BaseModel):
    state: Literal["opening", "executing", "waiting", "capturing", "failed"] = "executing"
    message: str = Field(default="Running browser setup.", max_length=1000)
    action_index: int = Field(default=0, ge=0, le=500)
    action_order: Optional[int] = Field(default=None, ge=1, le=500)
    action_total: int = Field(default=0, ge=0, le=500)
    action_text: Optional[str] = Field(default=None, max_length=500)
    action_status: Optional[Literal["running", "done", "error"]] = None
    action_error: Optional[str] = Field(default=None, max_length=1000)


class BrowserRepairIn(BaseModel):
    order: int = Field(ge=1, le=500)
    selector: str = Field(min_length=1, max_length=1000)
    app_label: Optional[str] = Field(default=None, max_length=200)
    role: Optional[str] = Field(default=None, max_length=80)
    action: Optional[Literal[
        "verify_visible", "verify_text", "click", "tap", "double_click", "hover", "focus",
        "fill_test_data", "check", "uncheck", "press_enter", "select_option",
    ]] = None
    option: Optional[str] = Field(default=None, max_length=500)


class LocalProgressIn(BaseModel):
    message: str = Field(default="Running Playwright on this device.", max_length=500)
    progress: dict[str, Any] = Field(default_factory=dict)
    frame: Optional[str] = None


class LocalFinishIn(BaseModel):
    output: dict[str, Any]
    artifacts: dict[str, str] = Field(default_factory=dict)


class LocalFailIn(BaseModel):
    message: str = Field(default="Local Playwright stopped.", max_length=1000)


def _collector_token(authorization: Optional[str]) -> str:
    scheme, _, value = (authorization or "").partition(" ")
    if scheme.lower() != "collector" or not value.strip():
        raise HTTPException(status_code=401, detail="Send the browser crawl code as Authorization: Collector <code>.")
    return value.strip()


def _local_runner_token(authorization: Optional[str]) -> str:
    scheme, _, value = (authorization or "").partition(" ")
    if scheme.lower() != "local-runner" or not value.strip():
        raise HTTPException(status_code=401, detail="Send the local run code as Authorization: Local-Runner <code>.")
    return value.strip()


@router.get("/local-runner/package")
def local_runner_package(current_user: dict = Depends(require_permission(PERM_VIEW))) -> Response:
    """The small loopback service that launches the device's existing Playwright."""
    try:
        data = local_runner.package()
    except local_runner.LocalRunnerError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="automation-studio-local-runner.zip"', "Cache-Control": "no-store"},
    )


@router.post("/{app_id}/local-journey-crawl", status_code=201)
def start_local_crawl(
    app_id: str,
    body: LocalCrawlIn,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
) -> dict[str, Any]:
    """Create a run whose generated spec is executed by the user's loopback runner."""
    try:
        crawl, token = local_runner.start(
            db, app_id=app_id, journey_id=body.journey_id, application_id=body.application_id,
            profile_id=body.profile_id, environment=body.environment, actor=_actor(current_user),
            stop_before=body.stop_before, allow_risky=body.allow_risky, headless=not body.headed,
            capture_step=body.capture_step,
        )
    except (local_runner.LocalRunnerError, LookupError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    return {"crawl": crawl_runs.view(crawl), "runner_token": token, "expires_in_minutes": local_runner.SESSION_MINUTES}


# These endpoints accept only the short-lived credential for one local run.
# The browser never receives Test Data; only the loopback runner can exchange
# the credential for the generated spec and its in-memory run environment.
@router.get("/local-runner/sessions/{crawl_id}")
def local_runner_config(crawl_id: int, authorization: Optional[str] = Header(default=None), db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        return local_runner.config(db, crawl_id, _local_runner_token(authorization))
    except local_runner.LocalRunnerError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


@router.post("/local-runner/sessions/{crawl_id}/progress")
def local_runner_progress(crawl_id: int, body: LocalProgressIn, authorization: Optional[str] = Header(default=None), db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        return local_runner.progress(db, crawl_id, _local_runner_token(authorization), body.model_dump())
    except local_runner.LocalRunnerError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/local-runner/sessions/{crawl_id}/finish")
def finish_local_runner(crawl_id: int, body: LocalFinishIn, authorization: Optional[str] = Header(default=None), db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        return crawl_runs.view(local_runner.finish(db, crawl_id, _local_runner_token(authorization), body.output, body.artifacts))
    except local_runner.LocalRunnerError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/local-runner/sessions/{crawl_id}/fail")
def fail_local_runner(crawl_id: int, body: LocalFailIn, authorization: Optional[str] = Header(default=None), db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        return crawl_runs.view(local_runner.fail(db, crawl_id, _local_runner_token(authorization), body.message))
    except local_runner.LocalRunnerError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/journey-crawls/{crawl_id}/cancel-local")
def cancel_local_crawl(
    crawl_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
) -> dict[str, Any]:
    try:
        return crawl_runs.view(local_runner.cancel(db, crawl_id))
    except (local_runner.LocalRunnerError, LookupError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/browser-crawl/package/{engine}")
def browser_collector_package(
    engine: Literal["chromium", "firefox", "safari"],
    studio_origin: Optional[str] = None,
    current_user: dict = Depends(require_permission(PERM_VIEW)),
) -> Response:
    """A browser-specific manifest around the same cross-browser collector code."""
    try:
        data = browser_collector.package(engine, studio_origin=studio_origin)
    except browser_collector.CollectorError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="automation-studio-collector-{engine}.zip"', "Cache-Control": "no-store"},
    )


@router.post("/{app_id}/browser-crawl", status_code=201)
def start_browser_crawl(
    app_id: str,
    body: BrowserCrawlIn,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
) -> dict[str, Any]:
    """Pair a WebExtension to one short-lived, origin-bound crawl."""
    try:
        crawl, token = browser_collector.start(db, app_id=app_id, actor=_actor(current_user), **body.model_dump())
    except browser_collector.CollectorError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    return {"crawl": crawl_runs.view(crawl), "collector_token": token, "expires_in_minutes": browser_collector.SESSION_MINUTES}


# These four routes deliberately use the one-crawl Collector credential rather
# than a user's API token.  A browser extension can submit sanitised snapshots
# but cannot view, edit or approve anything else in Automation Studio.
@router.get("/browser-crawl/sessions/{crawl_id}")
def browser_crawl_config(crawl_id: int, authorization: Optional[str] = Header(default=None), db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        return browser_collector.config(db, crawl_id, _collector_token(authorization))
    except browser_collector.CollectorError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


@router.post("/browser-crawl/sessions/{crawl_id}/pages")
def browser_crawl_page(crawl_id: int, body: BrowserPageIn, authorization: Optional[str] = Header(default=None), db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        return browser_collector.add_page(db, crawl_id, _collector_token(authorization), body.model_dump())
    except browser_collector.CollectorError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/browser-crawl/sessions/{crawl_id}/progress")
def browser_crawl_progress(crawl_id: int, body: BrowserProgressIn, authorization: Optional[str] = Header(default=None), db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        return browser_collector.progress(db, crawl_id, _collector_token(authorization), body.model_dump())
    except browser_collector.CollectorError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/browser-crawl/sessions/{crawl_id}/repair")
def browser_crawl_repair(crawl_id: int, body: BrowserRepairIn, authorization: Optional[str] = Header(default=None), db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        return browser_collector.repair(db, crawl_id, _collector_token(authorization), body.model_dump())
    except browser_collector.CollectorError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/browser-crawl/sessions/{crawl_id}/finish")
def finish_browser_crawl(crawl_id: int, authorization: Optional[str] = Header(default=None), db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        return crawl_runs.view(browser_collector.finish(db, crawl_id, _collector_token(authorization)))
    except browser_collector.CollectorError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/browser-crawl/sessions/{crawl_id}/fail")
def fail_browser_crawl(crawl_id: int, body: BrowserFailIn, authorization: Optional[str] = Header(default=None), db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        return crawl_runs.view(browser_collector.fail(db, crawl_id, _collector_token(authorization), body.message))
    except browser_collector.CollectorError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/journey-crawls/{crawl_id}/cancel-browser")
def cancel_browser_crawl(
    crawl_id: int,
    body: Optional[BrowserCancelIn] = None,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
) -> dict[str, Any]:
    """Stop an incomplete browser-owned crawl from Automation Studio."""
    try:
        return crawl_runs.view(browser_collector.cancel(db, crawl_id, message=(body.message if body else "Browser crawl stopped by the user.")))
    except (browser_collector.CollectorError, LookupError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/walk/capabilities")
def walk_capabilities(current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    """What a walk can do on this server: show a browser, and which environments it refuses."""
    return {"headed_available": crawl_runs.headed_available(), "blocked_environments": crawl_runs.blocked_environments()}


@router.get("/{app_id}/walk/flows")
def walk_flows(app_id: str, current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    """The flow blueprints a dry run can walk, besides the journeys."""
    try:
        return {"flows": crawl_runs.flows(app_id)}
    except Exception as exc:  # noqa: BLE001
        _fail(exc)


@router.get("/{app_id}/journey-crawl/plan")
def preview_crawl_plan(
    app_id: str,
    journey_id: str = Query(...),
    profile_id: Optional[str] = Query(default=None),
    stop_before: Optional[int] = Query(default=None, ge=1),
    allow_risky: bool = Query(default=False),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
) -> dict[str, Any]:
    try:
        return crawl_runs.preview(app_id, journey_id, profile_id, stop_before=stop_before, allow_risky=allow_risky)
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


@router.get("/capture-tool.js")
def capture_tool(current_user: dict = Depends(require_permission(PERM_VIEW))) -> Response:
    """The browser capture tool: run as a bookmarklet or pasted into the DevTools console."""
    from ..services.journeys import journey_capture

    return Response(content=journey_capture.snippet_js(), media_type="application/javascript; charset=utf-8",
                    headers={"Cache-Control": "no-store"})


@router.post("/{app_id}/journey-crawl/import", status_code=201)
async def import_capture(
    app_id: str,
    file: UploadFile = File(...),
    journey_id: str = Form(...),
    application_id: Optional[int] = Form(default=None),
    environment: Optional[str] = Form(default=None),
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
) -> dict[str, Any]:
    """A capture from the browser tool (zip or .json), evaluated as a walk of `journey_id`."""
    from fastapi.concurrency import run_in_threadpool
    from ..services.journeys import journey_capture

    data = await file.read(journey_capture.MAX_BYTES + 1)
    try:
        crawl = await run_in_threadpool(
            journey_capture.import_capture, db, app_id=app_id, journey_id=journey_id, application_id=application_id,
            environment=(environment or "").strip() or None, filename=file.filename or "capture.zip", data=data,
            actor=_actor(current_user),
        )
    except journey_capture.CaptureError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    return crawl_runs.view(crawl)


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
    run = crawl_runs.absorb(db, run)
    if (run.plan or {}).get("source") == browser_collector.SOURCE:
        run = browser_collector.ensure_terminal_result(db, run)
    return crawl_runs.view(run)


@router.get("/journey-crawls/{crawl_id}/live")
def crawl_live(crawl_id: int, db: Session = Depends(get_db), current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    """A walk as it runs: steps so far, the one under way, and the time of the latest frame."""
    crawl = db.get(KbCrawlRun, crawl_id)
    if crawl is None:
        raise HTTPException(status_code=404, detail="No such crawl.")
    crawl_runs.absorb(db, crawl)
    return crawl_runs.live(db, crawl)


_WALK_IMAGE = re.compile(r"^(live|shot-(\d{1,4}|end))\.png$")


@router.get("/journey-crawls/{crawl_id}/image/{name}")
def crawl_image(crawl_id: int, name: str, db: Session = Depends(get_db),
                current_user: dict = Depends(require_permission(PERM_VIEW))) -> Response:
    """The live frame (live.png) or a step's screenshot (shot-<n>.png) of a walk."""
    if not _WALK_IMAGE.match(name):
        raise HTTPException(status_code=400, detail="Only live.png and shot-<n>.png are served.")
    crawl = db.get(KbCrawlRun, crawl_id)
    if crawl is None:
        raise HTTPException(status_code=404, detail="No such crawl.")
    path = crawl_runs.run_file(db, crawl, name)
    if path is None:
        raise HTTPException(status_code=404, detail="No image yet.")
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise HTTPException(status_code=404, detail="No image yet.") from exc
    return Response(content=data, media_type="image/png", headers={"Cache-Control": "no-store"})


class PickIn(BaseModel):
    screen_id: str
    element_id: str
    selector: str = Field(min_length=1, max_length=1000)


class ProposeIn(BaseModel):
    # App-only elements to add to the Journey KB: "<screen_id>|<selector>".
    additions: list[str] = Field(default_factory=list, max_length=300)
    # A candidate chosen for an element (or flow step) the walk could not find.
    picks: list[PickIn] = Field(default_factory=list, max_length=100)


@router.post("/journey-crawls/{crawl_id}/propose")
def propose_from_crawl(
    crawl_id: int,
    body: Optional[ProposeIn] = None,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
) -> dict[str, Any]:
    body = body or ProposeIn()
    try:
        run = crawl_runs.propose(db, crawl_id, actor=_actor(current_user), additions=body.additions,
                                 picks=[p.model_dump() for p in body.picks])
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    return crawl_runs.view(run)


@router.post("/journey-crawls/{crawl_id}/generate-flow")
def generate_flow_from_crawl(
    crawl_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
) -> dict[str, Any]:
    """A flow blueprint from a journey walk, drafted for review."""
    try:
        return crawl_runs.generate_flow(db, crawl_id, actor=_actor(current_user))
    except Exception as exc:  # noqa: BLE001
        _fail(exc)


# --- Recording a journey -------------------------------------------------------------------
# A person does the journey in a browser the server opens; what they did becomes
# the journey's steps (journey_record). Watched and listed like a walk.

class RecordIn(BaseModel):
    journey_id: str
    application_id: int
    environment: Optional[str] = None


class RecordedStepIn(BaseModel):
    action: str = Field(min_length=1, max_length=1000)
    expected_result: str = Field(default="", max_length=1000)
    recorded: Optional[dict[str, Any]] = None


class RecordSaveIn(BaseModel):
    steps: list[RecordedStepIn] = Field(min_length=1, max_length=200)
    # For a journey with no flow blueprint: an existing flow_id to link, or "new" (the default).
    link_flow: Optional[str] = None
    publish: bool = False


@router.post("/{app_id}/journey-record", status_code=202)
def start_recording(app_id: str, body: RecordIn, db: Session = Depends(get_db),
                    current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    try:
        crawl = journey_record.start(db, app_id=app_id, actor=_actor(current_user), **body.model_dump())
    except crawl_runs.Unavailable as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    return crawl_runs.view(crawl)


@router.post("/journey-crawls/{crawl_id}/finish")
def finish_recording(crawl_id: int, db: Session = Depends(get_db),
                     current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    crawl = db.get(KbCrawlRun, crawl_id)
    if crawl is None:
        raise HTTPException(status_code=404, detail="No such recording.")
    try:
        journey_record.finish(db, crawl)
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    return {"finishing": True}


@router.post("/journey-crawls/{crawl_id}/save-recording")
def save_recording(crawl_id: int, body: RecordSaveIn, db: Session = Depends(get_db),
                   current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    """The reviewed recording as the journey's steps, with its flow regenerated: drafted as one pair."""
    try:
        created = journey_record.save(db, crawl_id, [s.model_dump() for s in body.steps], link_flow=body.link_flow,
                                      actor=_actor(current_user))
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    lead = created["journey"] or created["automation"]
    result = _edited(db, lead, current_user, body.publish)
    if created["journey"] is not None and created["automation"] is not None:
        db.refresh(created["automation"])
        result["flow_change_set"] = changesets.change_set_view(created["automation"])
    return result


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
    kb = _kb(app_id)
    documents.recover_stalled(db, app_id)
    rows = db.query(KbSourceDocument).filter(KbSourceDocument.app_id == app_id).order_by(KbSourceDocument.id.desc()).all()
    return {"documents": [{**documents.view(db, d), "conversion": doc_convert.state(kb, d)} for d in rows],
            "vision_model": documents.vision_model()}


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
    documents.recover_stalled(db)
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


class ConvertIn(BaseModel):
    mode: Literal["ai", "text"] = "ai"
    images: bool = True


@router.get("/documents/{doc_id}/convert")
def get_conversion(doc_id: int, db: Session = Depends(get_db),
                   current_user: dict = Depends(require_permission(PERM_VIEW))) -> dict[str, Any]:
    doc = _document(db, doc_id)
    return doc_convert.state(_kb(doc.app_id), doc)


@router.post("/documents/{doc_id}/convert", status_code=202)
def convert_document(doc_id: int, body: ConvertIn, db: Session = Depends(get_db),
                     current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    """Write the PDF up as a structured Word document, page by page, in the background."""
    doc = _document(db, doc_id)
    try:
        return doc_convert.start(_kb(doc.app_id), doc, mode=body.mode, images=body.images)
    except documents.DocumentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/documents/{doc_id}/convert.docx")
def download_conversion(doc_id: int, db: Session = Depends(get_db),
                        current_user: dict = Depends(require_permission(PERM_VIEW))) -> Response:
    doc = _document(db, doc_id)
    try:
        blob = doc_convert.docx_bytes(_kb(doc.app_id), doc)
    except documents.DocumentError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    name = doc_convert.docx_name(doc)
    ascii_name = re.sub(r"[^A-Za-z0-9._ ()-]+", "_", name)
    from urllib.parse import quote
    return Response(content=blob, media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    headers={"Content-Disposition": f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}"})


@router.post("/documents/{doc_id}/convert/add", status_code=201)
def add_conversion(doc_id: int, response: Response, db: Session = Depends(get_db),
                   current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    """Keep the structured Word document as a Knowledge Base document of its own, ready to extract."""
    doc = _document(db, doc_id)
    kb = _kb(doc.app_id)
    try:
        new, is_new = documents.store_upload(db, kb, filename=doc_convert.docx_name(doc),
                                             contents=doc_convert.docx_bytes(kb, doc), doc_kind=doc.doc_kind,
                                             actor=_actor(current_user))
    except documents.DocumentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not is_new:
        response.status_code = 200
    return {**documents.view(db, new), "duplicate": not is_new}


class PlacementIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    # The chapter or journey to add it under, or a chapter to create for it.
    parent_id: Optional[str] = None
    new_chapter: Optional[str] = Field(default=None, max_length=200)


class PlaceIn(BaseModel):
    placements: list[PlacementIn] = Field(min_length=1, max_length=100)
    publish: bool = True


@router.post("/documents/{doc_id}/place")
def place_document_journeys(doc_id: int, body: PlaceIn, db: Session = Depends(get_db),
                            current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    """Add the journeys a document describes but the master list lacks, then
    match the document again. One change set; published at once when the user
    may approve, otherwise it waits in the drawer and Match again follows."""
    doc = _document(db, doc_id)
    kb = _kb(doc.app_id)
    try:
        chapters = list(dict.fromkeys(p.new_chapter.strip() for p in body.placements if (p.new_chapter or "").strip()))
        wanted = [(None, c) for c in chapters]
        wanted += [(("new", p.new_chapter.strip()) if (p.new_chapter or "").strip() else p.parent_id, p.title) for p in body.placements]
        if any(parent is None for parent, _ in wanted[len(chapters):]):
            raise editing.EditError("Choose where each journey goes: a chapter, or a new one.")
        created = editing.add_many(db, kb, wanted, actor=_actor(current_user),
                                   description=f"Journeys described by {doc.filename}")
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    result = _edited(db, created, current_user, body.publish)
    if result.get("published"):
        db.refresh(doc)
        try:
            documents.rematch(db, store.load(doc.app_id), doc)
        except documents.DocumentError as exc:
            result["message"] = str(exc)
    return {**result, "document": documents.view(db, doc, with_extraction=True)}


@router.post("/documents/{doc_id}/rematch")
def rematch_document(doc_id: int, db: Session = Depends(get_db),
                     current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    doc = _document(db, doc_id)
    try:
        documents.rematch(db, _kb(doc.app_id), doc)
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    return documents.view(db, doc, with_extraction=True)


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
    mode: Literal["server", "device", "collector"] = "server"
    wait_seconds: int = Field(default=20, ge=2, le=120)
    retry_count: int = Field(default=2, ge=0, le=10)
    max_pages: int = Field(default=20, ge=1, le=browser_collector.MAX_PAGES)
    headed: bool = False


@router.post("/heals/{heal_id}/crawl", status_code=202)
def heal_crawl(heal_id: int, body: HealCrawlIn, db: Session = Depends(get_db),
               current_user: dict = Depends(require_permission(PERM_EXECUTE))) -> dict[str, Any]:
    try:
        row, crawl, token = heal.crawl(
            db, heal_id, journey_id=body.journey_id, application_id=body.application_id,
            environment=body.environment, actor=_actor(current_user), mode=body.mode,
            wait_seconds=body.wait_seconds, retry_count=body.retry_count,
            max_pages=body.max_pages, headed=body.headed,
        )
    except crawl_runs.Unavailable as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except (local_runner.LocalRunnerError, browser_collector.CollectorError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        _fail(exc)
    result = {
        "heal": heal.view(db, row),
        "crawl": crawl_runs.view(crawl),
        "mode": body.mode,
    }
    if body.mode == "device":
        result.update(runner_token=token, expires_in_minutes=local_runner.SESSION_MINUTES)
    elif body.mode == "collector":
        result.update(collector_token=token, expires_in_minutes=browser_collector.SESSION_MINUTES)
    return result
