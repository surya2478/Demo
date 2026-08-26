"""
Scope Application Discovery to an application.

--- Automation Module: one identity per application --------------------------

`automation_applications` was declared but never written to, and Discovery kept
a single global `is_current` crawl beside it. Crawling a second application
retired the first one's catalogue, and every test case grounded against it
started reporting against the wrong elements without saying so.

This makes the applications table the identity: it gains `app_key` (the
Knowledge Base folder the application's profile and flows live in), plus
`description` and `is_active`. Existing discovery runs are backfilled onto a
default application built from the Knowledge Base profile, so current grounding
stays valid rather than being reset.

`create_all` builds the table on a database that does not have it, but it never
alters an existing one, so the new columns need adding in place. Idempotent,
additive, and safe to run twice or against a fresh database.

    .venv312/Scripts/python.exe add_automation_application_scope.py
"""
import os
import re
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


# Resolve through the application's own engine, so this targets the database
# the app actually uses on a dev host and in the container alike.
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
    ("automation_applications", "app_key", "VARCHAR(100)", None),
    ("automation_applications", "description", "TEXT", None),
    ("automation_applications", "is_active", "BOOLEAN", 1),
]

INDEXES = [
    ("ix_automation_applications_is_active", "automation_applications", "is_active"),
]

FALLBACK_APP_KEY = "default_app"


def columns_of(cursor, table: str) -> set[str]:
    cursor.execute(f"PRAGMA table_info({table})")
    return {row[1] for row in cursor.fetchall()}


def table_exists(cursor, table: str) -> bool:
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,))
    return cursor.fetchone() is not None


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", (value or "").strip().lower()).strip("_")
    return slug[:100] or FALLBACK_APP_KEY


def kb_default_profile() -> dict:
    """The Knowledge Base's own idea of an application, if it has one.

    Preferred over inventing a name: an application backfilled with the profile
    it already has stays linked to its flows, and its `app_key` resolves.
    """
    try:
        from app.services.automation import knowledge_base as kb

        apps = kb.list_applications()
    except Exception as exc:  # a missing KB is not a reason to fail the migration
        print(f"  Knowledge Base unreadable ({exc}); falling back to a generic profile.")
        return {}
    if not apps:
        return {}
    if len(apps) > 1:
        names = ", ".join(a.get("app_id", "?") for a in apps)
        print(
            f"  Knowledge Base holds {len(apps)} applications ({names}). "
            f"Backfilling existing crawls onto the first; register the rest in the UI."
        )
    return apps[0] or {}


def kb_app_key_for(name: str, base_url: str) -> str:
    """The Knowledge Base folder this application's row corresponds to.

    Matching on base URL and domain first matters: slugifying the display name
    produces a key that looks plausible and resolves to nothing, which is worse
    than no key at all -- the application would show as registered but
    unlinked, with no flows behind it.
    """
    try:
        from app.services.automation import knowledge_base as kb

        for candidate in (base_url, name):
            if not candidate:
                continue
            profile = kb.load_app_profile(candidate)
            if profile and profile.get("app_id"):
                return profile["app_id"]
    except Exception as exc:
        print(f"  Knowledge Base lookup failed ({exc}); deriving the key from the name.")
    return slugify(name)


def kb_key_resolves(app_key: str) -> bool:
    try:
        from app.services.automation import knowledge_base as kb

        return bool(app_key) and kb.load_app_profile(app_key) is not None
    except Exception:
        return False


