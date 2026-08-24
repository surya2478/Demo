from sqlalchemy import create_engine, event
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
import os
from ..config import settings

# Use environment DATABASE_URL if present, else settings.DATABASE_URL, else sqlite file
SQLALCHEMY_DATABASE_URL = os.getenv("DATABASE_URL") or getattr(settings, "DATABASE_URL", None) or "sqlite:///./admin.db"

# SQLite requires check_same_thread=False
if SQLALCHEMY_DATABASE_URL.startswith("sqlite"):
    # --- Automation Module: added timeout ---------------------------------
    # timeout is how long the driver waits for a held write lock before
    # raising "database is locked". The default is 5s, which the session
    # purge loop plus an automation run writing status can exceed.
    engine = create_engine(
        SQLALCHEMY_DATABASE_URL,
        connect_args={"check_same_thread": False, "timeout": 30},
    )

    # --- Automation Module: SQLite WAL journal mode -----------------------
    # In SQLite's default rollback-journal mode a single writer blocks every
    # reader for the duration of its transaction. This app already writes
    # from a background loop every 60s (see main.py session purge); once the
    # Automation Module also writes run-status transitions while the UI polls
    # for them, readers start failing with "database is locked".
    #
    # WAL lets readers proceed concurrently with a writer, which removes that
    # failure mode. busy_timeout gives a contended writer 30s to acquire the
    # lock instead of failing immediately, and synchronous=NORMAL is the
    # standard, safe pairing with WAL.
    #
    # Behaviour-preserving: no existing query changes. WAL is a property of
    # the database file, so it persists once set and creates admin.db-wal and
    # admin.db-shm alongside it -- any backup that copies only admin.db needs
    # to account for those two sidecar files.
    @event.listens_for(engine, "connect")
    def _set_sqlite_pragmas(dbapi_connection, _connection_record):
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA busy_timeout=30000")
            cursor.execute("PRAGMA synchronous=NORMAL")
        finally:
            cursor.close()
else:
    engine = create_engine(SQLALCHEMY_DATABASE_URL)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


# --- Automation Module: one answer to "which database file?" -----------------
# The add_*.py migration scripts each derived their own path with
# os.path.join(os.path.dirname(__file__), "admin.db"). That is the right file
# on a dev host, where the scripts sit beside admin.db, and the wrong one in
# the container: DATABASE_URL there is sqlite:////app/external-db/admin.db,
# but __file__ resolves to /app, so every script bailed with "No database at
# /app/admin.db" and the columns never landed. create_all does not cover it --
# it adds missing tables, never missing columns on an existing one.
#
# Asking SQLAlchemy to parse the URL keeps the scripts and the running
# application pointed at the same file by construction, wherever they run.
def sqlite_file_path() -> "os.PathLike | str | None":
    """Filesystem path of the SQLite file behind DATABASE_URL, or None.

    Returns None when the configured database is not SQLite, which the
    migration scripts treat as "this needs a real migration tool, not
    hand-written ALTER TABLE".
    """
    if not SQLALCHEMY_DATABASE_URL.startswith("sqlite"):
        return None
    database = engine.url.database
    if not database or database == ":memory:":
        return None
    # Relative URLs (sqlite:///./admin.db) resolve against the working
    # directory, which is how SQLAlchemy itself opened the file above.
    return os.path.abspath(database)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()