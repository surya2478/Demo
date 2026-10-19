"""
--- Automation Module: grounding --------------------------------------------

Match a refined test case's steps against the elements discovery actually
found.

Ported from stlc-platform's grounding_service. Pure functions over a catalogue,
no I/O and no mutation, so the whole thing is testable without a browser or a
database.

The constants carry their tuning: the role affinities, the stopword list and
the minimum score were arrived at against real batches, and changing them
changes which matches are trusted. They are kept as they were.

Naming the steps that do NOT match is the point. A generator handed a partial
catalogue will happily invent a locator for the rest; an unresolved list is what
stops that, and what tells an author whether the gap is a missing page or a
label the application words differently.
"""
from __future__ import annotations

import re
from typing import Any, Optional

# What a step's verb implies about the element's ARIA role. A step saying
# "enter the username" cannot be satisfied by a button, no matter how well the
# words overlap -- role affinity is what keeps a high text score from matching
# the wrong kind of control.
_ROLE_AFFINITY: tuple[tuple[tuple[str, ...], frozenset[str]], ...] = (
    (
        ("enter", "type", "input", "fill", "key in", "provide", "populate"),
        frozenset({"textbox", "searchbox", "combobox", "spinbutton"}),
    ),
    (("select", "choose", "pick"), frozenset({"combobox", "listbox", "option", "menuitem"})),
    (("check", "tick", "toggle"), frozenset({"checkbox", "switch", "radio"})),
    (("uncheck", "untick"), frozenset({"checkbox", "switch"})),
    (
        ("click", "press", "tap", "submit", "confirm"),
        frozenset({"button", "link", "menuitem", "tab"}),
    ),
)

# Steps whose verb needs no element at all. Left out of the score entirely
# rather than counted as failures -- reporting "navigate to the home page" as
# an unresolved locator would bury the gaps that actually matter.
_NON_ELEMENT_VERBS = (
    "navigate", "go to", "open the", "launch", "wait", "observe", "note",
    "ensure that", "confirm that", "the system", "user is", "log out and",
)

_STOPWORDS = frozenset({
    "the", "a", "an", "and", "or", "of", "on", "in", "to", "for", "with",
    "button", "field", "link", "icon", "box", "input", "page", "screen",
    "click", "enter", "type", "select", "press", "valid", "user", "users",
})

# Below this, a match is a coincidence. Two shared meaningful words is the
# smallest overlap that reliably distinguished a real match from a wrong one on
# the batches this was built against; one word matches "Search" against
# "Search results heading" as readily as against the search box.
_MIN_SCORE = 2

_WORD_RE = re.compile(r"[^a-z0-9]+")

STATUS_NOT_CHECKED = "not_checked"
STATUS_GROUNDED = "grounded"
STATUS_PARTIAL = "partially_grounded"
STATUS_UNGROUNDED = "ungrounded"


def _tokens(text: Optional[str]) -> set[str]:
    if not text:
        return set()
    return {
        word
        for word in _WORD_RE.split(text.lower())
        if len(word) > 2 and word not in _STOPWORDS
    }


def _affine_roles(action: str) -> frozenset[str]:
    lowered = (action or "").lower()
    for verbs, roles in _ROLE_AFFINITY:
        if any(verb in lowered for verb in verbs):
            return roles
    return frozenset()


def needs_element(step: dict) -> bool:
    """Whether this step is expected to touch a specific control."""
    if not (step.get("target") or "").strip():
        return False
    action = (step.get("action") or "").lower()
    return not any(verb in action for verb in _NON_ELEMENT_VERBS)


def _score(step_tokens: set[str], entry: dict) -> int:
    """Overlap between the step's words and everything known about an element.

    The accessible name is weighted double: it is what the locator will
    actually match on, whereas business meaning is a label attached during
    discovery and element_name is a slug derived from the other two.
    """
    name_overlap = len(step_tokens & _tokens(entry.get("accessible_name")))
    other_overlap = len(
        step_tokens
        & (_tokens(entry.get("business_meaning")) | _tokens(entry.get("element_name")))
    )
    return name_overlap * 2 + other_overlap


