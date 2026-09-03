"""
Add the columns the detailed rule classifier writes.

--- Automation Module: schema for the classification report -------------------

`Classify by rule` now runs four checks over a case -- every step, the channel
it runs on, what the Knowledge Base knows about its controls, and whether its
test data exists -- and the badge can carry only one sentence of that. The rest
is stored as a report so the grid can show which step, which channel and which
missing locator produced the verdict.

`create_all` creates missing TABLES but never alters existing ones, so a
deployment whose automation_test_cases table already exists would keep the old
shape and every classify would fail on an unknown attribute.

Idempotent: each column is checked with PRAGMA table_info first, so running it
twice is a no-op, and running it against a fresh database create_all has
already built with the new shape does nothing either. Additive only -- no
column is dropped, renamed or retyped, and no row is rewritten.

Existing rows keep their classification and their reason. Their report is NULL
until the next classify, which is the honest state: nothing computed the
report for them, and inventing one from the old two-way verdict would put
findings on screen that no rule produced.

    .venv312/Scripts/python.exe add_automation_classification_report.py
"""
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _resolve_db_path() -> str:
    """The database the application itself uses, not the one beside this file.

    Same reasoning as add_automation_workbench_columns.py: DATABASE_URL in the
    container points at /app/external-db/admin.db while this script lives in
    /app, so a path derived from __file__ silently migrates nothing.
    """
    from app.database.connection import sqlite_file_path

    path = sqlite_file_path()
    if path is None:
        print(
            "DATABASE_URL does not point at a SQLite file. This script writes "
            "SQLite-specific DDL; migrate that database with a real migration "
            "tool instead."
        )
        raise SystemExit(2)
    return path


DB_PATH = _resolve_db_path()

# (table, column, DDL type)
COLUMNS = [
    ("automation_test_cases", "classification_report", "JSON"),
    ("automation_test_cases", "classified_at", "DATETIME"),
]


def table_exists(cursor, table: str) -> bool:
    cursor.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)
    )
    return cursor.fetchone() is not None


def columns_of(cursor, table: str) -> set:
    cursor.execute(f"PRAGMA table_info({table})")
    return {row[1] for row in cursor.fetchall()}


def main() -> int:
    if not os.path.exists(DB_PATH):
        print(f"No database at {DB_PATH}. Start the app once so create_all builds it.")
        return 1

    print(f"Connecting to {DB_PATH}")
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    added = skipped = 0

    try:
        for table, column, ddl_type in COLUMNS:
            if not table_exists(cursor, table):
                print(f"  - {table} does not exist yet; create_all will build it. Skipping.")
                continue
            if column in columns_of(cursor, table):
                skipped += 1
                continue
            cursor.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl_type}")
            print(f"  + {table}.{column} ({ddl_type})")
            added += 1

        conn.commit()
    finally:
        conn.close()

    print(f"\nDone. {added} column(s) added, {skipped} already present.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
