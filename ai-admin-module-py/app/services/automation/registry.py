"""
--- Applications: one registry, an address per environment -------------------------

Applications are registered and managed in one place: AI Test Automation >
Test Data (AutomationDataApp). Each has an address per environment
(AutomationDataAppEnvironment) -- SIT at one host, RC at another -- and a
default environment for cases that name none.

Two other tables used to be registered separately and are now derived:

  * AutomationApplication -- what Discovery crawls, the Knowledge Base page
    selects and a journey crawl walks. One row per application, keyed by its
    Knowledge Base folder (`app_key`). sync_crawl_app() keeps it in step with
    the Test Data application: name, default environment and that
    environment's address. Its crawl sign-in (auth_mode / credentials) is still
    edited in Discovery and is never overwritten here.

  * AutomationDataApp.url_prefix -- the single address applications had before
    environments had their own. It now mirrors the default environment's
    address, and is read as that environment's address for an application
    saved before environments existed (addresses()).

merge_registries() folds what was registered separately into this registry. It
is idempotent and runs on every start (database/init_db.py), so a deployment
needs no manual step; add_app_environments.py runs it on demand with --check.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict, Iterable, Optional

from sqlalchemy.orm import Session

from ...models.automation import AutomationApplication, AutomationDataApp, AutomationDataAppEnvironment

logger = logging.getLogger(__name__)

DEFAULT_ENVIRONMENT = "SIT"
_APP_KEY = re.compile(r"[^a-z0-9_-]+")


def normalize_environment(value: Optional[str]) -> str:
    return (value or "").strip().upper()


def normalize_address(value: Optional[str]) -> Optional[str]:
    """scheme://host/folders, without a page or query; None when it is not an http(s) address."""
    from .test_data import url_prefix

    return url_prefix((value or "").strip()) or None


def origin(address: Optional[str]) -> Optional[str]:
    """scheme://host -- what a generated script's BASE_URL holds."""
    match = re.match(r"(https?://[^/?#]+)", (address or "").strip())
    return match.group(1) if match else None


def default_environment(app: Optional[AutomationDataApp]) -> str:
    return normalize_environment(getattr(app, "run_environment", None)) or DEFAULT_ENVIRONMENT


def addresses(app: Optional[AutomationDataApp]) -> Dict[str, str]:
    """{environment: address}. An application saved before environments had
    their own addresses reads its single address as its default environment's."""
    if app is None:
        return {}
    out = {row.environment: row.address for row in (app.environments or []) if row.address}
    if not out and app.url_prefix:
        out[default_environment(app)] = app.url_prefix
    return out


def address_for(app: Optional[AutomationDataApp], environment: Optional[str]) -> Optional[str]:
    """Where `environment` runs; None when that environment has no address of its own."""
    return addresses(app).get(normalize_environment(environment)) if app is not None else None


def set_addresses(app: AutomationDataApp, wanted: Dict[str, Optional[str]], *, actor: Optional[str]) -> None:
    """Replace the addresses of the environments named in `wanted`; "" or None removes one.

    Environments not named keep theirs. url_prefix follows the default environment.
    """
    if not app.environments and app.url_prefix:
        # Materialise a legacy single address before editing around it.
        app.environments.append(AutomationDataAppEnvironment(
            environment=default_environment(app), address=app.url_prefix, updated_by=actor))
    rows = {row.environment: row for row in app.environments}
    for raw_env, raw_address in wanted.items():
        env = normalize_environment(raw_env)
        if not env or env in ("*", "ALL"):
            raise ValueError("An address belongs to one environment, not all of them.")
        address = normalize_address(raw_address) if (raw_address or "").strip() else None
        if (raw_address or "").strip() and address is None:
            raise ValueError(f"{env}: '{raw_address}' is not an http(s) address.")
        if address is None:
            if env in rows:
                app.environments.remove(rows.pop(env))
            continue
        if env in rows:
            if rows[env].address != address:
                rows[env].address = address
                rows[env].updated_by = actor
        else:
            rows[env] = AutomationDataAppEnvironment(environment=env, address=address, updated_by=actor)
            app.environments.append(rows[env])
    app.url_prefix = rows[default_environment(app)].address if default_environment(app) in rows else None


def address_conflicts(db: Session, app: AutomationDataApp) -> list[str]:
    """Problems with an application's addresses: another application at the
    same address (a run could not tell them apart), or two of its environments
    at one address (almost always a copy-paste slip)."""
    mine = addresses(app)
    problems: list[str] = []
    seen: Dict[str, str] = {}
    for env, address in sorted(mine.items()):
        key = address.lower()
        if key in seen:
            problems.append(f"{seen[key]} and {env} have the same address, {address}.")
        seen.setdefault(key, env)
    for other in db.query(AutomationDataApp).filter(AutomationDataApp.id != app.id).all():
        for env, address in addresses(other).items():
            if address.lower() in seen:
                problems.append(f"{address} is already {other.name}'s {env} address.")
    return problems


# --- The crawl registry, derived ----------------------------------------------------------

def crawl_key(app: AutomationDataApp) -> str:
    """The Knowledge Base folder the application crawls into: its KB, else its name as a slug."""
    if app.kb_app_id:
        return app.kb_app_id
    return _APP_KEY.sub("_", (app.name or "").strip().lower()).strip("_")[:100] or f"app_{app.id}"


def crawl_app_for(db: Session, app: AutomationDataApp) -> Optional[AutomationApplication]:
    return db.query(AutomationApplication).filter(AutomationApplication.app_key == crawl_key(app)).first()


