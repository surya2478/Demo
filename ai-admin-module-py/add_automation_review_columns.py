"""
Add the Guided Flow Discovery and Quality Review columns.

--- Automation Module: the seven columns no script ever added -----------------

Every other automation column has a migration behind it. These seven never did.
They entered app/models/automation.py with the eSMART Review Agent and the
guided flow recorder, on a branch where the automation tables were young enough
that every deployment still got them from create_all() building the table for
the first time. Nothing added them to a database whose table already existed.

That gap is invisible until a workbench request arrives. `_workbench_case()`
reads all seven, and SQLAlchemy names every mapped column in its SELECT, so a
database missing even one fails the whole query -- including GET
/automation/workbench/sources, which reads no review data itself but loads the
entity to find which sources were already refined. Both endpoints return 500
and the Workbench renders empty.

`create_all` creates missing TABLES but never alters existing ones. See the note
in app/database/connection.py: the running application and these scripts agree
on the file only because both resolve it from DATABASE_URL.

Idempotent: each column is checked with PRAGMA table_info first, so running it
twice is a no-op, and running it against a fresh database create_all already
built with the new shape does nothing either. Additive only -- no column is
dropped, renamed or retyped.

Existing rows get NULL for every review field, which is the honest state: no
review agent ever scored them, and a fabricated score would put a verdict on
screen that no review produced. flow_discovery_status is the one exception --
the model declares it NOT NULL, so existing rows are backfilled with "none",
which is exactly what they are: no flow recorded.

    .venv312/Scripts/python.exe add_automation_review_columns.py

In the container, where DATABASE_URL points at the bind-mounted database:

    docker exec <container> python add_automation_review_columns.py
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

# (table, column, DDL type, default for existing rows)
COLUMNS = [
    # --- Guided Flow Discovery ----------------------------------------------
    # NOT NULL in the model, so existing rows need the default written in.
    ("automation_test_cases", "flow_discovery_status", "VARCHAR(30)", "none"),
    ("automation_test_cases", "recorded_flow_objects", "JSON", None),
    # --- Quality Review (eSMART Review Agent) -------------------------------
    ("automation_test_cases", "review_score", "FLOAT", None),
    ("automation_test_cases", "review_verdict", "VARCHAR(30)", None),
    ("automation_test_cases", "review_scores", "JSON", None),
    ("automation_test_cases", "review_findings", "JSON", None),
    ("automation_test_cases", "reviewed_at", "DATETIME", None),
]

# index=True on the model. ALTER TABLE ADD COLUMN creates no index, and
# create_all will not add one to a table that already exists.
INDEXES = [
    (
        "ix_automation_test_cases_flow_discovery_status",
        "automation_test_cases",
        "flow_discovery_status",
    ),
    (
        "ix_automation_test_cases_review_verdict",
        "automation_test_cases",
        "review_verdict",
    ),
]


def table_exists(cursor, table: str) -> bool:
    cursor.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)
    )
    return cursor.fetchone() is not None


def columns_of(cursor, table: str) -> set[str]:
    cursor.execute(f"PRAGMA table_info({table})")
    return {row[1] for row in cursor.fetchall()}


def main() -> int:
    if not os.path.exists(DB_PATH):
        print(f"No database at {DB_PATH}. Start the app once so create_all builds it.")
        return 1

    print(f"Connecting to {DB_PATH}")
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    added = skipped = backfilled = 0

    try:
        if not table_exists(cursor, "automation_test_cases"):
            print(
                "! automation_test_cases does not exist yet -- create_all will "
                "build it with the new shape. Nothing to migrate."
            )
            return 0

        for table, column, ddl_type, default in COLUMNS:
            if column in columns_of(cursor, table):
                skipped += 1
                continue

            cursor.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl_type}")
            print(f"  + {table}.{column} ({ddl_type})")
            added += 1

            # SQLite refuses a non-constant default on ADD COLUMN, and an
            # existing row would otherwise read NULL where the model promises a
            # value. Fill it explicitly.
            if default is not None:
                cursor.execute(
                    f"UPDATE {table} SET {column} = ? WHERE {column} IS NULL", (default,)
                )
                if cursor.rowcount:
                    print(f"      backfilled {cursor.rowcount} row(s) with {default!r}")
                    backfilled += cursor.rowcount

        for index_name, table, column in INDEXES:
            if column not in columns_of(cursor, table):
                continue
            cursor.execute(
                f"CREATE INDEX IF NOT EXISTS {index_name} ON {table} ({column})"
            )

        conn.commit()
        print(
            f"\nDone. {added} column(s) added, {skipped} already present, "
            f"{backfilled} value(s) backfilled."
        )
        return 0
    except sqlite3.Error as exc:
        conn.rollback()
        print(f"FAILED, rolled back: {exc}")
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
