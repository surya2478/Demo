from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
import os
from ..config import settings

# Use environment DATABASE_URL if present, else settings.DATABASE_URL, else sqlite file
SQLALCHEMY_DATABASE_URL = os.getenv("DATABASE_URL") or getattr(settings, "DATABASE_URL", None) or "sqlite:///./admin.db"

# SQLite requires check_same_thread=False
if SQLALCHEMY_DATABASE_URL.startswith("sqlite"):
    engine = create_engine(SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False})
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