# --- What the target names, for the coverage check ---------------------------
#
# The score above counts shared words between the whole step -- action and
# target -- and everything known about an element. On a 349-element crawl that
# let one incidental word decide: "Locate the user row with Trade License
# 'TL123456'" tied "Locate Business Center" (the verb) with "Device Trade-In"
# (half a word of the target), and "Manage Users" took the consumer site's
# "Manage" tab. So a fuzzy match must now also cover MORE THAN HALF of what the
# target names, counted with "user"/"users" kept (they distinguish "Manage
# Users" from "Manage") and with the words that say what kind of thing an
# element is dropped (a row, a menu item, a modal -- the element's name never
# contains those).
_KIND_WORDS = frozenset({
    "row", "rows", "column", "columns", "cell", "cells", "menu", "item", "items",
    "option", "options", "list", "table", "modal", "dialog", "popup", "section",
    "fields", "buttons", "links", "header", "label", "dropdown", "checkbox",
    "radio", "tab", "panel", "card", "area", "text", "value",
})
_COVERAGE_IGNORED = (_STOPWORDS - {"user", "users"}) | _KIND_WORDS

_QUOTED_RE = re.compile(r"(?<![\w])[\"'‘“]([^\"'’”\n]{1,80})[\"'’”](?![\w])")


def _target_words(text: Optional[str]) -> set[str]:
    if not text:
        return set()
    return {
        word
        for word in _WORD_RE.split(text.lower())
        if len(word) > 2 and word not in _COVERAGE_IGNORED
    }


def quoted_labels(text: Optional[str]) -> list[str]:
    """Labels a step quotes verbatim ("Click 'RECEIVE OTP'" -> RECEIVE OTP).

    The opening quote may not follow a letter, so "user's row" is not read as
    the start of a quotation.
    """
    return [q.strip() for q in _QUOTED_RE.findall(text or "") if q.strip()]


def _label_key(text: Optional[str]) -> str:
    """An accessible name compared as a set of words, "user(s)" kept.

    Compared on _tokens, which drops "users" as a stopword, "Manage Users" was an
    EXACT match for the "Manage" link.
    """
    return " ".join(sorted(_target_words(text)))


def _covers(target_words: set[str], entry: dict) -> bool:
    """Whether `entry` names what the target names, not just one word of it.

    Both ways: the element must cover more than half of the target, and the
    target more than half of the element's own name -- "Trade License column"
    is not "Upload your Trade License", though every target word is in it.
    """
    if not target_words:
        return True
    name = _target_words(entry.get("accessible_name"))
    shared = target_words & name
    if not shared or len(shared) * 2 <= len(name):
        return False
    known = name | _target_words(entry.get("business_meaning")) | _target_words(
        (entry.get("element_name") or "").replace("_", " ")
    )
    return len(target_words & known) * 2 > len(target_words)


def scope_catalog(catalog: list[dict], base_url: Optional[str]) -> list[dict]:
    """The part of a crawl that belongs to the application at `base_url`.

    A crawl follows links off the application -- the B2B Portal's catalogue is
    mostly the consumer site's home page -- and an element there is a real
    element of a different application, which is the worst kind of match: it
    resolves, on the wrong page. Entries without a page are kept. When the
    application's URL has no path, or nothing would be left, the catalogue is
    returned unchanged.
    """
    match = re.match(r"https?://([^/?#]+)(/[^?#]*)?", (base_url or "").strip(), re.I)
    if not match:
        return catalog
    host = match.group(1).lower()
    path = (match.group(2) or "/").rstrip("/")
    # "/b2bportal/login.html" scopes to "/b2bportal", not to the page itself.
    if "." in path.rsplit("/", 1)[-1]:
        path = path.rsplit("/", 1)[0]
    if not path:
        return catalog
    scoped = []
    for entry in catalog:
        page = str(entry.get("page") or "")
        page_match = re.match(r"https?://([^/?#]+)(/[^?#]*)?", page, re.I)
        if not page_match:
            scoped.append(entry)
            continue
        page_path = page_match.group(2) or "/"
        if page_match.group(1).lower() == host and (
            page_path == path or page_path.startswith(path + "/")
        ):
            scoped.append(entry)
    return scoped or catalog


