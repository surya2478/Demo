"""
--- The applications a generation is for ----------------------------------------

Generate Test Cases asks for the application(s) up front -- Test Data
applications (AutomationDataApp), the one registry -- and every step after it
reads that choice instead of guessing from the case text.

Guessing is what went wrong. match_flow_blueprint scored every application's
flows on shared words, so "Business", "Payment" and "OTP" in a BRD for one
portal matched the B2B Portal's flows and the case was stamped with the B2B
URL. The words are common to many applications; only the user knows which one
a document is about.

A case carries its application in its row (test_case_details / source_row):

  "Application"  -- the name, a visible column, as the grid and Review show it.
  "_app"         -- {"id", "name", "kb_app_id"}: the exact link, apart from the
                    columns the way "_ai" is.
  "_apps"        -- the applications the generation was for, so a case left
                    unassigned is still only ever matched within them.

assign() decides, in order: a case already linked; the "Application" column
the model wrote, when it names a chosen application; the only chosen
application; then the case's own evidence, compared ONLY across the chosen
applications. With several chosen and nothing to tell them apart it returns
None -- an unassigned case gets no URL and says so, rather than a guess.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any, Iterable, Optional

from sqlalchemy.orm import Session

from . import knowledge_base as kb

logger = logging.getLogger(__name__)

APP_KEY = "_app"
SCOPE_KEY = "_apps"
COLUMN = "Application"

_URL = re.compile(r"https?://[^\s'\"\)|]+")


@dataclass(frozen=True)
class AppChoice:
    id: int
    name: str
    # The Automation KB folder it crawls into (registry.crawl_key).
    kb_app_id: str

    def ref(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "kb_app_id": self.kb_app_id}


def _norm(value: Any) -> str:
    return " ".join(str(value or "").split()).casefold()


# --- Reading the choice -----------------------------------------------------------

def choices(db: Session, values: Iterable[Any]) -> list[AppChoice]:
    """The chosen Test Data applications, in the order given.

    Accepts ids, or refs ({"id": ...}) as a saved session stores them. Raises
    ValueError naming any that no longer exist, so a stale choice is refused
    rather than silently dropped.
    """
    from ...models.automation import AutomationDataApp
    from .registry import crawl_key

    ids: list[int] = []
    for value in values or []:
        raw = value.get("id") if isinstance(value, dict) else value
        try:
            app_id = int(raw)
        except (TypeError, ValueError):
            raise ValueError(f"Unknown application: {raw!r}.") from None
        if app_id not in ids:
            ids.append(app_id)
    if not ids:
        return []
    rows = {app.id: app for app in db.query(AutomationDataApp).filter(AutomationDataApp.id.in_(ids)).all()}
    missing = [str(i) for i in ids if i not in rows]
    if missing:
        raise ValueError(f"Application(s) {', '.join(missing)} no longer exist in Test Data. Choose the application again.")
    return [AppChoice(id=i, name=rows[i].name, kb_app_id=crawl_key(rows[i])) for i in ids]


def from_refs(refs: Any) -> list[AppChoice]:
    """Choices from stored refs (a row's "_apps", a session's "applications")."""
    out: list[AppChoice] = []
    for ref in refs or []:
        if not isinstance(ref, dict):
            continue
        try:
            out.append(AppChoice(id=int(ref["id"]), name=str(ref.get("name") or ""), kb_app_id=str(ref.get("kb_app_id") or "")))
        except (KeyError, TypeError, ValueError):
            continue
    return out


def linked(details: Any) -> Optional[AppChoice]:
    """The application a row is linked to, or None."""
    if not isinstance(details, dict):
        return None
    found = from_refs([details.get(APP_KEY)])
    return found[0] if found else None


def scope_of(details: Any) -> list[AppChoice]:
    return from_refs(details.get(SCOPE_KEY)) if isinstance(details, dict) else []


# --- Deciding which chosen application a case is for --------------------------

def _case_text(details: dict[str, Any]) -> str:
    from .workbench import detail_value

    return " ".join(
        detail_value(details, field)
        for field in ("category", "description", "preconditions", "steps", "expected", "test_data")
    )


def _named_in_column(details: dict[str, Any], scope: list[AppChoice]) -> Optional[AppChoice]:
    value = ""
    for key, item in details.items():
        if re.sub(r"[^a-z]+", "", str(key).lower()) in ("application", "applicationname", "app"):
            value = _norm(item)
            if value:
                break
    if not value:
        return None
    for choice in scope:
        if value in (_norm(choice.name), _norm(choice.kb_app_id)):
            return choice
    return None


def _evidence(text: str, scope: list[AppChoice]) -> Optional[AppChoice]:
    """The one chosen application the case's own text points at, or None.

    Only the chosen applications compete, and only on evidence that tells
    them apart: the application's name, one of its addresses, or a flow match
    carrying a keyword or a whole product name (the bar
    testcases.describe_grounding sets -- a single shared word is not evidence).
    """
    lowered = (text or "").lower()
    if not lowered.strip():
        return None

    named = [c for c in scope if len(c.name.strip()) >= 3 and _norm(c.name) in _norm(text)]
    if len(named) == 1:
        return named[0]

    origins = _origins_by_choice(scope)
    hit = [c for c in scope if any(o in lowered for o in origins.get(c.id, ()))]
    if len(hit) == 1:
        return hit[0]

    keys = [c.kb_app_id for c in scope if c.kb_app_id]
    if keys:
        try:
            flow = kb.match_flow_blueprint(text, only_apps=keys) or {}
        except Exception:  # noqa: BLE001 - evidence is optional; no match means unassigned
            flow = {}
        if flow and _has_evidence(flow, lowered):
            winner = [c for c in scope if c.kb_app_id == flow.get("_app_id")]
            if len(winner) == 1:
                return winner[0]
    return None


def _has_evidence(flow: dict[str, Any], lowered: str) -> bool:
    for keyword in flow.get("target_match_keywords") or []:
        word = str(keyword).lower().strip()
        if word and re.search(r"\b" + re.escape(word) + r"\b", lowered):
            return True
    return any(str(p).lower().strip() and str(p).lower().strip() in lowered for p in (flow.get("known_products") or {}))


def _origins_by_choice(scope: list[AppChoice]) -> dict[int, set[str]]:
    """Per chosen application, the hosts it is known by (profile + Test Data)."""
    out: dict[int, set[str]] = {}
    addresses = _addresses_by_id([c.id for c in scope])
    for choice in scope:
        hosts = set()
        profile = kb.load_exact_profile(choice.kb_app_id) or {}
        for address in [profile.get("base_url"), *addresses.get(choice.id, {}).values()]:
            host = re.sub(r"^[a-z]+://", "", str(address or "").strip().lower()).rstrip("/")
            if len(host) >= 5:
                hosts.add(host)
        out[choice.id] = hosts
    # A host two chosen applications share tells them apart no better than a shared word.
    shared = {h for c in scope for h in out[c.id] if sum(h in out[o.id] for o in scope) > 1}
    return {cid: hosts - shared for cid, hosts in out.items()}


def _addresses_by_id(ids: list[int]) -> dict[int, dict[str, str]]:
    try:
        from ...database.connection import SessionLocal
        from ...models.automation import AutomationDataApp
        from .registry import addresses

        db = SessionLocal()
        try:
            return {app.id: addresses(app) for app in db.query(AutomationDataApp).filter(AutomationDataApp.id.in_(ids)).all()}
        finally:
            db.close()
    except Exception:  # noqa: BLE001 - addresses are one kind of evidence among several
        return {}


def assign(details: dict[str, Any], scope: list[AppChoice]) -> Optional[AppChoice]:
    """Which chosen application this case is for, or None when it cannot be told."""
    if not scope:
        return None
    current = linked(details)
    if current and any(c.id == current.id for c in scope):
        return next(c for c in scope if c.id == current.id)
    named = _named_in_column(details, scope)
    if named:
        return named
    if len(scope) == 1:
        return scope[0]
    return _evidence(_case_text(details), scope)


def stamp(details: dict[str, Any], scope: list[AppChoice]) -> Optional[AppChoice]:
    """Link a row to its application, in place. Returns the application, or None."""
    if not isinstance(details, dict) or not scope:
        return None
    choice = assign(details, scope)
    if choice is None:
        details[SCOPE_KEY] = [c.ref() for c in scope]
        details.pop(APP_KEY, None)
        details[COLUMN] = ""
        return None
    link(details, choice, scope)
    return choice


def link(details: dict[str, Any], choice: AppChoice, scope: list[AppChoice]) -> None:
    """Link a row to `choice`, in place -- what the author picked, no inference."""
    details[SCOPE_KEY] = [c.ref() for c in scope]
    details[APP_KEY] = choice.ref()
    details[COLUMN] = choice.name


def carry_by_case(rows: list[dict[str, Any]], saved: Iterable[Any]) -> None:
    """Give page rows (parsed from the table, no links) the links their saved
    rows hold, matched by Test Case ID -- so a case the author assigned by hand
    keeps that application when AI Checks start from the table."""
    from .workbench import detail_value

    by_display = {}
    for details in saved:
        if isinstance(details, dict) and linked(details):
            by_display.setdefault(detail_value(details, "display_id"), details)
    for row in rows:
        if isinstance(row, dict) and not linked(row):
            previous = by_display.get(detail_value(row, "display_id"))
            if previous:
                carry(row, previous)


def carry(details: dict[str, Any], previous: Any) -> None:
    """Keep a saved row's link when the page sends the case back without it."""
    if not isinstance(details, dict) or not isinstance(previous, dict):
        return
    for key in (APP_KEY, SCOPE_KEY):
        if key not in details and key in previous:
            details[key] = previous[key]
    if not str(details.get(COLUMN) or "").strip() and previous.get(COLUMN):
        details[COLUMN] = previous[COLUMN]