def sync_crawl_app(db: Session, app: AutomationDataApp, *, actor: Optional[str]) -> Optional[AutomationApplication]:
    """Keep the application Discovery and the Knowledge Base page work on in step with this one.

    Name, default environment and its address are copied; crawl sign-in is
    left as Discovery set it. No address yet: nothing to crawl, so nothing is
    created (an existing row is renamed only).
    """
    env = default_environment(app)
    address = address_for(app, env) or next(iter(addresses(app).values()), None)
    row = crawl_app_for(db, app)
    if row is None:
        if not address:
            return None
        row = AutomationApplication(app_key=crawl_key(app), name=app.name, base_url=address,
                                    environment=env, is_active=True, created_by=actor)
        db.add(row)
        return row
    row.name = app.name
    row.is_active = True
    if address:
        row.base_url = address
        row.environment = env
    return row


def retire_crawl_app(db: Session, app: AutomationDataApp) -> None:
    """An application deleted from Test Data stops being offered for crawls; its history stays."""
    row = crawl_app_for(db, app)
    if row is not None:
        row.is_active = False


def address_for_crawl(db: Session, app_key: str, environment: Optional[str]) -> Optional[str]:
    """The address of the Test Data application behind crawl key `app_key`, in `environment`."""
    for app in db.query(AutomationDataApp).all():
        if crawl_key(app) == app_key:
            return address_for(app, environment)
    return None


def merge_registries(db: Session, *, apply: bool = True) -> Dict[str, Any]:
    """Fold what was registered separately into Test Data. Idempotent.

    * an application with a single address gets it as its default
      environment's address;
    * an application registered only in Discovery or on the Knowledge Base
      page becomes a Test Data application, with that address for its
      environment;
    * one registered in both gets the Discovery address for that environment
      when it has none of its own there.
    """
    report: Dict[str, list] = {"addresses_backfilled": [], "apps_created": [], "addresses_added": []}
    apps = db.query(AutomationDataApp).all()
    for app in apps:
        if not app.environments and app.url_prefix:
            report["addresses_backfilled"].append(f"{app.name} {default_environment(app)}")
            if apply:
                app.environments.append(AutomationDataAppEnvironment(
                    environment=default_environment(app), address=app.url_prefix, updated_by="migration"))
    by_key = {crawl_key(app): app for app in apps}
    names = {app.name.lower() for app in apps}
    for crawl in db.query(AutomationApplication).filter(AutomationApplication.is_active.is_(True)).all():
        env = normalize_environment(crawl.environment) or DEFAULT_ENVIRONMENT
        address = normalize_address(crawl.base_url)
        app = by_key.get(crawl.app_key)
        if app is None:
            name = crawl.name if crawl.name.lower() not in names else f"{crawl.name} ({crawl.app_key})"
            report["apps_created"].append(f"{name} {env}")
            if apply:
                app = AutomationDataApp(name=name, kb_app_id=crawl.app_key, url_prefix=address,
                                        run_environment=env, created_by=crawl.created_by or "migration")
                if address:
                    app.environments.append(AutomationDataAppEnvironment(environment=env, address=address, updated_by="migration"))
                db.add(app)
                names.add(name.lower())
                by_key[crawl.app_key] = app
            continue
        if address and env not in {row.environment for row in app.environments} and env not in addresses(app):
            report["addresses_added"].append(f"{app.name} {env}")
            if apply:
                app.environments.append(AutomationDataAppEnvironment(environment=env, address=address, updated_by="migration"))
    if apply:
        db.commit()
    return report


def run_on_startup() -> None:
    """merge_registries() on start; reported, never fatal."""
    from ...database.connection import SessionLocal

    db = SessionLocal()
    try:
        report = merge_registries(db)
        changed = {k: v for k, v in report.items() if v}
        if changed:
            print(f"[Database Init] Applications merged into Test Data: {changed}")
    except Exception:  # noqa: BLE001 - the app starts either way; the page still works on url_prefix
        db.rollback()
        logger.exception("Merging the application registries failed")
    finally:
        db.close()


def data_app_for_kb(db: Session, kb_app_id: str) -> Optional[AutomationDataApp]:
    """The Test Data application behind Knowledge Base application `kb_app_id`."""
    for app in db.query(AutomationDataApp).all():
        if crawl_key(app) == kb_app_id:
            return app
    return None


def environments_for_kb(db: Session, kb_app_id: str) -> Dict[str, Any]:
    """The environments a Knowledge Base application has addresses for, and its default."""
    app = data_app_for_kb(db, kb_app_id)
    if app is None:
        return {"application": None, "default": None, "addresses": {}}
    return {"application": {"id": app.id, "name": app.name}, "default": default_environment(app), "addresses": addresses(app)}


def rehome_for_environment(db: Session, url: Optional[str], environment: Optional[str]) -> Optional[str]:
    """`url` moved onto `environment`'s host, path and query kept.

    The application is the one the URL belongs to (by any of its addresses or
    its Knowledge Base). Returned unchanged when that environment has no
    address in Test Data, or the URL names no application.
    """
    raw = (url or "").strip()
    env = normalize_environment(environment)
    if not raw or not env:
        return url
    from .test_data import find_app

    app = find_app(db, urls=(raw,))
    target = origin(address_for(app, env))
    current = origin(raw)
    if not target or not current or target == current:
        return url
    return target + raw[len(current):]


def summary(app: AutomationDataApp, environments: Iterable[str]) -> list[Dict[str, Any]]:
    """Per environment: its address and how many of its values are set."""
    mine = addresses(app)
    out = []
    for env in environments:
        entries = [e for e in app.entries if e.environment == env]
        out.append({
            "environment": env,
            "address": mine.get(env),
            "values": len(entries),
            "values_set": sum(1 for e in entries if e.value),
            "is_default": env == default_environment(app),
        })
    return out
