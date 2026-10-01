"""Build a Journey KB's taxonomy.json from its transcribed topic outline.

The outline (sources/explore_topics_outline.txt) is a verbatim transcription
of the master design document's topic tree; the overlay
(sources/taxonomy_overlay.json) carries what we know about individual
journeys. Keeping the two apart means a new release of the master document is
a text diff, and a newly documented journey is an overlay edit -- neither
touches the generated file.

Edits made on the Knowledge Base page are overlay edits too, so a journey's id
never changes under the files and test cases that name it:

  nodes[id].title    renames a journey (paths below it follow)
  added_nodes        [{id, title, parent}] journeys the outline does not list;
                     parent null makes a new top-level chapter
  removed_nodes      [id] journeys taken out of the tree, with everything below
  child_order        {parent id | "$roots": [ids]} sibling order; ids not
                     listed keep their place after the listed ones

Run from ai-admin-module-py:

    python -m app.services.journeys.taxonomy eand_b2b_portal
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Iterator

STOPWORDS = {
    "to", "the", "a", "an", "of", "for", "on", "in", "and", "by", "under",
    "with", "using", "through", "b2b", "portal", "from", "at", "via", "is",
}

# Parents are only "detailed" when every child is; any mix is "partial".
STATUS_LEGEND = {
    "detailed": "journey file authored; usable for test generation",
    "source_available": "screen-level design document analysed, journey file not yet authored",
    "awaiting_source": "only the master-list title is known; needs a BRD or screen-flow document",
    "automation_only": "exists in the Automation KB (crawled) with no design source yet",
    "partial": "group or chapter whose journeys are at different stages",
}


def _slug(title: str, aliases: dict) -> str:
    if title in aliases:
        return aliases[title]
    words = [w for w in re.findall(r"[A-Za-z0-9]+", title) if w.lower() not in STOPWORDS]
    return "_".join(words[:4]).upper() or "NODE"


def _parse_outline(text: str) -> Iterator[tuple[int, str, set, str | None]]:
    """(depth, title, tags, chapter_code) for every non-comment line."""
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        depth = (len(raw) - len(raw.lstrip(" "))) // 2
        line = raw.strip()
        tags = set(re.findall(r"\[\+(\w+)\]", line))
        line = re.sub(r"\s*\[\+\w+\]", "", line).strip()
        code = None
        if depth == 0:
            code, line = [part.strip() for part in line.split("|", 1)]
        yield depth, line, tags, code


def build(kb_dir: Path) -> dict:
    overlay = json.loads((kb_dir / "sources" / "taxonomy_overlay.json").read_text(encoding="utf-8"))
    outline = (kb_dir / "sources" / "explore_topics_outline.txt").read_text(encoding="utf-8")
    manifest = json.loads((kb_dir / "journey_kb.json").read_text(encoding="utf-8"))
    aliases = overlay["id_aliases"]
    entry_points = overlay.get("chapter_entry_points", {})
    unauth = set(overlay.get("unauthenticated_chapters", []))
    anon_markers = overlay.get("anonymous_title_markers", [])
    prefix = manifest.get("id_prefix", "B2B")
    session_prereqs = overlay.get(
        "session_prerequisites",
        [f"{prefix}.REG.EXISTING.SIGNIN", f"{prefix}.REG.EXISTING.SIGNIN.SELECT_ORG"],
    )

    nodes: list[dict] = []
    by_id: dict[str, dict] = {}
    stack: list[dict] = []

    def add(node: dict, parent: dict | None) -> None:
        if parent:
            parent["children"].append(node["id"])
        nodes.append(node)
        by_id[node["id"]] = node

    for depth, title, tags, code in _parse_outline(outline):
        stack = stack[:depth]
        parent = stack[-1] if stack else None
        chapter = code or stack[0]["chapter"]
        base_id = f"{prefix}.{code}" if depth == 0 else f"{parent['id']}.{_slug(title, aliases)}"
        node_id, n = base_id, 2
        while node_id in by_id:  # repeated sibling titles, e.g. "Editing Users"
            node_id, n = f"{base_id}_{n}", n + 1

        kind = "chapter" if depth == 0 else ("variant" if "pdf" in tags else "shared" if "shared" in tags else "journey")
        node = {
            "id": node_id,
            "title": title,
            "kind": kind,
            "level": depth + 1,
            "chapter": chapter,
            "parent": parent["id"] if parent else None,
            "path": [p["title"] for p in stack] + [title],
            "children": [],
            "status": "awaiting_source",
            "sources": ["master topic list"],
        }
        if depth > 0:
            anonymous = chapter in unauth or any(m in title.lower() for m in anon_markers)
            node["audience"] = "anonymous" if anonymous else "authenticated"
            node["prerequisite_journeys"] = [] if anonymous else list(session_prereqs)
            if not anonymous and chapter in entry_points:
                node["entry_point"] = f"Organization Dashboard > {entry_points[chapter]}"
                node["entry_point_inferred"] = True
        if parent and parent["kind"] == "journey" and kind == "journey":
            parent["kind"] = "group"
        add(node, parent)
        stack.append(node)

    # Journeys added on the Knowledge Base page, in the order they were added,
    # so a child can be added under a journey added before it.
    for extra in overlay.get("added_nodes", []):
        parent = by_id.get(extra.get("parent")) if extra.get("parent") else None
        if extra.get("parent") and parent is None:
            raise ValueError(f"taxonomy_overlay.json adds {extra.get('id')} under unknown journey {extra.get('parent')}")
        if extra["id"] in by_id:
            raise ValueError(f"taxonomy_overlay.json adds {extra['id']}, which already exists")
        chapter = parent["chapter"] if parent else extra["id"].split(".")[-1]
        node = {
            "id": extra["id"],
            "title": extra["title"],
            "kind": "chapter" if parent is None else extra.get("kind", "journey"),
            "level": (parent["level"] + 1) if parent else 1,
            "chapter": chapter,
            "parent": parent["id"] if parent else None,
            "path": [],
            "children": [],
            "status": "awaiting_source",
            "sources": ["added on the Knowledge Base page"],
        }
        if parent is not None:
            anonymous = chapter in unauth
            node["audience"] = "anonymous" if anonymous else "authenticated"
            node["prerequisite_journeys"] = [] if anonymous else list(session_prereqs)
            if parent["kind"] == "journey":
                parent["kind"] = "group"
        add(node, parent)

    for flow_id, link in overlay.get("automation_only", {}).items():
        if flow_id.startswith("_"):
            continue
        chapter = by_id[f"{prefix}.{link['attach_to_chapter']}"]
        add(
            {
                "id": f"{chapter['id']}.{_slug(link['as_title'], aliases)}",
                "title": link["as_title"],
                "kind": "journey",
                "level": 2,
                "chapter": chapter["chapter"],
                "parent": chapter["id"],
                "path": [chapter["title"], link["as_title"]],
                "children": [],
                "status": "automation_only",
                "sources": ["Automation KB"],
                "audience": "authenticated",
                "prerequisite_journeys": link.get("prerequisite_journeys", []),
                "automation_flow_ids": [flow_id],
            },
            chapter,
        )

    for node_id, extra in overlay.get("nodes", {}).items():
        if node_id not in by_id:
            raise ValueError(f"taxonomy_overlay.json names unknown journey id {node_id}")
        node = by_id[node_id]
        node.update({k: v for k, v in extra.items() if k != "sources"})
        node["sources"] = node["sources"] + extra.get("sources", [])

    # Journeys removed on the Knowledge Base page go with everything below them.
    removed: set[str] = set()
    for node_id in overlay.get("removed_nodes", []):
        pending = [node_id] if node_id in by_id else []
        while pending:
            current = pending.pop()
            if current not in removed:
                removed.add(current)
                pending.extend(by_id[current]["children"])
    if removed:
        nodes = [n for n in nodes if n["id"] not in removed]
        for node in nodes:
            if any(c in removed for c in node["children"]):
                node["children"] = [c for c in node["children"] if c not in removed]
                if not node["children"] and node["kind"] == "group":
                    node["kind"] = "journey"
        by_id = {n["id"]: n for n in nodes}

    def ordered(ids: list[str], wanted: list[str]) -> list[str]:
        first = [i for i in wanted if i in ids]
        return first + [i for i in ids if i not in first]

    child_order = overlay.get("child_order", {})
    for parent_id, wanted in child_order.items():
        if parent_id in by_id:
            by_id[parent_id]["children"] = ordered(by_id[parent_id]["children"], wanted)

    # Paths from the final titles, so a renamed journey reads right everywhere
    # below it. Parents come before their children in `nodes`.
    for node in nodes:
        parent = by_id.get(node["parent"]) if node["parent"] else None
        node["path"] = (parent["path"] if parent else []) + [node["title"]]

    # Children follow their parent in `nodes`, so walking backwards settles
    # every child before its parent is rolled up.
    for node in reversed(nodes):
        if not node["children"]:
            continue
        # A journey with variants that has its own journey file (the steps its
        # variants share) is as detailed as that file, whatever its variants are.
        if node.get("journey_file") and node.get("status") == "detailed":
            continue
        statuses = {by_id[c]["status"] for c in node["children"]}
        if len(statuses) == 1:
            node["status"] = statuses.pop()
        elif statuses != {"awaiting_source"}:
            node["status"] = "partial"

    counts: dict[str, int] = {}
    for node in nodes:
        if node["kind"] != "chapter" and not node["children"]:
            counts[node["status"]] = counts.get(node["status"], 0) + 1

    return {
        "_generated_by": "python -m app.services.journeys.taxonomy -- do not edit by hand",
        "_status_legend": STATUS_LEGEND,
        "_composition": "An authenticated journey runs as its prerequisite_journeys, in order, then its own steps. SIGNIN is satisfied by any one of its variants.",
        "app_id": manifest["app_id"],
        "summary": {"total_nodes": len(nodes), "journey_status_counts": counts},
        "roots": ordered([n["id"] for n in nodes if n["parent"] is None], child_order.get("$roots", [])),
        "nodes": nodes,
    }


def write(kb_dir: Path) -> dict:
    data = build(kb_dir)
    (kb_dir / "taxonomy.json").write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return data


if __name__ == "__main__":
    from .store import journey_kb_root

    app_id = sys.argv[1] if len(sys.argv) > 1 else "eand_b2b_portal"
    result = write(journey_kb_root() / app_id)
    print(f"taxonomy.json written for {app_id}: {result['summary']}")