def for_row(details: Any) -> tuple[Optional[AppChoice], bool]:
    """(application, chosen) for a row. `chosen` is True when the generation
    named applications, whether or not this case could be assigned: such a case
    must never fall back to guessing across every application."""
    if not isinstance(details, dict):
        return None, False
    choice = linked(details)
    if choice:
        return choice, True
    scope = scope_of(details)
    if scope:
        return assign(details, scope), True
    return None, False


# --- Where a case for an application runs ---------------------------------------

def profile(choice: Optional[AppChoice]) -> dict[str, Any]:
    """The application's own Automation KB profile; {} before it has one."""
    return (kb.load_exact_profile(choice.kb_app_id) if choice and choice.kb_app_id else None) or {}


def url_for(db: Session, choice: AppChoice, text: str, environment: Optional[str] = None) -> Optional[str]:
    """The address a case for `choice` opens.

    A URL the case names is kept only when it belongs to this application (its
    profile's host or one of its Test Data addresses) -- its path then names the
    page the case is about. A URL belonging to anything else is ignored rather
    than grafted onto this application's host. Otherwise the application's
    address in `environment`, then its profile's base URL, then any address it
    has. None when the application has no address at all.
    """
    from ...models.automation import AutomationDataApp
    from .registry import address_for, addresses, default_environment, origin

    app = db.get(AutomationDataApp, choice.id)
    prof = profile(choice)
    known = addresses(app)
    origins = {origin(a) for a in [prof.get("base_url"), *known.values()] if origin(a)}

    named = _URL.search(text or "")
    if named:
        url = named.group(0).rstrip(".,)")
        if origin(url) in origins:
            return kb.rehome_to_profile(url, prof) if prof.get("base_url") else url

    return (
        (address_for(app, environment) if environment else None)
        or (prof.get("base_url") or "").strip()
        or address_for(app, default_environment(app))
        or next(iter(known.values()), None)
        or None
    )


