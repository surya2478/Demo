"""
--- Knowledge Base change sets: draft, review, publish, revert -------------------

Nothing edits a Knowledge Base file directly. A change is proposed as a
change set (a draft), reviewed, and only an approval writes the files -- all
of them or none, recording a version that keeps each touched file whole,
before and after, so a version can be reverted exactly.

Two checks keep a publish honest:

  * Every change remembers the value it saw when drafted. At publish the file
    must still hold that value; if someone changed it since, the change set is
    marked conflicted and nothing is written. A reviewer approves what they
    saw, not whatever the file has become.

  * The Automation KB is the crawled application. Only a crawl or QA may
    change it; a design document, a BRD or a reconcile decision proposes
    changes to the Journey KB. This is the rule that keeps a PDF from turning
    into a "verified" selector.

Addresses inside a file pick list items by key, not position, so a change
still lands on the right item if the file is reordered:

    screens[screen_id=SCR_LOGIN].elements[element_id=username].label
    nodes["B2B.REG.EXISTING.SIGNIN.OTP"].status
    steps[step_number=4].action

A change with op "create" and path "$" makes a new file (a journey extracted
from a document); its "before" is absent, so reverting that version deletes
the file again.
"""
from __future__ import annotations

import copy
import json
import os
import re
import tempfile
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from ...models.kb_changes import KbChange, KbChangeSet, KbVersion
from . import store

KBS = ("journey", "automation")
AUTOMATION_SOURCES = {"crawl", "qa", "revert"}

_locks: Dict[Tuple[str, str], threading.Lock] = {}
_locks_guard = threading.Lock()


class ChangeSetError(ValueError):
    """A change set that cannot be drafted, published or reverted as asked."""


class Conflict(ChangeSetError):
    def __init__(self, message: str, conflicts: List[Dict[str, Any]]):
        super().__init__(message)
        self.conflicts = conflicts