def match_step(step: dict, catalog: list[dict]) -> tuple[Optional[dict], Optional[str]]:
    """Best catalogue entry for one step, or (None, reason).

    A label the step quotes, matched exactly, wins outright. Otherwise role
    affinity narrows the field first; when nothing of the right role matches,
    the whole catalogue is retried so a step whose verb was phrased unusually
    still has a chance -- but a match found that way has to clear the same
    score bar, and the same coverage of the target.
    """
    target = (step.get("target") or "").strip()
    target_tokens = _tokens(target)
    # The target is what names the element; the action's words only join in
    # when the target says nothing on its own. Scoring the verb as well is how
    # "Locate ..." matched "Locate Business Center".
    step_tokens = target_tokens or _tokens(step.get("action"))
    if not step_tokens:
        return None, "The step names no target to match against."
    target_words = _target_words(target)

    exact = _label_key(target)
    roles = _affine_roles(step.get("action") or "")
    quoted = {
        _label_key(q) for q in quoted_labels(target) + quoted_labels(step.get("action"))
    } - {""}

    def _search(pool: list[dict]) -> tuple[Optional[dict], Optional[str]]:
        if not pool:
            return None, None
        for entry in pool:
            if exact and _label_key(entry.get("accessible_name")) == exact:
                return entry, None
        if quoted:
            hits = [e for e in pool if _label_key(e.get("accessible_name")) in quoted]
            if hits:
                return max(hits, key=lambda e: int(e.get("confidence_score") or 0)), None
        candidates = [e for e in pool if _covers(target_words, e)]
        if not candidates:
            return None, None
        ranked = sorted(
            candidates,
            key=lambda e: (-_score(step_tokens, e), -int(e.get("confidence_score") or 0)),
        )
        best = ranked[0]
        best_score = _score(step_tokens, best)
        if best_score < _MIN_SCORE:
            return None, None
        runners_up = [
            e for e in ranked[1:]
            if _score(step_tokens, e) == best_score
            and e.get("recommended_locator") != best.get("recommended_locator")
        ]
        if runners_up:
            names = ", ".join(
                f'"{e.get("accessible_name") or e.get("element_name")}"'
                for e in [best, *runners_up[:2]]
            )
            return None, (
                f"Matches more than one discovered element equally well ({names}). "
                "Make the step's target more specific."
            )
        return best, None

    if roles:
        entry, reason = _search([e for e in catalog if (e.get("role") or "") in roles])
        if entry is not None or reason is not None:
            return entry, reason

    entry, reason = _search(catalog)
    if entry is not None:
        return entry, None
    if reason is not None:
        return None, reason
    return None, (
        f'No discovered element matches "{target}". Either the page holding it was not '
        "crawled, or it renders with a different label than the test case expects."
    )


def ground_test_case(steps: list[Any], catalog: list[dict]) -> dict:
    """The grounding summary for one test case. Pure -- no I/O, no mutation."""
    matched: list[dict] = []
    unresolved: list[dict] = []
    skipped = 0

    for index, step in enumerate(steps or []):
        if not isinstance(step, dict):
            continue
        step_number = step.get("step_number") or (index + 1)
        if not needs_element(step):
            skipped += 1
            continue
        entry, reason = match_step(step, catalog)
        if entry is None:
            unresolved.append(
                {
                    "step_number": step_number,
                    "action": step.get("action"),
                    "target": step.get("target"),
                    "reason": reason or "No matching element was discovered.",
                }
            )
            continue
        matched.append(
            {
                "step_number": step_number,
                "target": step.get("target"),
                "element_name": entry.get("element_name"),
                "locator": entry.get("recommended_locator"),
                "strategy": entry.get("recommended_strategy"),
                "page": entry.get("page"),
                "confidence": entry.get("confidence_score"),
            }
        )

    groundable = len(matched) + len(unresolved)
    if groundable == 0:
        status = STATUS_UNGROUNDED
        note = (
            "No step in this test case names a UI control, so there is nothing to match "
            "against the discovered application."
        )
    elif not unresolved:
        status = STATUS_GROUNDED
        note = None
    elif matched:
        status = STATUS_PARTIAL
        note = None
    else:
        status = STATUS_UNGROUNDED
        note = None

    return {
        "status": status,
        "note": note,
        "matched": matched,
        "unresolved": unresolved,
        "skipped": skipped,
        "catalog_size": len(catalog),
    }
