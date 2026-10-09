"""Move Knowledge Base history (change sets, versions, heals) between databases.

The KB files themselves (knowledge_base/...) are what the app runs on and travel
with git / WinSCP. This script carries the history the Knowledge Base page shows
for them -- Change sets, History (versions, Revert), Change & Heal and the
source document records -- from one admin.db into another, without touching
anything else in either database.

Export (your machine):
    python kb_history_transfer.py export --db admin.db --app eand_b2b_portal --out kb_history.json
        [--since 2026-10-01] [--change-sets 35-38,40] [--include-crawls]

Import (server; dry run unless --apply):
    python kb_history_transfer.py import --db /app/external-db/admin.db --in kb_history.json [--apply]

Import gives every row a new id and rewrites every reference between them, so
nothing clashes with the server's own records. Version numbers continue after
the server's highest for that application and KB. Rows already on the server
(an earlier import, or the same change set) are skipped, so running it twice
adds nothing. --apply takes a backup copy of the database first and writes in
one transaction: all of it lands, or none of it.

Uses only the standard library, so it runs inside the backend container:
    docker cp kb_history_transfer.py <container>:/tmp/
    docker cp kb_history.json <container>:/tmp/
    docker exec <container> python /tmp/kb_history_transfer.py import --db /app/external-db/admin.db --in /tmp/kb_history.json
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime
from typing import Any, Dict, List, Optional, Set

FORMAT = "kb-history/1"
TABLES = ["kb_change_sets", "kb_changes", "kb_versions", "kb_heals", "kb_source_documents", "kb_crawl_runs"]


def _connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def _columns(conn: sqlite3.Connection, table: str) -> List[str]:
    return [row[1] for row in conn.execute(f"PRAGMA table_info({table})")]


def _rows(conn: sqlite3.Connection, sql: str, args: tuple = ()) -> List[Dict[str, Any]]:
    return [dict(row) for row in conn.execute(sql, args)]


def _ids(spec: Optional[str]) -> Optional[Set[int]]:
    """'35-38,40' -> {35, 36, 37, 38, 40}."""
    if not spec:
        return None
    ids: Set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            low, high = part.split("-", 1)
            ids.update(range(int(low), int(high) + 1))
        elif part:
            ids.add(int(part))
    return ids


def _json(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return None
    return value


# --- Export --------------------------------------------------------------------------------

def export(args: argparse.Namespace) -> int:
    conn = _connect(args.db)
    wanted = _ids(args.change_sets)
    sets = _rows(conn, "SELECT * FROM kb_change_sets WHERE app_id = ? ORDER BY id", (args.app,))
    if args.since:
        sets = [s for s in sets if (s["created_at"] or "") >= args.since]
    if wanted is not None:
        sets = [s for s in sets if s["id"] in wanted]
    set_ids = {s["id"] for s in sets}

    versions = [
        v for v in _rows(conn, "SELECT * FROM kb_versions WHERE app_id = ? ORDER BY id", (args.app,))
        # A revert has no change set: it comes along when it falls in --since,
        # or with the whole history.
        if v["change_set_id"] in set_ids
        or (v["change_set_id"] is None and wanted is None and (v["published_at"] or "") >= (args.since or ""))
    ]
    version_ids = {v["id"] for v in versions}
    changes = [
        c for c in _rows(conn, "SELECT * FROM kb_changes ORDER BY change_set_id, position, id")
        if c["change_set_id"] in set_ids
    ]
    heals = [
        h for h in _rows(conn, "SELECT * FROM kb_heals WHERE app_id = ? ORDER BY id", (args.app,))
        if h["change_set_id"] in set_ids or h["version_id"] in version_ids
    ]
    documents = [
        d for d in _rows(conn, "SELECT * FROM kb_source_documents WHERE app_id = ? ORDER BY id", (args.app,))
        if d["change_set_id"] in set_ids or (d["change_set_id"] is None and wanted is None)
    ]
    crawls: List[Dict[str, Any]] = []
    if args.include_crawls:
        crawls = [
            r for r in _rows(conn, "SELECT * FROM kb_crawl_runs WHERE app_id = ? ORDER BY id", (args.app,))
            if r["automation_change_set_id"] in set_ids or r["journey_change_set_id"] in set_ids
            or (wanted is None and (r["created_at"] or "") >= (args.since or ""))
        ]

    bundle = {
        "format": FORMAT,
        "app_id": args.app,
        "exported_at": datetime.now().isoformat(timespec="seconds"),
        "source_db": args.db,
        "kb_change_sets": sets,
        "kb_changes": changes,
        "kb_versions": versions,
        "kb_heals": heals,
        "kb_source_documents": documents,
        "kb_crawl_runs": crawls,
    }
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(bundle, handle, ensure_ascii=False, indent=1, default=str)
    print(f"Exported {args.app} to {args.out}:")
    for table in TABLES:
        print(f"  {table:22} {len(bundle[table])}")
    if documents:
        print("Source documents are records only: their files live in the KB folder "
              "(knowledge_base/journeys/<app>/sources/documents) and travel with the KB files.")
    return 0


# --- Import --------------------------------------------------------------------------------

class Importer:
    def __init__(self, conn: sqlite3.Connection, bundle: Dict[str, Any]):
        self.conn = conn
        self.bundle = bundle
        self.columns = {table: _columns(conn, table) for table in TABLES}
        self.ids: Dict[str, Dict[int, int]] = {table: {} for table in TABLES}
        self.added: Dict[str, int] = {table: 0 for table in TABLES}
        self.skipped: Dict[str, int] = {table: 0 for table in TABLES}
        self.notes: List[str] = []
        self.new_sets: Set[int] = set()
        self.numbers: Dict[str, List[int]] = {}

    # Rows -----------------------------------------------------------------------------
    def _insert(self, table: str, row: Dict[str, Any]) -> int:
        cols = [c for c in self.columns[table] if c != "id" and c in row]
        dropped = [c for c in row if c != "id" and c not in self.columns[table]]
        if dropped:
            self.notes.append(f"{table}: the server has no column {', '.join(dropped)}; left out")
        values = [json.dumps(row[c]) if isinstance(row[c], (dict, list)) else row[c] for c in cols]
        cursor = self.conn.execute(
            f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})", values
        )
        self.added[table] += 1
        return cursor.lastrowid

    def _existing(self, sql: str, args: tuple) -> Optional[int]:
        row = self.conn.execute(sql, args).fetchone()
        return row[0] if row else None

    def _map(self, table: str, old: Any) -> Optional[int]:
        return self.ids[table].get(old) if old is not None else None

    # Tables ---------------------------------------------------------------------------
    def change_sets(self) -> None:
        for row in self.bundle["kb_change_sets"]:
            old = row["id"]
            # Skip one the server already has: same app, KB, title and creation time.
            found = self._existing(
                "SELECT id FROM kb_change_sets WHERE app_id = ? AND kb = ? AND title = ? AND created_at = ?",
                (row["app_id"], row["kb"], row["title"], row["created_at"]),
            )
            if found:
                self.ids["kb_change_sets"][old] = found
                self.skipped["kb_change_sets"] += 1
                continue
            new = dict(row)
            new["published_version_id"] = None  # set once the versions exist
            self.ids["kb_change_sets"][old] = self._insert("kb_change_sets", new)
            self.new_sets.add(old)

    def changes(self) -> None:
        for row in self.bundle["kb_changes"]:
            parent = self._map("kb_change_sets", row["change_set_id"])
            if parent is None:
                continue
            if self._existing("SELECT id FROM kb_changes WHERE change_set_id = ? AND position = ?",
                              (parent, row["position"])):
                self.skipped["kb_changes"] += 1
                continue
            new = dict(row)
            new["change_set_id"] = parent
            self.ids["kb_changes"][row["id"]] = self._insert("kb_changes", new)

    def versions(self) -> None:
        next_number: Dict[tuple, int] = {}
        for row in sorted(self.bundle["kb_versions"], key=lambda v: (v["app_id"], v["kb"], v["number"])):
            key = (row["app_id"], row["kb"])
            found = self._existing(
                "SELECT id FROM kb_versions WHERE app_id = ? AND kb = ? AND published_at = ?",
                (row["app_id"], row["kb"], row["published_at"]),
            )
            if found:
                self.ids["kb_versions"][row["id"]] = found
                self.skipped["kb_versions"] += 1
                continue
            if key not in next_number:
                top = self._existing("SELECT MAX(number) FROM kb_versions WHERE app_id = ? AND kb = ?", key)
                next_number[key] = (top or 0) + 1
            new = dict(row)
            new["number"] = next_number[key]
            self.numbers.setdefault(row["kb"], []).append(new["number"])
            next_number[key] += 1
            new["change_set_id"] = self._map("kb_change_sets", row["change_set_id"])
            new["reverted_by_version_id"] = None  # set below, once every version has its id
            self.ids["kb_versions"][row["id"]] = self._insert("kb_versions", new)

    def link_versions(self) -> None:
        """References that point forward: change set -> its version, version -> its revert."""
        for row in self.bundle["kb_change_sets"]:
            version = self._map("kb_versions", row.get("published_version_id"))
            if version is not None:
                self.conn.execute(
                    "UPDATE kb_change_sets SET published_version_id = ? WHERE id = ? AND published_version_id IS NULL",
                    (version, self.ids["kb_change_sets"][row["id"]]),
                )
        for row in self.bundle["kb_versions"]:
            revert = self._map("kb_versions", row.get("reverted_by_version_id"))
            if revert is not None:
                self.conn.execute(
                    "UPDATE kb_versions SET reverted_by_version_id = ? WHERE id = ? AND reverted_by_version_id IS NULL",
                    (revert, self.ids["kb_versions"][row["id"]]),
                )

    def crawl_runs(self) -> None:
        for row in self.bundle["kb_crawl_runs"]:
            found = self._existing(
                "SELECT id FROM kb_crawl_runs WHERE app_id = ? AND journey_id = ? AND created_at = ?",
                (row["app_id"], row["journey_id"], row["created_at"]),
            )
            if found:
                self.ids["kb_crawl_runs"][row["id"]] = found
                self.skipped["kb_crawl_runs"] += 1
                continue
            new = dict(row)
            # The application id is the local Automation Studio row; the server's differs.
            new["application_id"] = None
            new["automation_change_set_id"] = self._map("kb_change_sets", row["automation_change_set_id"])
            new["journey_change_set_id"] = self._map("kb_change_sets", row["journey_change_set_id"])
            if new["status"] in ("queued", "running"):
                new["status"] = "failed"
                new["error"] = "Imported while still running on the source machine."
            self.ids["kb_crawl_runs"][row["id"]] = self._insert("kb_crawl_runs", new)
        if self.added["kb_crawl_runs"]:
            self.notes.append("Walks: screenshots and recordings stay on the source machine; "
                              "the imported walks show their results without them.")

    def origins(self) -> None:
        """Change sets name each other (map.pair) and their walk (recording.crawl_run_id)."""
        for row in self.bundle["kb_change_sets"]:
            if row["id"] not in self.new_sets:
                continue  # the server's own row: leave it as it is
            new_id = self.ids["kb_change_sets"][row["id"]]
            origin = _json(row.get("origin"))
            if not isinstance(origin, dict):
                origin = {}
            pair = (origin.get("map") or {}).get("pair")
            if pair is not None:
                origin["map"]["pair"] = self._map("kb_change_sets", pair)
            recording = origin.get("recording")
            if isinstance(recording, dict) and recording.get("crawl_run_id") is not None:
                recording["crawl_run_id"] = self._map("kb_crawl_runs", recording["crawl_run_id"])
            origin["transferred"] = {"from_change_set_id": row["id"], "exported_at": self.bundle.get("exported_at")}
            self.conn.execute("UPDATE kb_change_sets SET origin = ? WHERE id = ?", (json.dumps(origin), new_id))

    def heals(self) -> None:
        for row in self.bundle["kb_heals"]:
            if self._existing("SELECT id FROM kb_heals WHERE app_id = ? AND title = ? AND created_at = ?",
                              (row["app_id"], row["title"], row["created_at"])):
                self.skipped["kb_heals"] += 1
                continue
            new = dict(row)
            new["change_set_id"] = self._map("kb_change_sets", row["change_set_id"])
            new["version_id"] = self._map("kb_versions", row["version_id"])
            self.ids["kb_heals"][row["id"]] = self._insert("kb_heals", new)

    def documents(self) -> None:
        for row in self.bundle["kb_source_documents"]:
            found = self._existing("SELECT id FROM kb_source_documents WHERE app_id = ? AND sha256 = ?",
                                   (row["app_id"], row["sha256"]))
            if found:
                self.skipped["kb_source_documents"] += 1
                continue
            new = dict(row)
            new["change_set_id"] = self._map("kb_change_sets", row["change_set_id"])
            self.ids["kb_source_documents"][row["id"]] = self._insert("kb_source_documents", new)

    def run(self) -> None:
        missing = [t for t in TABLES if not self.columns[t]]
        if missing:
            raise SystemExit(f"The target database has no {', '.join(missing)} table. "
                             "Deploy the current backend and start it once (it creates them), then import.")
        self.change_sets()
        self.changes()
        self.versions()
        self.link_versions()
        self.crawl_runs()
        self.origins()
        self.heals()
        self.documents()


def import_(args: argparse.Namespace) -> int:
    with open(args.input, encoding="utf-8") as handle:
        bundle = json.load(handle)
    if bundle.get("format") != FORMAT:
        raise SystemExit(f"{args.input} is not a {FORMAT} export.")
    for table in TABLES:
        bundle.setdefault(table, [])

    conn = _connect(args.db)
    if args.apply:
        backup = f"{args.db}.bak-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
        with sqlite3.connect(backup) as copy:
            conn.backup(copy)
        print(f"Backup: {backup}")

    importer = Importer(conn, bundle)
    try:
        conn.execute("BEGIN")
        importer.run()
        if args.apply:
            conn.commit()
        else:
            conn.rollback()
    except BaseException:
        conn.rollback()
        raise

    print(f"{'Imported' if args.apply else 'Dry run -- nothing written. Would import'} "
          f"{bundle.get('app_id')} history (exported {bundle.get('exported_at')}):")
    for table in TABLES:
        if bundle[table]:
            print(f"  {table:22} add {importer.added[table]:4}   already there {importer.skipped[table]:4}")
    for kb, numbers in sorted(importer.numbers.items()):
        print(f"  {kb} KB versions become v{min(numbers)}-v{max(numbers)} on this server")
    for note in dict.fromkeys(importer.notes):
        print(f"Note: {note}")
    if not args.apply:
        print("Run again with --apply to write it (a backup copy is taken first).")
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    out = sub.add_parser("export", help="write an application's KB history to a JSON file")
    out.add_argument("--db", default="admin.db")
    out.add_argument("--app", required=True, help="application key, e.g. eand_b2b_portal")
    out.add_argument("--out", default="kb_history.json")
    out.add_argument("--since", help="only change sets created on or after this date (YYYY-MM-DD)")
    out.add_argument("--change-sets", help="only these change set ids, e.g. 35-38,40")
    out.add_argument("--include-crawls", action="store_true",
                     help="also carry the walk records (without their screenshots)")
    out.set_defaults(func=export)

    into = sub.add_parser("import", help="add an exported history to a database")
    into.add_argument("--db", required=True)
    into.add_argument("--in", dest="input", required=True)
    into.add_argument("--apply", action="store_true", help="write it (default: dry run)")
    into.set_defaults(func=import_)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
