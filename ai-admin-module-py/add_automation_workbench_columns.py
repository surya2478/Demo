"""
Add the Automation TC Coverage Assessment and Script Lab columns.

--- Automation Module: schema for the workbench and script lab ---------------

`create_all` creates missing TABLES but never alters existing ones, so a
deployment whose automation_* tables already exist would silently keep the old
shape and every new column would read as missing. This adds them in place.

Idempotent: each column is checked with PRAGMA table_info first, so running it
twice is a no-op and running it against a fresh database that create_all has
already built with the new shape does nothing either.

Additive only. No column is dropped, renamed or retyped, and no row is
rewritten beyond backfilling the defaults SQLite cannot apply retroactively --
ALTER TABLE ADD COLUMN with a non-constant default is rejected, so those land
as NULL and are filled by an UPDATE below.

    .venv312/Scripts/python.exe add_automation_workbench_columns.py
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
    # --- automation_test_cases: the workbench -------------------------------
    ("automation_test_cases", "objective", "TEXT", None),
    ("automation_test_cases", "bdd_scenario", "TEXT", None),
    ("automation_test_cases", "priority", "VARCHAR(20)", "Medium"),
    ("automation_test_cases", "test_type", "VARCHAR(50)", None),
    ("automation_test_cases", "origin", "VARCHAR(20)", "imported"),
    ("automation_test_cases", "classification", "VARCHAR(20)", "undecided"),
    ("automation_test_cases", "classification_source", "VARCHAR(30)", None),
    ("automation_test_cases", "classification_reason", "TEXT", None),
    ("automation_test_cases", "manual_only_reasons", "JSON", None),
    ("automation_test_cases", "test_data_required", "BOOLEAN", 0),
    ("automation_test_cases", "test_data_status", "VARCHAR(20)", "not_required"),
    ("automation_test_cases", "test_data_notes", "TEXT", None),
    ("automation_test_cases", "approval_status", "VARCHAR(20)", "draft"),
    ("automation_test_cases", "decision_reason", "TEXT", None),
    ("automation_test_cases", "approved_by", "VARCHAR(255)", None),
    ("automation_test_cases", "approved_at", "DATETIME", None),
    ("automation_test_cases", "version", "INTEGER", 1),
    ("automation_test_cases", "application_url", "TEXT", None),
    # --- automation_scripts: the script lab ---------------------------------
    ("automation_scripts", "script_key", "VARCHAR(255)", None),
    ("automation_scripts", "execution_command", "TEXT", None),
    ("automation_scripts", "setup_notes", "JSON", None),
    ("automation_scripts", "entry_path", "VARCHAR(500)", None),
    ("automation_scripts", "static_gate_result", "JSON", None),
    ("automation_scripts", "dry_run_status", "VARCHAR(20)", "not_run"),
    ("automation_scripts", "dry_run_summary", "JSON", None),
    ("automation_scripts", "dry_run_at", "DATETIME", None),
    ("automation_scripts", "dry_run_key", "VARCHAR(64)", None),
    ("automation_scripts", "is_current", "BOOLEAN", 1),
    ("automation_scripts", "edited_by_user", "BOOLEAN", 0),
    ("automation_scripts", "generation_error", "TEXT", None),
]

INDEXES = [
    ("ix_automation_test_cases_origin", "automation_test_cases", "origin"),
    ("ix_automation_test_cases_classification", "automation_test_cases", "classification"),
    ("ix_automation_test_cases_test_data_status", "automation_test_cases", "test_data_status"),
    ("ix_automation_test_cases_approval_status", "automation_test_cases", "approval_status"),
    ("ix_automation_scripts_script_key", "automation_scripts", "script_key"),
    ("ix_automation_scripts_dry_run_status", "automation_scripts", "dry_run_status"),
    ("ix_automation_scripts_dry_run_key", "automation_scripts", "dry_run_key"),
    ("ix_automation_scripts_is_current", "automation_scripts", "is_current"),
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
        for table in ("automation_test_cases", "automation_scripts"):
            if not table_exists(cursor, table):
                print(f"! {table} does not exist yet -- create_all will build it "
                      "with the new shape. Nothing to migrate.")
                return 0

        for table, column, ddl_type, default in COLUMNS:
            existing = columns_of(cursor, table)
            if column in existing:
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
