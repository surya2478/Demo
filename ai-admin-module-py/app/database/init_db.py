from pathlib import Path
import os
from typing import Optional
import traceback
from sqlalchemy import inspect

# import engine and Base from connection (must exist)
from .connection import engine, Base

def _ensure_sqlite_dir(database_url: Optional[str]) -> None:
    """Ensure parent directory exists for sqlite DB URLs like sqlite:///./data/db.db"""
    if not database_url:
        return
    db_url = database_url.strip()
    if db_url.startswith("sqlite:///"):
        # remove prefix and any query params
        path = db_url.split("?", 1)[0].replace("sqlite:///", "", 1)
        if path:
            db_path = Path(path)
            parent = db_path.parent
            if parent and not parent.exists():
                parent.mkdir(parents=True, exist_ok=True)

# Columns added after their table first shipped. create_all() never alters an
# existing table, so without this a database created earlier would keep the
# old shape and every query naming a new column would fail. Additive only:
# nullable columns, nothing dropped or retyped, each checked before it is
# added -- running this on every start is a no-op once they exist.
_ADDED_COLUMNS = (
    ("test_case_review_details", "project_id", "INTEGER"),
    ("test_case_review_details", "ai_batch_id", "VARCHAR(32)"),
    ("test_case_review_details", "generation", "JSON"),
    ("automation_test_cases", "project_id", "INTEGER"),
    ("automation_test_cases", "journey_diff", "JSON"),
    ("automation_data_apps", "run_environment", "VARCHAR(40)"),
    ("automation_test_cases", "environment", "VARCHAR(40)"),
)


def _ensure_columns(engine) -> None:
    from sqlalchemy import text

    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    with engine.begin() as connection:
        for table, column, ddl in _ADDED_COLUMNS:
            if table not in tables:
                continue  # create_all builds it with the column
            present = {item["name"] for item in inspector.get_columns(table)}
            if column in present:
                continue
            connection.execute(text(f'ALTER TABLE {table} ADD COLUMN {column} {ddl}'))
            if column.endswith("_id"):
                connection.execute(text(f'CREATE INDEX IF NOT EXISTS ix_{table}_{column} ON {table} ({column})'))
            print(f'[Database Init] Added column {table}.{column}')


def init_db() -> None:
    """
    Initialize the database: ensure sqlite dirs, import models so they register with Base,
    and create tables.

    NOTE: import engine/Base inside the function to avoid import-time circular imports
    and to ensure sqlite directory exists before SQLAlchemy creates the file.
    """
    # prefer env DATABASE_URL if present
    database_url = os.getenv("DATABASE_URL") or None

    # fallback to settings if available (do not import settings at module import time)
    if not database_url:
        try:
            from ..config import settings  # local import to avoid circular import at module load
            database_url = getattr(settings, "DATABASE_URL", None)
        except Exception:
            database_url = None

    _ensure_sqlite_dir(database_url)

    # import engine and Base after ensuring directories exist
    try:
        from .connection import engine, Base
    except Exception:
        # surface useful error if connection module fails to import
        traceback.print_exc()
        raise

    # Import models so they are registered on Base.metadata
    try:
        import app.models.database  # noqa: F401
        import app.models.request_log  # noqa: F401
    except Exception:
        try:
            from . import models  # noqa: F401
        except Exception:
            # not fatal here, continue and let create_all surface any issues
            pass

    try:
        import app.models.database as app_database_mod  # noqa: F401
        _ = app_database_mod.TestCaseReview
    except Exception:
        pass

    # --- Automation Module: register automation models --------------------
    # Deliberately in its own try/except rather than added to the block
    # above: that block falls back to a different import path on ANY
    # failure, so a missing or broken automation model module would stop
    # the existing models registering too. Isolated here, the worst case
    # is that automation tables are absent -- existing tables are never
    # affected.
    #
    # ImportError only until app/models/automation.py lands in Phase 0;
    # create_all() then picks the new tables up automatically. No Alembic
    # migration is needed and no existing table is touched.
    try:
        import app.models.automation  # noqa: F401
    except ImportError:
        pass
    # Knowledge Base change sets and versions: new tables, created here.
    try:
        import app.models.kb_changes  # noqa: F401
    except ImportError:
        pass

    try:
        _ensure_columns(engine)
    except Exception:
        # Reported, not raised: the app still starts, and the columns can be
        # added by hand. Every query naming them fails until they exist.
        print('[Database Init] ERROR adding columns:')
        traceback.print_exc()

    try:
        print(f'[Database Init] Creating tables with engine: {engine}')
        print(f'[Database Init] Registered models: {Base.metadata.tables.keys()}')
        Base.metadata.create_all(bind=engine)
        print(f'[Database Init] Tables created successfully')
        # Applications registered in Discovery or on the Knowledge Base page
        # are folded into Test Data, the one registry. Idempotent; never fatal.
        try:
            from ..services.automation.registry import run_on_startup

            run_on_startup()
        except Exception:
            traceback.print_exc()
        print(f'[Database Init] Final tables in metadata: {list(Base.metadata.tables.keys())}')
    except Exception as exc:
        # print full traceback for easier debugging and re-raise
        print('[Database Init] ERROR creating tables:')
        traceback.print_exc()
        raise

"""
Create audit_logs table in the configured SQLite DB using existing SQLAlchemy models.
Run: python -m app.database.init_db
"""
from ..models.database import AuditLog  # existing ORM model

def create_audit_table():
    inspector = inspect(engine)
    if not inspector.has_table(AuditLog.__tablename__):
        AuditLog.__table__.create(bind=engine, checkfirst=True)
        print(f"Created table: {AuditLog.__tablename__}")
    else:
        print(f"Table already exists: {AuditLog.__tablename__}")

if __name__ == "__main__":
    create_audit_table()