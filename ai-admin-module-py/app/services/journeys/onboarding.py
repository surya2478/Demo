"""
--- Journey KB: a new application's starting point ------------------------------

A Journey KB used to come into being only by hand: someone made the folder,
wrote journey_kb.json and transcribed the master topic list. Until then the
Knowledge Base page could not show the application, and an uploaded PDF had
nothing to land on -- extraction only places journeys on nodes of the master
list, so every journey came back "not in master list".

This module writes that starting point from what an engineer can type on the
page: the application's name, its key (the folder both KBs share) and, if they
have one, the master topic list -- one journey per line, two spaces of indent
per level, chapters at the left margin. It is the same outline format
taxonomy.py reads for the B2B Portal, so the tree is built by the same code.

It writes the empty catalogues every loader expects (screens, rules, roles,
state models) and nothing else: no screen, element or journey is invented.
Everything after this goes through change sets as before. Creating the folder
is the one write that is not a change set -- there is nothing yet to version.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import store, taxonomy

KEY = re.compile(r"^[a-z0-9][a-z0-9_-]{1,99}$")
_PREFIX = re.compile(r"^[A-Z][A-Z0-9]{0,11}$")
OUTLINE = "sources/explore_topics_outline.txt"
OVERLAY = "sources/taxonomy_overlay.json"
MASTER_SOURCE = "Master topic list (master list, entered on the Knowledge Base page)"


class OnboardingError(ValueError):
    """A Journey KB that cannot be created as asked."""


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", (name or "").strip().lower()).strip("_")[:100]


def default_prefix(app_key: str) -> str:
    """Journey ids start with this: e&_money -> MONEY, eand_b2b_portal -> B2B."""
    words = [w for w in re.split(r"[^a-z0-9]+", app_key.lower()) if w and w not in ("e", "eand", "app", "uae", "ae")]
    return (words[0] if words else app_key)[:12].upper() or "APP"


def _chapter_code(title: str, used: set) -> str:
    words = [w for w in re.findall(r"[A-Za-z0-9]+", title) if w.lower() not in taxonomy.STOPWORDS]
    base = (words[0] if words else "CHAPTER")[:10].upper()
    code, n = base, 2
    while code in used:
        code, n = f"{base}{n}", n + 1
    used.add(code)
    return code


def normalise_outline(text: Optional[str]) -> str:
    """The typed list as taxonomy.py reads it.

    Tabs count as one level; a top-level line without "CODE | " gets a code
    from its first word. Blank lines and '#' comments are kept out. A line
    indented deeper than one level below the line above is pulled up, so a
    stray space cannot orphan a journey.
    """
    used: set = set()
    out: List[str] = ["# Master topic list, entered on the Knowledge Base page.",
                      "# Two spaces of indent per level; chapters carry 'CODE | Title'."]
    previous = -1
    for raw in (text or "").replace("\t", "  ").splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        depth = (len(raw) - len(raw.lstrip(" "))) // 2
        line = re.sub(r"^[-*•]\s*", "", raw.strip())
        line = re.sub(r"\s+", " ", line)
        if not line:
            continue
        depth = min(depth, previous + 1)
        if depth == 0:
            if "|" in line:
                code, title = [p.strip() for p in line.split("|", 1)]
                code = re.sub(r"[^A-Z0-9]", "", code.upper())[:10] or _chapter_code(title, used)
                if code in used:
                    code = _chapter_code(code, used)
                used.add(code)
            else:
                title = line
                code = _chapter_code(title, used)
            if not title:
                continue
            out.append(f"{code} | {title}")
        else:
            out.append("  " * depth + line.replace("|", "/"))
        previous = depth
    return "\n".join(out) + "\n"


def _write(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, str):
        path.write_text(data, encoding="utf-8")
    else:
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def create(app_key: str, app_name: str, *, id_prefix: Optional[str] = None, outline: Optional[str] = None,
           automation_app_id: Optional[str] = None) -> store.JourneyKB:
    """Write a new, empty Journey KB for `app_key`; refuse one that exists."""
    app_key = (app_key or "").strip().lower()
    app_name = re.sub(r"\s+", " ", (app_name or "")).strip()
    if not KEY.match(app_key):
        raise OnboardingError("The key is 2-100 lower-case letters, digits, '_' or '-', starting with a letter or digit.")
    if not app_name:
        raise OnboardingError("The application needs a name.")
    prefix = (id_prefix or "").strip().upper() or default_prefix(app_key)
    if not _PREFIX.match(prefix):
        raise OnboardingError("The journey id prefix is 1-12 capital letters or digits, starting with a letter.")
    directory = store.journey_kb_root() / app_key
    if (directory / "journey_kb.json").exists():
        raise OnboardingError(f"A Journey KB for '{app_key}' already exists.")

    outline_text = normalise_outline(outline)
    has_outline = any(not l.startswith("#") for l in outline_text.splitlines() if l.strip())
    manifest = {
        "app_id": app_key,
        "app_name": app_name,
        "automation_app_id": automation_app_id or app_key,
        "id_prefix": prefix,
        "layer": "design",
        "_purpose": "Journey KB: the business/solution-design view of the application, built from design documents. "
                    "It says WHAT a user does and sees -- journeys, screens, exact labels, branches, rules. Locators belong "
                    "to the Automation KB (knowledge_base/applications/<automation_app_id>), built by crawling the running "
                    "application; the two are joined by `automation_ref` on screen elements.",
        "sources": [MASTER_SOURCE] if has_outline else [],
        "files": {
            "taxonomy": "taxonomy.json", "screens": "screens.json", "business_rules": "business_rules.json",
            "state_models": "state_models.json", "roles": "roles.json", "journeys_dir": "journeys",
        },
        "generation_directives": [
            "Quote every screen title, button, field, tab, link and message EXACTLY as the Journey KB lists it. Do not paraphrase a label.",
            "Write one user action per step, in the order of the journey's steps. Where the journey has prerequisite journeys, include their steps first.",
        ],
    }
    try:
        _write(directory / "journey_kb.json", manifest)
        _write(directory / "screens.json", {"_purpose": "Screen catalogue (design): pages and their elements with exact labels. No locators.", "screens": []})
        _write(directory / "business_rules.json", {"_purpose": "Business rules and validations from the design documents.", "rules": []})
        _write(directory / "roles.json", {"_purpose": "User types. Test preconditions name a role id from here.", "roles": [
            {"role_id": "ROLE_ANONYMOUS", "name": "Not signed in", "basis": "default"},
            {"role_id": "ROLE_USER", "name": "Signed-in user", "basis": "default"},
        ]})
        _write(directory / "state_models.json", {"_purpose": "State machines implied by the design.", "state_models": []})
        (directory / "journeys").mkdir(parents=True, exist_ok=True)
        (directory / "sources" / "documents").mkdir(parents=True, exist_ok=True)
        _write(directory / OUTLINE, outline_text)
        _write(directory / OVERLAY, {
            "_purpose": "Facts layered onto the master topic list by taxonomy.py; edits on the Knowledge Base page land here.",
            "id_aliases": {}, "chapter_entry_points": {}, "unauthenticated_chapters": [], "anonymous_title_markers": [],
            # A new application has no sign-in journey yet; one is named here
            # once it is authored, and journeys added after that run it first.
            "session_prerequisites": [],
            "nodes": {}, "automation_only": {}, "child_order": {},
        })
        taxonomy.write(directory)
    except Exception:
        # Half a KB would be listed (journey_kb.json exists) and then fail to
        # load; take it all away and report the cause.
        import shutil

        shutil.rmtree(directory, ignore_errors=True)
        raise
    kb = store.load(app_key)
    if kb is None:
        raise OnboardingError("The Journey KB was written but could not be read back.")
    return kb


def rename(app_key: str, app_name: str) -> Optional[Dict[str, Any]]:
    """Set the display name in journey_kb.json; None when the app has no Journey KB.

    The name is a label, not knowledge -- ids, files and test cases name the
    key -- so it is written directly rather than as a change set.
    """
    path = store.journey_kb_root() / app_key / "journey_kb.json"
    if not path.exists():
        return None
    manifest = json.loads(path.read_text(encoding="utf-8"))
    manifest["app_name"] = app_name
    _write(path, manifest)
    return manifest


def archive_root() -> Path:
    """Where deleted applications' Knowledge Base folders are kept, beside journeys/ and applications/."""
    return store.journey_kb_root().parent / "_deleted"


def archive(app_key: str, folders: Dict[str, Path]) -> Optional[Path]:
    """Move an application's KB folders under _deleted/<key>-<time>/; None when there were none.

    Nothing is erased: a deleted application can be restored by moving its
    folders back. A move that fails puts back what had already moved.
    """
    import shutil
    from datetime import datetime

    present = {label: path for label, path in folders.items() if path.exists()}
    if not present:
        return None
    target = archive_root() / f"{app_key}-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    target.mkdir(parents=True, exist_ok=False)
    moved: List[tuple] = []
    try:
        for label, path in present.items():
            shutil.move(str(path), str(target / label))
            moved.append((target / label, path))
    except Exception:
        for archived, original in reversed(moved):
            shutil.move(str(archived), str(original))
        shutil.rmtree(target, ignore_errors=True)
        raise
    return target