def crawl_application_id(db: Session, choice: Optional[AppChoice]) -> Optional[int]:
    """The AutomationApplication (Discovery / KB page) row behind `choice`."""
    if choice is None:
        return None
    from ...models.automation import AutomationApplication

    row = db.query(AutomationApplication).filter(AutomationApplication.app_key == choice.kb_app_id).first()
    return row.id if row else None


def kb_key_for_case(case: Any, db: Optional[Session] = None) -> Optional[str]:
    """The Automation KB folder of the application a case is linked to, or None."""
    app_id = getattr(case, "application_id", None)
    if not app_id:
        return None
    from sqlalchemy.orm import object_session

    from ...models.automation import AutomationApplication

    db = db or object_session(case)
    if db is None:
        return None
    row = db.get(AutomationApplication, app_id)
    return row.app_key if row else None


def journey_app_ids(choice: Optional[AppChoice]) -> list[str]:
    """The Journey KB applications that describe `choice` (same KB folder)."""
    if choice is None or not choice.kb_app_id:
        return []
    try:
        from ..journeys import store

        out = []
        for journey_app in store.list_apps():
            loaded = store.load(journey_app)
            if loaded and (journey_app == choice.kb_app_id or loaded.automation_app_id == choice.kb_app_id):
                out.append(journey_app)
        return out
    except Exception:  # noqa: BLE001 - the journey layer is optional
        logger.warning("Journey KB lookup failed for %s", choice.kb_app_id, exc_info=True)
        return []


