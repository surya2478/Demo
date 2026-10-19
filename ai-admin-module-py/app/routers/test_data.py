"""
--- Test Data ------------------------------------------------------------------

Applications and the values their tests read -- usernames, passwords, OTPs,
record names -- per environment: the one data source for automation test
cases. Each application names the environment its scripts run against, and
the Knowledge Base's data profiles (roles.json test_data_profiles) are checked
against these values rather than holding any of their own. See
services/automation/test_data.py for how a run finds and uses them.

Secret values are encrypted on save and never returned: the page shows that
one is set, and a new value replaces it.

This is also the one place applications are registered: each has an address
per environment, and the application Discovery and the Knowledge Base page
work on is kept in step from here (services/automation/registry.py).
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..database.connection import get_db
from ..models.automation import AutomationDataApp, AutomationScript, AutomationTestData
from ..services.authz import require_permission
from ..services.automation import environments, registry, test_data

router = APIRouter()

PERM_VIEW = "automation.view"
PERM_EXECUTE = "automation.execute"


def _actor(user: dict) -> str:
    return (user or {}).get("username") or "user"


def _environment(value: Optional[str]) -> str:
    value = (value or "").strip().upper()
    return test_data.ALL_ENVIRONMENTS if value in ("", "*", "ALL") else value


def _entry(entry: AutomationTestData) -> dict[str, Any]:
    return {
        "id": entry.id,
        "environment": entry.environment,
        "key": entry.key,
        # A secret is never sent back: only whether it is set.
        "value": None if entry.is_secret else entry.value,
        "has_value": bool(entry.value),
        "is_secret": bool(entry.is_secret),
        "aliases": entry.aliases or "",
        "updated_by": entry.updated_by,
        "updated_at": entry.updated_at.isoformat() if entry.updated_at else None,
    }


def _app(app: AutomationDataApp, environments: Optional[list[str]] = None) -> dict[str, Any]:
    present = {e.environment for e in app.entries if e.environment != test_data.ALL_ENVIRONMENTS}
    envs = test_data.ordered_environments([*(environments or []), *present, *registry.addresses(app)])
    return {
        "id": app.id,
        "name": app.name,
        "kb_app_id": app.kb_app_id,
        "url_prefix": app.url_prefix,
        "run_environment": test_data.run_environment(app),
        # {environment: address}; the page leads with the environment and fills
        # the address and values from it.
        "addresses": registry.addresses(app),
        "environment_summary": registry.summary(app, envs),
        "created_by": app.created_by,
        "entries": [_entry(e) for e in sorted(app.entries, key=lambda e: (e.environment != "*", e.environment, e.key))],
    }


class AppIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    kb_app_id: Optional[str] = Field(default=None, max_length=100)
    # The single address of an older client: the default environment's.
    url_prefix: Optional[str] = Field(default=None, max_length=2000)
    # The environment its scripts run against; omitted keeps the current one.
    run_environment: Optional[str] = Field(default=None, max_length=40)
    # {environment: address}; "" removes that environment's address, and an
    # environment left out keeps its own.
    addresses: Optional[dict[str, Optional[str]]] = None


def _apply_addresses(db: Session, app: AutomationDataApp, body: AppIn, actor: str) -> list[str]:
    """Set the addresses the request names; refuse one another application has. Returns warnings."""
    wanted = dict(body.addresses or {})
    if body.addresses is None and body.url_prefix is not None:
        wanted[registry.default_environment(app)] = body.url_prefix
    try:
        registry.set_addresses(app, wanted, actor=actor)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    problems = registry.address_conflicts(db, app)
    clashes = [p for p in problems if "already" in p]
    if clashes:
        raise HTTPException(status_code=409, detail=" ".join(clashes) + " Use a more specific address (with its folder).")
    return problems


def _run_environment(value: Optional[str]) -> Optional[str]:
    value = (value or "").strip().upper()
    if value in ("*", "ALL"):
        raise HTTPException(status_code=400, detail="Scripts run against one environment, not all of them.")
    return value or None


class EntryIn(BaseModel):
    id: Optional[int] = None
    environment: str = Field(default="SIT", max_length=40)
    key: str = Field(min_length=1, max_length=120)
    # Omitted (None) keeps a stored secret as it is; "" clears it.
    value: Optional[str] = Field(default=None, max_length=4000)
    is_secret: bool = False
    aliases: Optional[str] = Field(default=None, max_length=1000)


class EntriesIn(BaseModel):
    entries: list[EntryIn] = Field(default_factory=list, max_length=200)
    deleted_ids: list[int] = Field(default_factory=list, max_length=200)


def _environments(db: Session) -> list[str]:
    """The managed list (Manage environments), which also takes in any name in use."""
    return environments.names(db)


# --- Environments: the one list every environment choice offers --------------------------

class EnvironmentIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    after: Optional[str] = Field(default=None, max_length=40)


class EnvironmentRenameIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)


class EnvironmentOrderIn(BaseModel):
    names: list[str] = Field(min_length=1, max_length=100)


def _env_error(exc: Exception):
    if isinstance(exc, LookupError):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/environments")
def list_environments(db: Session = Depends(get_db), current_user: dict = Depends(require_permission(PERM_VIEW))):
    return {"environments": environments.view(db)}


@router.post("/environments", status_code=201)
def add_environment(body: EnvironmentIn, db: Session = Depends(get_db),
                    current_user: dict = Depends(require_permission(PERM_EXECUTE))):
    try:
        name = environments.add(db, body.name, actor=current_user.get("username"), after=body.after)
    except environments.EnvironmentError_ as exc:
        _env_error(exc)
    return {"name": name, "environments": environments.view(db)}


@router.patch("/environments/{name}")
def rename_environment(name: str, body: EnvironmentRenameIn, db: Session = Depends(get_db),
                       current_user: dict = Depends(require_permission(PERM_EXECUTE))):
    try:
        changed = environments.rename(db, name, body.name)
    except (environments.EnvironmentError_, LookupError) as exc:
        _env_error(exc)
    return {"changed": changed, "environments": environments.view(db)}


@router.delete("/environments/{name}")
def delete_environment(name: str, remove_data: bool = Query(False), db: Session = Depends(get_db),
                       current_user: dict = Depends(require_permission(PERM_EXECUTE))):
    try:
        removed = environments.delete(db, name, remove_data=remove_data)
    except (environments.EnvironmentError_, LookupError) as exc:
        _env_error(exc)
    return {"removed": removed, "environments": environments.view(db)}


@router.put("/environments/order")
def reorder_environments(body: EnvironmentOrderIn, db: Session = Depends(get_db),
                         current_user: dict = Depends(require_permission(PERM_EXECUTE))):
    try:
        environments.reorder(db, body.names)
    except environments.EnvironmentError_ as exc:
        _env_error(exc)
    return {"environments": environments.view(db)}


@router.get("/apps")
def list_apps(db: Session = Depends(get_db), current_user: dict = Depends(require_permission(PERM_VIEW))):
    apps = db.query(AutomationDataApp).order_by(AutomationDataApp.name).all()
    environments = _environments(db)
    return {"apps": [_app(app, environments) for app in apps], "environments": environments}


@router.get("/kb-apps")
def kb_apps(current_user: dict = Depends(require_permission(PERM_VIEW))):
    """Knowledge Base applications, to add one with its URL and usual values filled in."""
    from ..services.automation import knowledge_base as kb

    out = []
    for profile in kb.list_applications():
        app_id = profile.get("app_id") or profile.get("id")
        if not app_id:
            continue
        out.append(
            {
                "kb_app_id": app_id,
                "name": profile.get("app_name") or app_id,
                "url_prefix": test_data.url_prefix(profile.get("base_url")),
                "suggested": test_data.suggested_keys(app_id),
            }
        )
    return {"apps": sorted(out, key=lambda a: a["name"].lower())}


@router.post("/apps")
def create_app(
    body: AppIn,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    name = body.name.strip()
    if db.query(AutomationDataApp).filter(AutomationDataApp.name == name).first():
        raise HTTPException(status_code=409, detail=f"An application called {name} already exists.")
    app = AutomationDataApp(
        name=name,
        kb_app_id=(body.kb_app_id or "").strip() or None,
        run_environment=_run_environment(body.run_environment) or "SIT",
        created_by=_actor(current_user),
    )
    db.add(app)
    db.flush()
    warnings = _apply_addresses(db, app, body, _actor(current_user))
    registry.sync_crawl_app(db, app, actor=_actor(current_user))
    db.commit()
    db.refresh(app)
    return {**_app(app, _environments(db)), "warnings": warnings}


@router.put("/apps/{app_id}")
def update_app(
    app_id: int,
    body: AppIn,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    app = db.get(AutomationDataApp, app_id)
    if app is None:
        raise HTTPException(status_code=404, detail="Application not found.")
    name = body.name.strip()
    clash = db.query(AutomationDataApp).filter(AutomationDataApp.name == name, AutomationDataApp.id != app_id).first()
    if clash:
        raise HTTPException(status_code=409, detail=f"An application called {name} already exists.")
    # Without a kb_app_id the crawl key is the name's slug, so a rename would
    # point the application at a different (empty) Knowledge Base. Keep the key.
    old_key = registry.crawl_key(app)
    app.name = name
    app.kb_app_id = (body.kb_app_id or "").strip() or None
    if app.kb_app_id is None and registry.crawl_key(app) != old_key:
        app.kb_app_id = old_key
    if body.run_environment is not None:
        app.run_environment = _run_environment(body.run_environment) or "SIT"
    warnings = _apply_addresses(db, app, body, _actor(current_user))
    registry.sync_crawl_app(db, app, actor=_actor(current_user))
    db.commit()
    db.refresh(app)
    return {**_app(app, _environments(db)), "warnings": warnings}


@router.delete("/apps/{app_id}")
def delete_app(
    app_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    app = db.get(AutomationDataApp, app_id)
    if app is None:
        raise HTTPException(status_code=404, detail="Application not found.")
    registry.retire_crawl_app(db, app)
    db.delete(app)
    db.commit()
    return {"deleted": app_id}


@router.put("/apps/{app_id}/entries")
def save_entries(
    app_id: int,
    body: EntriesIn,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    """Add, change and remove an application's values in one save."""
    app = db.get(AutomationDataApp, app_id)
    if app is None:
        raise HTTPException(status_code=404, detail="Application not found.")
    actor = _actor(current_user)
    by_id = {e.id: e for e in app.entries}

    for entry_id in body.deleted_ids:
        entry = by_id.get(entry_id)
        if entry is not None:
            db.delete(entry)
            by_id.pop(entry_id, None)
    db.flush()

    seen: set[tuple[str, str]] = set()
    for item in body.entries:
        environment = _environment(item.environment)
        key = item.key.strip()
        if (environment, key.lower()) in seen:
            raise HTTPException(status_code=400, detail=f"{key} is listed twice for {environment}.")
        seen.add((environment, key.lower()))
        entry = by_id.get(item.id) if item.id else None
        if entry is None:
            entry = next((e for e in by_id.values() if e.environment == environment and e.key.lower() == key.lower()), None)
        if entry is None:
            entry = AutomationTestData(app_id=app.id, environment=environment, key=key)
            db.add(entry)
        was_secret = bool(entry.is_secret)
        entry.environment = environment
        entry.key = key
        entry.is_secret = item.is_secret
        entry.aliases = (item.aliases or "").strip() or None
        if item.value is not None:
            entry.value = (test_data.encrypt(item.value) if item.is_secret else item.value) if item.value != "" else None
        elif entry.value is not None and was_secret != item.is_secret:
            # Marked secret, or no longer secret, without a new value: convert.
            current = test_data.decrypt(entry.value) if was_secret else entry.value
            entry.value = test_data.encrypt(current) if item.is_secret and current is not None else current
        entry.updated_by = actor
    db.commit()
    db.refresh(app)
    return _app(app, _environments(db))


