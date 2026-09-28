"""
--- Automation Studio: Test data ---------------------------------------------

Applications and the values their tests read -- usernames, passwords, OTPs,
record names -- per environment. See services/automation/test_data.py for how
a run finds and uses them.

Secret values are encrypted on save and never returned: the page shows that
one is set, and a new value replaces it.
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..database.connection import get_db
from ..models.automation import AutomationDataApp, AutomationScript, AutomationTestData
from ..services.authz import require_permission
from ..services.automation import test_data

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


def _app(app: AutomationDataApp) -> dict[str, Any]:
    return {
        "id": app.id,
        "name": app.name,
        "kb_app_id": app.kb_app_id,
        "url_prefix": app.url_prefix,
        "created_by": app.created_by,
        "entries": [_entry(e) for e in sorted(app.entries, key=lambda e: (e.environment != "*", e.environment, e.key))],
    }


class AppIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    kb_app_id: Optional[str] = Field(default=None, max_length=100)
    url_prefix: Optional[str] = Field(default=None, max_length=2000)


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


@router.get("/apps")
def list_apps(db: Session = Depends(get_db), current_user: dict = Depends(require_permission(PERM_VIEW))):
    apps = db.query(AutomationDataApp).order_by(AutomationDataApp.name).all()
    environments = sorted(
        {e for (e,) in db.query(AutomationTestData.environment).distinct() if e and e != "*"}
        | set(test_data.DEFAULT_ENVIRONMENTS)
    )
    return {"apps": [_app(app) for app in apps], "environments": environments}


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
        url_prefix=(body.url_prefix or "").strip().rstrip("/") or None,
        created_by=_actor(current_user),
    )
    db.add(app)
    db.commit()
    db.refresh(app)
    return _app(app)


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
    app.name = name
    app.kb_app_id = (body.kb_app_id or "").strip() or None
    app.url_prefix = (body.url_prefix or "").strip().rstrip("/") or None
    db.commit()
    return _app(app)


@router.delete("/apps/{app_id}")
def delete_app(
    app_id: int,
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_EXECUTE)),
):
    app = db.get(AutomationDataApp, app_id)
    if app is None:
        raise HTTPException(status_code=404, detail="Application not found.")
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
    return _app(app)


@router.get("/check")
def check_script(
    script_id: int = Query(...),
    environment: str = Query(default="SIT"),
    db: Session = Depends(get_db),
    current_user: dict = Depends(require_permission(PERM_VIEW)),
):
    """What a script needs from Test data in an environment, and what is missing."""
    script = db.get(AutomationScript, script_id)
    if script is None:
        raise HTTPException(status_code=404, detail="Script not found.")
    report = test_data.for_code(
        db,
        script.code or "",
        environment=environment,
        case_url=script.test_case.application_url if script.test_case else None,
    )
    return {**test_data.public(report), "message": test_data.missing_message(report)}
