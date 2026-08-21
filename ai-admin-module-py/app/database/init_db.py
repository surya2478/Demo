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

    try:
        print(f'[Database Init] Creating tables with engine: {engine}')
        print(f'[Database Init] Registered models: {Base.metadata.tables.keys()}')
        Base.metadata.create_all(bind=engine)
        print(f'[Database Init] Tables created successfully')
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