def _lock(app_id: str, kb: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault((app_id, kb), threading.Lock())


# --- Where each Knowledge Base lives ---------------------------------------------------

def kb_dir(app_id: str, kb: str) -> Path:
    if kb == "journey":
        return store.journey_kb_root() / app_id
    if kb == "automation":
        from ..automation import knowledge_base as automation_kb

        return automation_kb.get_kb_root() / app_id
    raise ChangeSetError(f"Unknown Knowledge Base '{kb}'; expected one of {', '.join(KBS)}.")


def _file(app_id: str, kb: str, rel: str) -> Path:
    rel = (rel or "").replace("\\", "/").strip()
    if not rel.endswith(".json") or rel.startswith("/") or ".." in rel.split("/"):
        raise ChangeSetError(f"'{rel}' is not a Knowledge Base JSON file.")
    base = kb_dir(app_id, kb).resolve()
    target = (base / rel).resolve()
    if base not in target.parents:
        raise ChangeSetError(f"'{rel}' is outside the Knowledge Base folder.")
    return target


def _read_text(path: Path) -> Optional[str]:
    return path.read_text(encoding="utf-8") if path.exists() else None


def _write_atomic(path: Path, text: Optional[str]) -> None:
    if text is None:
        if path.exists():
            path.unlink()
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".kb-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def _dump(doc: Any) -> str:
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


# --- Addresses inside a file ----------------------------------------------------------------

_SEGMENT = re.compile(
    r"""\s*(?:
        \["(?P<quoted>(?:[^"\\]|\\.)*)"\]                 # ["literal key"]
      | \[(?P<index>\d+)\]                                # [3]
      | \[(?P<skey>[A-Za-z0-9_]+)=(?P<sval>[^\]]+)\]      # [key=value]
      | \.?(?P<name>[A-Za-z0-9_\-]+)                      # name / .name
    )""",
    re.VERBOSE,
)


def parse_path(path: str) -> List[Tuple[str, Any]]:
    """[("key", name) | ("index", n) | ("match", (field, value))]."""
    segments: List[Tuple[str, Any]] = []
    pos, text = 0, (path or "").strip()
    if not text:
        raise ChangeSetError("An empty address names nothing.")
    while pos < len(text):
        match = _SEGMENT.match(text, pos)
        if not match or match.end() == pos:
            raise ChangeSetError(f"Cannot read the address '{path}' at '{text[pos:]}'.")
        if match.group("quoted") is not None:
            segments.append(("key", json.loads(f'"{match.group("quoted")}"')))
        elif match.group("index") is not None:
            segments.append(("index", int(match.group("index"))))
        elif match.group("skey") is not None:
            segments.append(("match", (match.group("skey"), match.group("sval").strip())))
        else:
            segments.append(("key", match.group("name")))
        pos = match.end()
    return segments


def _matches(item: Any, field: str, value: str) -> bool:
    return isinstance(item, dict) and field in item and str(item[field]) == value


def _step(node: Any, segment: Tuple[str, Any]) -> Any:
    kind, arg = segment
    if kind == "key":
        if not isinstance(node, dict) or arg not in node:
            raise KeyError(arg)
        return node[arg]
    if kind == "index":
        if not isinstance(node, list) or arg >= len(node):
            raise KeyError(arg)
        return node[arg]
    field, value = arg
    if not isinstance(node, list):
        raise KeyError(f"{field}={value}")
    for item in node:
        if _matches(item, field, value):
            return item
    raise KeyError(f"{field}={value}")


_ABSENT = {"present": False}
ROOT = "$"


def read_at(doc: Any, path: str) -> Dict[str, Any]:
    """{"present": True, "value": v} or {"present": False}."""
    if path == ROOT:
        return dict(_ABSENT) if doc is None else {"present": True, "value": copy.deepcopy(doc)}
    node = doc
    try:
        for segment in parse_path(path):
            node = _step(node, segment)
    except KeyError:
        return dict(_ABSENT)
    return {"present": True, "value": copy.deepcopy(node)}


def apply(doc: Any, op: str, path: str, value: Any = None) -> Any:
    """Apply one change to a parsed document, in place; returns the document.

    "create" is the exception: it returns the new document, since there was none.
    """
    if op == "create":
        if path != ROOT:
            raise ChangeSetError(f"A new file is created at '{ROOT}', not '{path}'.")
        if doc is not None:
            raise ChangeSetError("This file already exists.")
        if not isinstance(value, dict):
            raise ChangeSetError("A new file must be a JSON object.")
        return value
    if doc is None:
        raise ChangeSetError(f"'{path}': the file does not exist.")
    segments = parse_path(path)
    parent = doc
    for segment in segments[:-1]:
        try:
            parent = _step(parent, segment)
        except KeyError as exc:
            raise ChangeSetError(f"'{path}': nothing at {exc}.") from exc
    kind, arg = segments[-1]
    if op == "remove":
        try:
            if kind == "key":
                del parent[arg]
            elif kind == "index":
                del parent[arg]
            else:
                field, val = arg
                index = next(i for i, item in enumerate(parent) if _matches(item, field, val))
                del parent[index]
        except (KeyError, IndexError, StopIteration, TypeError) as exc:
            raise ChangeSetError(f"'{path}' is already absent.") from exc
        return doc
    if op != "set":
        raise ChangeSetError(f"Unknown operation '{op}'; expected set, remove or create.")
    if kind == "key":
        if not isinstance(parent, dict):
            raise ChangeSetError(f"'{path}': the parent is not an object.")
        parent[arg] = value
    elif kind == "index":
        if not isinstance(parent, list) or arg > len(parent):
            raise ChangeSetError(f"'{path}': index out of range.")
        if arg == len(parent):
            parent.append(value)
        else:
            parent[arg] = value
    else:
        field, val = arg
        if not isinstance(parent, list):
            raise ChangeSetError(f"'{path}': the parent is not a list.")
        if not isinstance(value, dict) or str(value.get(field)) != val:
            raise ChangeSetError(f"'{path}': the new item must carry {field}={val}.")
        for i, item in enumerate(parent):
            if _matches(item, field, val):
                parent[i] = value
                break
        else:
            parent.append(value)
    return doc


# --- Drafting --------------------------------------------------------------------------------

def _load(app_id: str, kb: str, rel: str, *, may_create: bool = False) -> Any:
    text = _read_text(_file(app_id, kb, rel))
    if text is None:
        if may_create:
            return None
        raise ChangeSetError(f"'{rel}' does not exist in the {kb} Knowledge Base for {app_id}.")
    return json.loads(text)


def draft(
    db: Session,
    *,
    app_id: str,
    kb: str,
    title: str,
    changes: List[Dict[str, Any]],
    source: str = "manual",
    description: Optional[str] = None,
    kind: str = "change",
    origin: Optional[Dict[str, Any]] = None,
    actor: Optional[str] = None,
) -> KbChangeSet:
    """Record a draft. Every change is checked to apply cleanly now."""
    if kb not in KBS:
        raise ChangeSetError(f"Unknown Knowledge Base '{kb}'.")
    if kb == "automation" and source not in AUTOMATION_SOURCES:
        raise ChangeSetError(
            "The Automation KB is what the crawled application renders; only a crawl or QA may change it. "
            "Propose design changes to the Journey KB instead."
        )
    if not kb_dir(app_id, kb).exists():
        raise ChangeSetError(f"No {kb} Knowledge Base for '{app_id}'.")
    if not (title or "").strip():
        raise ChangeSetError("A change set needs a title.")
    if kind == "change" and not changes:
        raise ChangeSetError("A change set needs at least one change.")

    # Dry-run every change in order against copies, so a draft that could not
    # be applied is refused now rather than at approval.
    docs: Dict[str, Any] = {}
    rows: List[KbChange] = []
    for position, change in enumerate(changes):
        rel, op, path = change.get("file"), change.get("op", "set"), change.get("path")
        if rel not in docs:
            docs[rel] = _load(app_id, kb, rel, may_create=(op == "create"))
        before = read_at(docs[rel], path)
        if op == "remove" and not before["present"]:
            raise ChangeSetError(f"{rel}: '{path}' is already absent.")
        docs[rel] = apply(docs[rel], op, path, copy.deepcopy(change.get("value")))
        rows.append(KbChange(
            position=position, file=rel, op=op, path=path, before=before,
            after=None if op == "remove" else {"present": True, "value": change.get("value")},
            note=change.get("note"),
        ))

    change_set = KbChangeSet(
        app_id=app_id, kb=kb, title=title.strip()[:300], description=description, source=source,
        kind=kind, status="draft", created_by=actor, origin=origin, changes=rows,
    )
    db.add(change_set)
    db.commit()
    db.refresh(change_set)
    return change_set


# --- Publishing -------------------------------------------------------------------------------

def _next_number(db: Session, app_id: str, kb: str) -> int:
    latest = (
        db.query(KbVersion.number)
        .filter(KbVersion.app_id == app_id, KbVersion.kb == kb)
        .order_by(KbVersion.number.desc())
        .first()
    )
    return (latest[0] if latest else 0) + 1


def _after_publish(app_id: str, kb: str, files: List[str]) -> None:
    """Keep derived files in step: the taxonomy is built from the overlay."""
    if kb == "journey" and any(f.startswith("sources/") for f in files):
        from . import taxonomy

        taxonomy.write(kb_dir(app_id, kb))


def publish(db: Session, change_set_id: int, *, actor: Optional[str], note: Optional[str] = None) -> Optional[KbVersion]:
    """Write an approved change set; returns the new version.

    A defect (a decision that changes no file) is recorded as approved and
    creates no version -- an empty version would only be noise in History.
    """
    change_set = db.get(KbChangeSet, change_set_id)
    if change_set is None:
        raise LookupError("No such change set.")
    if change_set.status not in ("draft", "conflicted"):
        raise ChangeSetError(f"This change set is already {change_set.status}.")
    if not change_set.changes:
        change_set.status = "published"
        change_set.decided_by = actor
        change_set.decided_at = datetime.utcnow()
        change_set.decision_note = note
        db.commit()
        return None

    with _lock(change_set.app_id, change_set.kb):
        by_file: Dict[str, List[KbChange]] = {}
        for change in change_set.changes:
            by_file.setdefault(change.file, []).append(change)

        # Apply everything in memory first; write only when every change fits.
        before_text: Dict[str, Optional[str]] = {}
        after_text: Dict[str, str] = {}
        conflicts: List[Dict[str, Any]] = []
        for rel, changes in by_file.items():
            path = _file(change_set.app_id, change_set.kb, rel)
            before_text[rel] = _read_text(path)
            creates = changes[0].op == "create"
            if before_text[rel] is None and not creates:
                conflicts.append({"file": rel, "path": None, "reason": "file no longer exists"})
                continue
            doc = json.loads(before_text[rel]) if before_text[rel] is not None else None
            for change in changes:
                current = read_at(doc, change.path)
                if current != (change.before or _ABSENT):
                    conflicts.append({
                        "file": rel, "path": change.path,
                        "expected": change.before, "found": current,
                        "reason": "the file changed after this draft was made",
                    })
                    continue
                doc = apply(doc, change.op, change.path, copy.deepcopy((change.after or {}).get("value")))
            if doc is not None:
                after_text[rel] = _dump(doc)

        if conflicts:
            change_set.status = "conflicted"
            db.commit()
            raise Conflict("The Knowledge Base changed after this draft was made; nothing was published.", conflicts)

        for rel, text in after_text.items():
            _write_atomic(_file(change_set.app_id, change_set.kb, rel), text)
        _after_publish(change_set.app_id, change_set.kb, list(after_text))

        version = KbVersion(
            app_id=change_set.app_id, kb=change_set.kb,
            number=_next_number(db, change_set.app_id, change_set.kb),
            change_set_id=change_set.id, summary=change_set.title, published_by=actor,
            files={rel: {"before": before_text[rel], "after": after_text[rel]} for rel in after_text},
        )
        db.add(version)
        db.flush()
        change_set.status = "published"
        change_set.decided_by = actor
        change_set.decided_at = datetime.utcnow()
        change_set.decision_note = note
        change_set.published_version_id = version.id
        db.commit()
        db.refresh(version)
        return version


def reject(db: Session, change_set_id: int, *, actor: Optional[str], note: Optional[str] = None) -> KbChangeSet:
    change_set = db.get(KbChangeSet, change_set_id)
    if change_set is None:
        raise LookupError("No such change set.")
    if change_set.status not in ("draft", "conflicted"):
        raise ChangeSetError(f"This change set is already {change_set.status}.")
    change_set.status = "rejected"
    change_set.decided_by = actor
    change_set.decided_at = datetime.utcnow()
    change_set.decision_note = note
    db.commit()
    return change_set


def discard(db: Session, change_set_id: int) -> None:
    change_set = db.get(KbChangeSet, change_set_id)
    if change_set is None:
        raise LookupError("No such change set.")
    if change_set.status not in ("draft", "conflicted"):
        raise ChangeSetError("Only a draft can be discarded; published and rejected ones are history.")
    db.delete(change_set)
    db.commit()


def revert(db: Session, version_id: int, *, actor: Optional[str]) -> KbVersion:
    """Restore the files a version changed, as a new version.

    Only when those files are exactly as the version left them: a later change
    on top would otherwise be silently undone as well.
    """
    version = db.get(KbVersion, version_id)
    if version is None:
        raise LookupError("No such version.")
    if version.reverted_by_version_id:
        raise ChangeSetError("This version has already been reverted.")
    with _lock(version.app_id, version.kb):
        changed_since = [
            rel for rel, texts in version.files.items()
            if _read_text(_file(version.app_id, version.kb, rel)) != texts.get("after")
        ]
        if changed_since:
            raise Conflict(
                "Later changes touched the same files; revert those first.",
                [{"file": rel, "path": None, "reason": "changed after this version"} for rel in changed_since],
            )
        for rel, texts in version.files.items():
            _write_atomic(_file(version.app_id, version.kb, rel), texts.get("before"))
        _after_publish(version.app_id, version.kb, list(version.files))
        undo = KbVersion(
            app_id=version.app_id, kb=version.kb, number=_next_number(db, version.app_id, version.kb),
            change_set_id=None, summary=f"Revert v{version.number}: {version.summary or ''}".strip()[:300],
            published_by=actor,
            files={rel: {"before": t.get("after"), "after": t.get("before")} for rel, t in version.files.items()},
        )
        db.add(undo)
        db.flush()
        version.reverted_by_version_id = undo.id
        db.commit()
        db.refresh(undo)
        return undo


# --- Reading ----------------------------------------------------------------------------------

def change_set_view(change_set: KbChangeSet, *, with_changes: bool = True) -> Dict[str, Any]:
    view = {
        "id": change_set.id, "app_id": change_set.app_id, "kb": change_set.kb, "title": change_set.title,
        "description": change_set.description, "source": change_set.source, "kind": change_set.kind,
        "status": change_set.status, "created_by": change_set.created_by,
        "created_at": change_set.created_at.isoformat() if change_set.created_at else None,
        "decided_by": change_set.decided_by,
        "decided_at": change_set.decided_at.isoformat() if change_set.decided_at else None,
        "decision_note": change_set.decision_note, "origin": change_set.origin,
        "published_version_id": change_set.published_version_id,
        "change_count": len(change_set.changes),
    }
    if with_changes:
        view["changes"] = [
            {"file": c.file, "op": c.op, "path": c.path, "before": c.before, "after": c.after, "note": c.note}
            for c in change_set.changes
        ]
    return view


def version_view(version: KbVersion, *, with_files: bool = False) -> Dict[str, Any]:
    view = {
        "id": version.id, "app_id": version.app_id, "kb": version.kb, "number": version.number,
        "change_set_id": version.change_set_id, "summary": version.summary,
        "published_by": version.published_by,
        "published_at": version.published_at.isoformat() if version.published_at else None,
        "files": sorted(version.files or {}),
        "reverted_by_version_id": version.reverted_by_version_id,
    }
    if with_files:
        view["file_texts"] = version.files
    return view


# --- Reconcile decisions become change sets ---------------------------------------------------

def _element_path(screen_id: str, element_id: str, field: Optional[str] = None) -> str:
    base = f"screens[screen_id={screen_id}].elements[element_id={element_id}]"
    return f"{base}.{field}" if field else base


def reconcile_decision(
    db: Session,
    *,
    app_id: str,
    decision: str,
    screen_id: Optional[str] = None,
    element_id: Optional[str] = None,
    automation_ref: Optional[str] = None,
    app_label: Optional[str] = None,
    label: Optional[str] = None,
    note: Optional[str] = None,
    actor: Optional[str] = None,
) -> KbChangeSet:
    """Turn a Reconcile decision into a Journey KB change set.

    app     -- the application is right: the element takes the app's label, the
               old label stays as an alias (so test cases quoting it still
               resolve), and journey steps quoting the old label are reworded.
    both    -- both labels are valid: the app's label becomes an alias.
    design  -- the design is right: a defect is recorded, no file changes.
    unlink  -- the element's Automation KB reference is broken: clear it.
    add     -- an Automation KB control the design lacks: add it to a screen.
    """
    kb = store.load(app_id)
    if kb is None:
        raise ChangeSetError(f"No Journey KB for '{app_id}'.")
    origin = {"reconcile": {"decision": decision, "screen_id": screen_id, "element_id": element_id,
                            "automation_ref": automation_ref}}

    def element() -> Dict[str, Any]:
        screen = kb.screens.get(screen_id or "")
        found = next((e for e in (screen or {}).get("elements", []) if e.get("element_id") == element_id), None)
        if found is None:
            raise ChangeSetError(f"No element {screen_id} · {element_id} in the Journey KB.")
        return found

    if decision in ("app", "both"):
        current = element()
        new_label = (app_label or "").strip()
        if not new_label:
            raise ChangeSetError("The application's label is needed for this decision.")
        aliases = list(current.get("aliases") or [])
        changes: List[Dict[str, Any]] = []
        if decision == "app":
            old = current.get("label") or ""
            if old and old.lower() not in [a.lower() for a in aliases]:
                aliases.append(old.lower())
            changes.append({"file": "screens.json", "op": "set", "path": _element_path(screen_id, element_id, "label"),
                            "value": new_label, "note": f"was '{old}'"})
            changes.append({"file": "screens.json", "op": "set", "path": _element_path(screen_id, element_id, "aliases"),
                            "value": aliases, "note": "old label kept as an alias"})
            for journey_id, journey in kb.journeys.items():
                for step in journey.get("steps", []):
                    if step.get("element_id") == element_id and old and old in step.get("action", ""):
                        rel = _journey_file(kb, journey_id)
                        changes.append({
                            "file": rel, "op": "set", "path": f"steps[step_number={step['step_number']}].action",
                            "value": step["action"].replace(old, new_label),
                            "note": f"{journey['name']} step {step['step_number']}",
                        })
            title = f"Use the application's label '{new_label}' for {screen_id} · {element_id}"
        else:
            accepted = list(current.get("accepted_labels") or [])
            if new_label not in accepted:
                accepted.append(new_label)
            changes.append({"file": "screens.json", "op": "set", "path": _element_path(screen_id, element_id, "accepted_labels"),
                            "value": accepted, "note": f"'{new_label}' accepted alongside '{current.get('label')}'"})
            title = f"Accept '{new_label}' as well as '{current.get('label')}' for {screen_id} · {element_id}"
        return draft(db, app_id=app_id, kb="journey", title=title, changes=changes, source="reconcile",
                     description=note, origin=origin, actor=actor)

    if decision == "design":
        current = element()
        title = f"Defect: the application shows '{app_label}' where the design says '{current.get('label')}' ({screen_id} · {element_id})"
        return draft(db, app_id=app_id, kb="journey", title=title, changes=[], source="reconcile",
                     description=note, kind="defect", origin=origin, actor=actor)

    if decision == "unlink":
        element()
        return draft(db, app_id=app_id, kb="journey",
                     title=f"Clear the broken Automation KB reference of {screen_id} · {element_id}",
                     changes=[{"file": "screens.json", "op": "set",
                               "path": _element_path(screen_id, element_id, "automation_ref"), "value": None,
                               "note": "the Automation KB no longer has this entry; the next crawl links it again"}],
                     source="reconcile", description=note, origin=origin, actor=actor)

    if decision == "add":
        if not screen_id or screen_id not in kb.screens:
            raise ChangeSetError("Choose the screen this control belongs to.")
        if not automation_ref:
            raise ChangeSetError("The Automation KB entry to add is missing.")
        new_id = re.sub(r"[^a-z0-9_]+", "_", (element_id or automation_ref.split(".")[-1]).lower()).strip("_")
        if any(e.get("element_id") == new_id for e in kb.screens[screen_id].get("elements", [])):
            raise ChangeSetError(f"{screen_id} already has an element '{new_id}'.")
        new_element = {
            "element_id": new_id, "label": (label or app_label or new_id).strip(), "type": "control",
            "basis": "qa_observed", "automation_ref": automation_ref,
            "note": "Added from Reconcile: present in the Automation KB, absent from the design documents.",
        }
        return draft(db, app_id=app_id, kb="journey",
                     title=f"Add {new_id} to {screen_id} (known to the Automation KB, missing from the design)",
                     changes=[{"file": "screens.json", "op": "set", "path": _element_path(screen_id, new_id),
                               "value": new_element}],
                     source="reconcile", description=note, origin=origin, actor=actor)

    raise ChangeSetError(f"Unknown decision '{decision}'.")


def _journey_file(kb: store.JourneyKB, journey_id: str) -> str:
    journeys_dir = kb.manifest.get("files", {}).get("journeys_dir", "journeys")
    for path in sorted((kb.directory / journeys_dir).glob("*.json")):
        try:
            if json.loads(path.read_text(encoding="utf-8")).get("journey_id") == journey_id:
                return f"{journeys_dir}/{path.name}"
        except Exception:  # noqa: BLE001
            continue
    raise ChangeSetError(f"No journey file for {journey_id}.")


def publish_with_pair(db: Session, change_set_id: int, *, actor: Optional[str], note: Optional[str] = None) -> List[KbVersion]:
    """Publish a change set, and first its crawl partner when it needs one.

    A crawl proposes two change sets: selectors for the Automation KB and the
    Journey KB links that point at them. A link to a selector that does not
    exist yet would read as a broken reference, so approving the Journey KB
    half publishes its Automation KB partner first. Approving the Automation
    KB half alone is fine -- a selector nothing links to yet harms nothing.
    """
    change_set = db.get(KbChangeSet, change_set_id)
    if change_set is None:
        raise LookupError("No such change set.")
    published: List[KbVersion] = []
    pair_id = ((change_set.origin or {}).get("crawl") or {}).get("pair")
    if change_set.kb == "journey" and pair_id:
        partner = db.get(KbChangeSet, pair_id)
        if partner is not None and partner.status in ("draft", "conflicted"):
            version = publish(db, partner.id, actor=actor, note=note or f"Published with change set #{change_set.id}")
            if version:
                published.append(version)
    version = publish(db, change_set_id, actor=actor, note=note)
    if version:
        published.append(version)
    return published
