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

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()