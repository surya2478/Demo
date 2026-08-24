"""
Add the Document Intake schema.

--- Automation Module: document intake --------------------------------------

Two new tables, no changes to any existing one.

`create_all` already builds these on a database that does not have them, so on
a fresh install this script is a no-op that confirms the result. It exists for
the databases that are already running: create_all is invoked at startup and
will add missing tables, but it never reports what it did, and an operator
deploying this wants to see that the intake tables landed rather than infer it
from the absence of an error.

Idempotent, additive, and safe to run twice or against a fresh database.

    .venv312/Scripts/python.exe add_automation_intake_tables.py
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

TABLES = ("automation_intake_batches", "automation_intake_documents")


def main() -> int:
    if not os.path.exists(DB_PATH):
        print(f"No database at {DB_PATH}. Start the backend once to create it.")
        return 1

    # Build through the models rather than hand-written DDL, so the schema has
    # exactly one definition. Hand-copied CREATE TABLE statements are how a
    # migration and a model quietly disagree about a column's nullability.
    from app.database.connection import Base, engine
    from app.models.automation import (  # noqa: F401 - registers the tables
        AutomationIntakeBatch,
        AutomationIntakeDocument,
    )

    before = _existing()
    Base.metadata.create_all(
        bind=engine,
        tables=[Base.metadata.tables[name] for name in TABLES],
    )
    after = _existing()

    for name in TABLES:
        if name in before:
            print(f"  = {name} already present")
        elif name in after:
            print(f"  + {name} created")
        else:
            print(f"  ! {name} MISSING after create_all")
            return 1

    print("\nDocument intake schema is in place.")
    return 0


def _existing() -> set[str]:
    conn = sqlite3.connect(DB_PATH)
    try:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'automation_intake%'"
        ).fetchall()
        return {row[0] for row in rows}
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
