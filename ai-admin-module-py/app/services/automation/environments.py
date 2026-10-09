"""--- Environments: the one list ------------------------------------------------------

Every place that offers an environment -- Generate Test Cases, Test Data, an
application's addresses on the Knowledge Base page, the Workbench -- reads
this list (automation_environments), so adding RC2 once offers it everywhere.

  add       a new name, at the end (or where it is placed)
  rename    everywhere it is stored: values, addresses, defaults, test cases,
            and the history of runs and walks, so nothing points at a name
            that no longer exists
  delete    only when nothing would silently fall back: not while an
            application has it as its default, or test cases target it.
            Its addresses and values go with it, when the caller says so.
  reorder   the order the lists show (release order)

The list is seeded from test_data.DEFAULT_ENVIRONMENTS, plus any name already
in use, the first time it is read; a name found in use later is added too, so
nothing in the data is missing from the list.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from ...models.automation import (
    AutomationApplication,
    AutomationDataApp,
    AutomationDataAppEnvironment,
    AutomationDiscoveryRun,
    AutomationEnvironment,
    AutomationRun,
    AutomationTestCase,
    AutomationTestData,
)
from ...models.kb_changes import KbCrawlRun
from . import test_data

NAME = re.compile(r"^[A-Z0-9][A-Z0-9_.-]{0,39}$")
# A data application with no default of its own runs on this one (test_data.run_environment).
IMPLICIT_DEFAULT = "SIT"


class EnvironmentError_(ValueError):
    """A change that cannot be made; the message is user-facing."""


def clean(name: Optional[str]) -> str:
    value = (name or "").strip().upper().replace(" ", "_")
    if value == test_data.ALL_ENVIRONMENTS or not NAME.match(value):
        raise EnvironmentError_("Use letters, digits, '_', '-' or '.', up to 40 characters, e.g. SIT, UAT2, PRE-PROD.")
    return value


# Columns that hold an environment name: (model, column, what it is, live?).
# Live ones are configuration a delete would break; the others are history.
_COLUMNS = [
    (AutomationTestData, AutomationTestData.environment, "test data values", True),
    (AutomationDataAppEnvironment, AutomationDataAppEnvironment.environment, "application addresses", True),
    (AutomationDataApp, AutomationDataApp.run_environment, "application defaults", True),
    (AutomationApplication, AutomationApplication.environment, "crawl targets", True),
    (AutomationTestCase, AutomationTestCase.environment, "test cases", True),
    (AutomationRun, AutomationRun.environment, "runs", False),
    (AutomationDiscoveryRun, AutomationDiscoveryRun.application_environment, "discovery runs", False),
    (KbCrawlRun, KbCrawlRun.environment, "journey walks", False),
]


def _in_use(db: Session) -> List[str]:
    used: set[str] = set()
    for _model, column, _what, live in _COLUMNS:
        if live:
            used.update(v for (v,) in db.query(column).distinct() if v)
    return [u for u in used if u != test_data.ALL_ENVIRONMENTS]


def _rows(db: Session) -> List[AutomationEnvironment]:
    rows = db.query(AutomationEnvironment).order_by(AutomationEnvironment.position, AutomationEnvironment.id).all()
    known = {r.name for r in rows}
    seed = [] if rows else list(test_data.DEFAULT_ENVIRONMENTS)
    extra = sorted({u.strip().upper() for u in _in_use(db)} - known - set(seed))
    missing = [n for n in [*seed, *extra] if NAME.match(n)]
    if missing:
        top = max((r.position for r in rows), default=-1)
        for i, name in enumerate(missing, start=1):
            db.add(AutomationEnvironment(name=name, position=top + i, created_by="system"))
        db.commit()
        rows = db.query(AutomationEnvironment).order_by(AutomationEnvironment.position, AutomationEnvironment.id).all()
    test_data.set_environment_order([r.name for r in rows])
    return rows


def names(db: Session) -> List[str]:
    """The environments, in their order."""
    return [r.name for r in _rows(db)]


def usage(db: Session, name: str) -> Dict[str, int]:
    """{what: count} for one environment; zeros left out."""
    out: Dict[str, int] = {}
    for model, column, what, _live in _COLUMNS:
        n = db.query(func.count()).select_from(model).filter(column == name).scalar() or 0
        if model is AutomationDataApp and name == IMPLICIT_DEFAULT:
            n += db.query(func.count()).select_from(model).filter(column.is_(None)).scalar() or 0
        if n:
            out[what] = n
    return out


def _blockers(db: Session, name: str) -> List[str]:
    """Why `name` cannot be deleted: things that would fall back to another environment unseen."""
    reasons = []
    apps = [a.name for a in db.query(AutomationDataApp).all() if test_data.run_environment(a) == name]
    if apps:
        reasons.append(f"it is the default environment of {', '.join(apps[:5])}{'…' if len(apps) > 5 else ''}"
                       " (make another environment the default on Test Data first)")
    cases = db.query(func.count()).select_from(AutomationTestCase).filter(AutomationTestCase.environment == name).scalar() or 0
    if cases:
        reasons.append(f"{cases} test case{'s target' if cases != 1 else ' targets'} it (rename it instead, or retarget them)")
    return reasons


def view(db: Session) -> List[Dict[str, Any]]:
    rows = _rows(db)
    return [{"name": r.name, "label": test_data.environment_label(r.name), "position": i,
             "usage": usage(db, r.name), "blocked": _blockers(db, r.name)} for i, r in enumerate(rows)]


def add(db: Session, name: str, *, actor: Optional[str], after: Optional[str] = None) -> str:
    value = clean(name)
    rows = _rows(db)
    if any(r.name == value for r in rows):
        raise EnvironmentError_(f"{value} is already in the list.")
    order = [r.name for r in rows]
    index = order.index(after) + 1 if after in order else len(order)
    order.insert(index, value)
    db.add(AutomationEnvironment(name=value, position=index, created_by=actor))
    db.flush()
    _apply_order(db, order)
    db.commit()
    return value


def rename(db: Session, old: str, new: str) -> Dict[str, int]:
    """Rename everywhere the name is stored; returns {what: rows changed}."""
    rows = {r.name: r for r in _rows(db)}
    if old not in rows:
        raise LookupError(f"No environment {old}.")
    value = clean(new)
    if value == old:
        return {}
    if value in rows:
        raise EnvironmentError_(f"{value} is already in the list; delete one of them instead.")
    if any(u.upper() == value for u in _in_use(db)):
        raise EnvironmentError_(f"{value} is already used by stored data; pick another name.")
    changed: Dict[str, int] = {}
    for model, column, what, _live in _COLUMNS:
        n = db.query(model).filter(column == old).update({column: value}, synchronize_session=False)
        if model is AutomationDataApp and old == IMPLICIT_DEFAULT:
            # Applications with no default of their own ran on SIT: keep them on it under its new name.
            n += db.query(model).filter(column.is_(None)).update({column: value}, synchronize_session=False)
        if n:
            changed[what] = n
    rows[old].name = value
    db.commit()
    _rows(db)
    return changed


def delete(db: Session, name: str, *, remove_data: bool) -> Dict[str, int]:
    """Take an environment off the list; with remove_data, its addresses and values too."""
    rows = {r.name: r for r in _rows(db)}
    if name not in rows:
        raise LookupError(f"No environment {name}.")
    if len(rows) == 1:
        raise EnvironmentError_("Keep at least one environment.")
    reasons = _blockers(db, name)
    if reasons:
        raise EnvironmentError_(f"{name} cannot be deleted: " + "; ".join(reasons) + ".")
    data = {k: v for k, v in usage(db, name).items() if k in ("test data values", "application addresses", "crawl targets")}
    if data and not remove_data:
        raise EnvironmentError_(f"{name} still has " + ", ".join(f"{v} {k}" for k, v in data.items())
                                + ". Confirm to delete them with it.")
    removed: Dict[str, int] = {}
    if remove_data:
        for model, column, what in ((AutomationTestData, AutomationTestData.environment, "test data values"),
                                    (AutomationDataAppEnvironment, AutomationDataAppEnvironment.environment, "application addresses")):
            n = db.query(model).filter(column == name).delete(synchronize_session=False)
            if n:
                removed[what] = n
        # A crawl target on it falls back to its application's default.
        n = db.query(AutomationApplication).filter(AutomationApplication.environment == name).update(
            {AutomationApplication.environment: None}, synchronize_session=False)
        if n:
            removed["crawl targets"] = n
    db.delete(rows[name])
    db.flush()
    _apply_order(db, [n for n in rows if n != name])
    db.commit()
    _rows(db)
    return removed


def reorder(db: Session, order: List[str]) -> List[str]:
    rows = [r.name for r in _rows(db)]
    wanted = [n for n in (o.strip().upper() for o in order) if n in rows]
    if len(set(wanted)) != len(wanted):
        raise EnvironmentError_("Each environment once.")
    final = wanted + [n for n in rows if n not in wanted]
    _apply_order(db, final)
    db.commit()
    return names(db)


def _apply_order(db: Session, order: List[str]) -> None:
    by_name = {r.name: r for r in db.query(AutomationEnvironment).all()}
    for i, name in enumerate(order):
        if name in by_name:
            by_name[name].position = i