# --- Telling the model -----------------------------------------------------------

def scope_prompt(db: Session, scope: list[AppChoice], environment: Optional[str] = None) -> str:
    """The prompt block naming the chosen applications, their addresses, and
    -- with several -- the Application column that says which case is whose."""
    if not scope:
        return ""
    env = (environment or "").strip().upper()
    lines = [
        "================================================================================",
        "APPLICATIONS IN SCOPE (CHOSEN BY THE USER)",
        "================================================================================",
        "The user chose the application(s) these test cases are for. Write test cases for these "
        "applications only:",
    ]
    for choice in scope:
        url = url_for(db, choice, "", environment)
        where = f" -- {url}" + (f" ({env})" if env and url else "") if url else " -- no address registered"
        lines.append(f"- {choice.name}{where}")
    lines += [
        "Words in the requirements such as \"Business\", \"Payment\", \"OTP\" or \"Portal\" are features "
        "of the application(s) above, never a reason to write for a different application.",
        "Use only the URLs listed above or given in the application knowledge in this prompt. Never "
        "use, and never invent, a URL belonging to any other application.",
    ]
    if len(scope) > 1:
        names = ", ".join(f'"{c.name}"' for c in scope)
        lines += [
            "",
            "Add ONE more column at the end of the table, after Priority, headed \"Application\". Its "
            f"value is exactly one of {names} -- the application that test case exercises. A scenario "
            "that crosses two of them is written as one case per application.",
        ]
    lines.append("================================================================================")
    return "\n".join(lines)


# --- The dropdown -------------------------------------------------------------------

def catalogue(db: Session) -> list[dict[str, Any]]:
    """Every Test Data application, with what it has: KB, journeys, addresses."""
    from ...models.automation import AutomationDataApp
    from .registry import addresses, crawl_key

    out = []
    for app in db.query(AutomationDataApp).order_by(AutomationDataApp.name).all():
        choice = AppChoice(id=app.id, name=app.name, kb_app_id=crawl_key(app))
        out.append({
            "id": app.id,
            "name": app.name,
            "kb_app_id": choice.kb_app_id,
            "has_kb": bool(profile(choice)),
            "flows": len(kb.list_flows(choice.kb_app_id)) if choice.kb_app_id else 0,
            "has_journeys": bool(journey_app_ids(choice)),
            "addresses": addresses(app),
        })
    return out
