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
    # --- Automation Module: pool sized for slow requests -------------------
    #
    # The defaults were pool_size=5, max_overflow=10, pool_timeout=30 -- and
    # those numbers wedged the whole application once, so they are worth
    # spelling out rather than inheriting.
    #
    # This app has two populations of request. Most answer in milliseconds and
    # hand their connection straight back. A few hold one for the length of a
    # language model call or a browser run: a single test case quality review
    # is ~25 seconds, and `get_db` keeps its session for the whole request, so
    # that connection is checked out and idle the entire time. Fifteen of those
    # in flight exhausted the pool, and every other request in the app -- a
    # login, a list, a session poll -- then queued on pool_timeout and appeared
    # to hang for exactly 30 seconds before anything came back. The endpoint
    # people blamed was whichever one they happened to be looking at.
    #
    #   pool_size / max_overflow  50 in total. A SQLite connection is a file
    #                             handle, not a server session, so they are
    #                             cheap, and WAL (set below) lets readers run
    #                             concurrently with a writer. The ceiling is
    #                             here to catch a leak, not to ration.
    #   pool_timeout              10s, down from 30. If the pool is genuinely
    #                             exhausted the caller should be told promptly
    #                             and in words -- "QueuePool limit reached" is
    #                             a diagnosis, whereas a 30s stall is a
    #                             mystery. It is also now well inside the
    #                             frontend's own 30s request timeout, so the
    #                             browser reports the server's reason rather
    #                             than giving up first and reporting nothing.
    #   pool_pre_ping             a connection can die under a process while
    #                             it sits in the pool; pre_ping spends a
    #                             SELECT 1 to find out before a query does.
    #   pool_recycle              30 minutes, so nothing sits open forever.
    #
    # None of this makes a 25s review cheap. The real fix for that is to stop
    # holding a session across the model call, which is a change to the review
    # path rather than to the pool; this keeps one slow endpoint from taking
    # the rest of the application down with it.
    engine = create_engine(
        SQLALCHEMY_DATABASE_URL,
        connect_args={"check_same_thread": False, "timeout": 30},
        pool_size=20,
        max_overflow=30,
        pool_timeout=10,
        pool_pre_ping=True,
        pool_recycle=1800,
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
    # Same reasoning as the SQLite branch above, minus connect_args. A real
    # database server does charge for connections, so the ceiling is lower.
    engine = create_engine(
        SQLALCHEMY_DATABASE_URL,
        pool_size=10,
        max_overflow=20,
        pool_timeout=10,
        pool_pre_ping=True,
        pool_recycle=1800,
    )

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