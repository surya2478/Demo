"""
--- Heal: after a Journey KB change is published ---------------------------------------

A published change -- from a BRD, a design PDF, a Reconcile decision or a
crawl's links -- is recorded as a heal with its impact (services/journeys/
impact.py). Two things happen at once and are cheap, deterministic and safe:

  * the KB diff of every affected test case is recomputed against the new
    Knowledge Base, keeping the case's own journey, and the before/after is
    kept so a reviewer sees which cases the change moved;

and two are offered, because they cost model calls or drive the running
application:

  * re-run AI Checks (review, KB diff, classify) on the affected cases;
  * a journey-guided crawl of each affected journey, which confirms the change
    in the application and proposes the selectors it needs.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from ...models.automation import AutomationTestCase
from ...models.kb_changes import KbChangeSet, KbHeal, KbVersion
from . import diff, impact, store


class HealError(ValueError):
    """A heal action that cannot go ahead; the message is user-facing."""


def _changes(change_set: KbChangeSet) -> List[Dict[str, Any]]:
    return [{"file": c.file, "op": c.op, "path": c.path, "after": c.after or {}} for c in change_set.changes]


def _rediff(db: Session, kb: store.JourneyKB, cases: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out = []
    for entry in cases:
        case = db.get(AutomationTestCase, entry["id"])
        if case is None:
            continue
        before = case.journey_diff or {}
        steps = [
            {"step_number": s.get("step_number"), "action": s.get("action") or "", "target": s.get("target")}
            for s in (case.steps_structured or []) if isinstance(s, dict)
        ]
        text = " ".join([case.description or "", case.objective or "", case.preconditions or ""])
        # Keep the journey the case was matched to: the change must not make it
        # "jump" to another journey just because the wording now fits better.
        report = diff.diff_case(steps, text, app_id=kb.app_id, journey_id=before.get("journey_id"))
        report["compared_at"] = datetime.utcnow().isoformat()
        report["refreshed_by_heal"] = True
        case.journey_diff = report
        out.append({
            "case_id": case.id, "display_id": case.display_id, "journey_id": report.get("journey_id"),
            "before": before.get("summary") or {}, "after": report.get("summary") or {},
            "changed": (before.get("summary") or {}) != (report.get("summary") or {}),
            "automatable_before": before.get("automatable"), "automatable_after": report.get("automatable"),
        })
    return out


def record(db: Session, *, change_set: Optional[KbChangeSet], version: KbVersion, actor: Optional[str],
           changes: Optional[List[Dict[str, Any]]] = None, title: Optional[str] = None) -> Optional[KbHeal]:
    """Record the heal of a published Journey KB version; None for other KBs."""
    if version.kb != "journey":
        return None
    kb = store.load(version.app_id)
    if kb is None:
        return None
    changes = changes if changes is not None else (_changes(change_set) if change_set else [])
    found = impact.analyse(kb, changes, db)
    heal = KbHeal(
        app_id=version.app_id, change_set_id=change_set.id if change_set else None, version_id=version.id,
        title=title or (change_set.title if change_set else version.summary) or f"Version {version.number}",
        source=change_set.source if change_set else "revert", impact=found,
        rediff=_rediff(db, kb, found["test_cases"]), crawls=[], created_by=actor,
    )
    db.add(heal)
    db.commit()
    db.refresh(heal)
    return heal


def record_revert(db: Session, *, undo: KbVersion, reverted: KbVersion, actor: Optional[str]) -> Optional[KbHeal]:
    """A revert touches what the reverted change set touched."""
    change_set = db.get(KbChangeSet, reverted.change_set_id) if reverted.change_set_id else None
    return record(db, change_set=None, version=undo, actor=actor,
                  changes=_changes(change_set) if change_set else [], title=undo.summary)


def recheck(db: Session, heal_id: int, *, actor: Optional[str]) -> KbHeal:
    from ..automation import ai_checks

    heal = _get(db, heal_id)
    case_ids = [c["id"] for c in (heal.impact or {}).get("test_cases", [])]
    if not case_ids:
        raise HealError("No test case is affected by this change.")
    result = ai_checks.recheck_cases(db, case_ids)
    heal.recheck = {"requested_by": actor, "requested_at": datetime.utcnow().isoformat(), "case_ids": case_ids, **result}
    db.commit()
    db.refresh(heal)
    return heal


def crawl(db: Session, heal_id: int, *, journey_id: str, application_id: int, environment: Optional[str],
          actor: Optional[str]) -> KbHeal:
    from . import crawl_runs

    heal = _get(db, heal_id)
    if journey_id not in (heal.impact or {}).get("crawl_journeys", []):
        raise HealError("That journey is not one this change asks to crawl.")
    run = crawl_runs.start(db, app_id=heal.app_id, journey_id=journey_id, application_id=application_id,
                           environment=environment, actor=actor)
    crawls = list(heal.crawls or [])
    crawls.append({"journey_id": journey_id, "crawl_id": run.id, "started_by": actor,
                   "started_at": datetime.utcnow().isoformat()})
    heal.crawls = crawls
    db.commit()
    db.refresh(heal)
    return heal


def _get(db: Session, heal_id: int) -> KbHeal:
    heal = db.get(KbHeal, heal_id)
    if heal is None:
        raise LookupError("No such heal.")
    return heal


def view(db: Session, heal: KbHeal) -> Dict[str, Any]:
    from ...models.automation import AutomationAICheck
    from ...models.kb_changes import KbCrawlRun

    recheck = dict(heal.recheck or {})
    if recheck.get("case_ids"):
        # Where each re-check got to, read fresh each time.
        rows = (db.query(AutomationAICheck).filter(AutomationAICheck.case_id.in_(recheck["case_ids"]))
                .order_by(AutomationAICheck.id.desc()).all())
        latest: Dict[int, Any] = {}
        for row in rows:
            latest.setdefault(row.case_id, row)
        recheck["progress"] = {cid: latest[cid].status for cid in recheck["case_ids"] if cid in latest}
    crawls = []
    for entry in heal.crawls or []:
        run = db.get(KbCrawlRun, entry["crawl_id"])
        crawls.append({**entry, "status": run.status if run else "deleted",
                       "summary": (run.result or {}).get("summary") if run else None})
    return {
        "id": heal.id, "app_id": heal.app_id, "change_set_id": heal.change_set_id, "version_id": heal.version_id,
        "title": heal.title, "source": heal.source, "impact": heal.impact or {}, "rediff": heal.rediff or [],
        "recheck": recheck or None, "crawls": crawls, "created_by": heal.created_by,
        "created_at": heal.created_at.isoformat() if heal.created_at else None,
    }