def ensure_default_application(cursor) -> int:
    """Return the id of the application existing crawls should belong to.

    Reuses a row if one is already there -- this script must be safe to run
    twice -- and otherwise builds one from the Knowledge Base profile.
    """
    cursor.execute(
        "SELECT id, name, app_key, base_url FROM automation_applications ORDER BY id LIMIT 1"
    )
    row = cursor.fetchone()
    if row:
        app_id, name, app_key, base_url = row
        # Repair a key that names no Knowledge Base folder, but only when the
        # Knowledge Base can actually identify this application -- a key that
        # resolves is never touched, so a deliberate one survives a re-run.
        if not kb_key_resolves(app_key):
            derived = kb_app_key_for(name, base_url or "")
            if derived != app_key:
                cursor.execute(
                    "UPDATE automation_applications SET app_key = ? WHERE id = ?",
                    (derived, app_id),
                )
                linked = "links to the Knowledge Base" if kb_key_resolves(derived) else "unlinked"
                print(f"  application #{app_id} ({name}): app_key set to {derived!r} ({linked})")
        return app_id

    profile = kb_default_profile()
    app_key = profile.get("app_id") or FALLBACK_APP_KEY
    name = profile.get("app_name") or "Default Application"
    base_url = profile.get("base_url") or ""

    # Prefer the environment the existing crawls actually ran against, so the
    # backfilled row describes the history it is adopting.
    environment = "Production"
    if table_exists(cursor, "automation_discovery_runs"):
        cursor.execute(
            "SELECT application_environment FROM automation_discovery_runs "
            "WHERE application_environment IS NOT NULL AND application_environment != '' "
            "ORDER BY id DESC LIMIT 1"
        )
        env_row = cursor.fetchone()
        if env_row:
            environment = env_row[0]
        if not base_url:
            cursor.execute(
                "SELECT application_url FROM automation_discovery_runs "
                "WHERE application_url IS NOT NULL AND application_url != '' "
                "ORDER BY id DESC LIMIT 1"
            )
            url_row = cursor.fetchone()
            if url_row:
                base_url = url_row[0]

    cursor.execute(
        "INSERT INTO automation_applications "
        "(name, app_key, base_url, environment, description, is_active, auth_mode, created_by) "
        "VALUES (?, ?, ?, ?, ?, 1, 'none', ?)",
        (
            name,
            app_key,
            base_url,
            environment,
            "Created by add_automation_application_scope.py to adopt pre-existing "
            "discovery runs.",
            "migration",
        ),
    )
    app_id = cursor.lastrowid
    print(f"  + application #{app_id}: {name!r} (app_key={app_key!r}, base_url={base_url!r})")
    return app_id


def renumber_runs_per_application(cursor) -> int:
    """Make `version` and `is_current` mean "per application".

    They were global. After the backfill one application owns every historical
    run, so the numbering is already right -- but a database that somehow holds
    runs across several applications would otherwise carry two rows claiming to
    be current, and grounding would pick whichever sorted first.
    """
    cursor.execute(
        "SELECT DISTINCT application_id FROM automation_discovery_runs "
        "WHERE application_id IS NOT NULL"
    )
    changed = 0
    for (app_id,) in cursor.fetchall():
        cursor.execute(
            "SELECT id FROM automation_discovery_runs WHERE application_id = ? ORDER BY id",
            (app_id,),
        )
        run_ids = [r[0] for r in cursor.fetchall()]
        for index, run_id in enumerate(run_ids, start=1):
            is_current = 1 if run_id == run_ids[-1] else 0
            cursor.execute(
                "UPDATE automation_discovery_runs SET version = ?, is_current = ? "
                "WHERE id = ? AND (version != ? OR is_current != ?)",
                (index, is_current, run_id, index, is_current),
            )
            changed += cursor.rowcount
    return changed


def main() -> int:
    if not os.path.exists(DB_PATH):
        print(f"No database at {DB_PATH}. Start the app once so create_all builds it.")
        return 1

    # create_all makes the table on a database that lacks it; it cannot alter
    # one that already exists, which is what the ALTERs below are for.
    from app.database.connection import Base, engine  # noqa: E402
    from app.models import automation as _models  # noqa: F401,E402

    Base.metadata.create_all(bind=engine)
    print("create_all: automation tables ensured")

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    added = skipped = 0

    try:
        for table in ("automation_applications", "automation_discovery_runs"):
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

        # Adopt the crawls that predate scoping, rather than orphaning them --
        # a grounded test case keeps pointing at the run it was matched
        # against, and that run now names an application.
        cursor.execute(
            "SELECT COUNT(*) FROM automation_discovery_runs WHERE application_id IS NULL"
        )
        orphans = cursor.fetchone()[0]
        cursor.execute("SELECT COUNT(*) FROM automation_applications")
        have_apps = cursor.fetchone()[0]

        if orphans or have_apps:
            app_id = ensure_default_application(cursor)
            if orphans:
                cursor.execute(
                    "UPDATE automation_discovery_runs SET application_id = ? "
                    "WHERE application_id IS NULL",
                    (app_id,),
                )
                print(f"  {orphans} discovery run(s) attached to application #{app_id}")
        else:
            print("  no discovery runs and no applications: nothing to backfill")

        # Unique, because app_key is half of an application's identity. Created
        # after the backfill so the rows it covers already have a value.
        cursor.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS ix_automation_applications_app_key "
            "ON automation_applications (app_key)"
        )
        for index_name, table, column in INDEXES:
            if column in columns_of(cursor, table):
                cursor.execute(
                    f"CREATE INDEX IF NOT EXISTS {index_name} ON {table} ({column})"
                )

        renumbered = renumber_runs_per_application(cursor)
        if renumbered:
            print(f"  {renumbered} discovery run(s) renumbered per application")

        conn.commit()
        print(f"\nDone. {added} column(s) added, {skipped} already present.")
        return 0
    except sqlite3.Error as exc:
        conn.rollback()
        print(f"FAILED, rolled back: {exc}")
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