@router.get("/check")
def check_script(
    script_id: int = Query(...),
    environment: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
):
    """What a script needs from Test data, and what is missing.

    No environment means the application's own -- what a dry run will use.
    """
    script = db.get(AutomationScript, script_id)
    if script is None:
        raise HTTPException(status_code=404, detail="Script not found.")
    report = test_data.for_code(
        db,
        script.code or "",
        environment=environment,
        case_url=script.test_case.application_url if script.test_case else None,
        case_environment=script.test_case.environment if script.test_case else None,
    )
    return {**test_data.public(report), "message": test_data.missing_message(report)}


@router.get("/apps/{app_id}/knowledge-base")
def knowledge_base_profiles(
    app_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
):
    """The Knowledge Base's data profiles for this application, checked against its values.

    The Journey KB says which data its journeys need (roles.json
    test_data_profiles, by TESTDATA_* variable) and never holds a value; this is
    where those needs meet the values. Names and statuses only -- never a value.
    """
    from ..services.journeys import store as journey_store
    from ..services.journeys import workspace

    app = db.get(AutomationDataApp, app_id)
    if app is None:
        raise HTTPException(status_code=404, detail="Application not found.")
    if not app.kb_app_id:
        return {"journey_app": None, "profiles": [], "environments": [], "totals": {}, "run_environment": test_data.run_environment(app)}
    kb = None
    for journey_app in journey_store.list_apps():
        candidate = journey_store.load(journey_app)
        if candidate is not None and (candidate.automation_app_id == app.kb_app_id or candidate.app_id == app.kb_app_id):
            kb = candidate
            break
    if kb is None:
        return {"journey_app": None, "profiles": [], "environments": [], "totals": {}, "run_environment": test_data.run_environment(app)}
    coverage = workspace.test_data_coverage(kb, db)
    return {
        "journey_app": {"id": kb.app_id, "name": kb.app_name},
        "run_environment": test_data.run_environment(app),
        **coverage,
    }
