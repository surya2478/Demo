"""
Add the Application Discovery and Grounding schema.

--- Automation Module: discovery and grounding ------------------------------

Two new tables and four columns on automation_test_cases.

`create_all` builds the two tables on a database that does not have them, but
it never alters an existing table, so the grounding columns need adding in
place. Idempotent, additive, and safe to run twice or against a fresh database.

    .venv312/Scripts/python.exe add_automation_discovery_columns.py
"""
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# --- Automation Module: target the database the application actually uses ----
# Was: os.path.join(os.path.dirname(os.path.abspath(__file__)), "admin.db").
# That is correct on a dev host and wrong in the container, where DATABASE_URL
# is sqlite:////app/external-db/admin.db while this script lives in /app -- so
# it bailed with "No database at /app/admin.db" and the schema change never
# landed. Resolving through the application's own engine keeps the two in step
# wherever this runs.
def _resolve_db_path() -> str:
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

# (table, column, DDL type, backfill value or None)
COLUMNS = [
    ("automation_test_cases", "grounding_status", "VARCHAR(30)", "not_checked"),
    ("automation_test_cases", "grounding_summary", "JSON", None),
    ("automation_test_cases", "grounded_at", "DATETIME", None),
    ("automation_test_cases", "discovery_run_id", "INTEGER", None),
]

INDEXES = [
    ("ix_automation_test_cases_grounding_status", "automation_test_cases", "grounding_status"),
    ("ix_automation_test_cases_discovery_run_id", "automation_test_cases", "discovery_run_id"),
]


def columns_of(cursor, table: str) -> set[str]:
    cursor.execute(f"PRAGMA table_info({table})")
    return {row[1] for row in cursor.fetchall()}


def table_exists(cursor, table: str) -> bool:
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,))
    return cursor.fetchone() is not None


def main() -> int:
    if not os.path.exists(DB_PATH):
        print(f"No database at {DB_PATH}. Start the app once so create_all builds it.")
        return 1

    # create_all makes the two new tables; it cannot alter the existing one.
    from app.database.connection import Base, engine  # noqa: E402
    from app.models import automation as _models  # noqa: F401,E402

    Base.metadata.create_all(bind=engine)
    print("create_all: discovery tables ensured")

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    added = skipped = backfilled = 0

    try:
        for table in ("automation_discovery_runs", "automation_discovered_elements"):
            state = "present" if table_exists(cursor, table) else "MISSING"
            print(f"  {table}: {state}")

        for table, column, ddl_type, default in COLUMNS:
            if column in columns_of(cursor, table):
                skipped += 1
                continue
            cursor.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl_type}")
            print(f"  + {table}.{column} ({ddl_type})")
            added += 1
            if default is not None:
                cursor.execute(
                    f"UPDATE {table} SET {column} = ? WHERE {column} IS NULL", (default,)
                )
                if cursor.rowcount:
                    print(f"      backfilled {cursor.rowcount} row(s) with {default!r}")
                    backfilled += cursor.rowcount

        for index_name, table, column in INDEXES:
            if column in columns_of(cursor, table):
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
