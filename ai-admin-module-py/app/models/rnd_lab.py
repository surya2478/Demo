"""
--- AI R&D Lab: models ---------------------------------------------------------

The Lab's own tables, all prefixed rnd_. The same rules as the Automation
models hold, more strictly:

1. No foreign key into any other module's table. project_id and test_case_id
   are references by value, so create_all() adds these tables without touching
   anything that exists, and deleting a study never cascades anywhere else.
2. Nothing here is ever written back to another module. A study reads approved
   cases, BRDs, the Knowledge Base and scripts; what it produces stays here.
3. Document bodies live on disk under the automation storage root, referenced
   by relative path. Only the analysis results, which are small, are JSON.
"""
from datetime import datetime

from sqlalchemy import Column, DateTime, Integer, JSON, String, Text, UniqueConstraint

from ..database.connection import Base


class RndStudy(Base):
    """One project's evidence study: a set of cases and the sources mapped against them."""

    __tablename__ = "rnd_studies"

    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, nullable=False, index=True)
    # Snapshot of the project at creation, so a list still reads after a rename.
    ppm_id = Column(String(100), nullable=True)
    project_name = Column(String(255), nullable=True)
    name = Column(String(255), nullable=False)
    # Journey KB application folder; None runs without KB evidence.
    kb_app_id = Column(String(120), nullable=True)
    # Explicit selection; None means every approved automation case of the project.
    case_ids = Column(JSON, nullable=True)
    # Not every project has designs. Off removes the Design column entirely
    # rather than reporting every step "missing" against nothing.
    has_design = Column(Integer, nullable=False, default=0)
    status = Column(String(30), nullable=False, default="draft", index=True)  # draft|analysing|ready|failed|interrupted
    progress = Column(JSON, nullable=True)
    summary = Column(JSON, nullable=True)
    requirements = Column(JSON, nullable=True)
    error = Column(Text, nullable=True)
    created_by = Column(String(255), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
    analysed_at = Column(DateTime, nullable=True)


class RndDocument(Base):
    """A source in a study: a BRD linked from the case's request, or an upload."""

    __tablename__ = "rnd_documents"

    id = Column(Integer, primary_key=True, index=True)
    study_id = Column(Integer, nullable=False, index=True)
    role = Column(String(30), nullable=False, default="brd")  # brd|figma|srd|api_spec|other
    origin = Column(String(20), nullable=False, default="upload")  # upload|linked
    origin_request_id = Column(String(255), nullable=True, index=True)
    filename = Column(String(255), nullable=False)
    file_type = Column(String(20), nullable=True)
    size_bytes = Column(Integer, nullable=True)
    stored_path = Column(String(500), nullable=True)
    text_path = Column(String(500), nullable=True)
    page_count = Column(Integer, nullable=True)
    text_chars = Column(Integer, nullable=True)
    status = Column(String(20), nullable=False, default="stored")  # stored|extracting|ready|failed
    notes = Column(JSON, nullable=True)
    error = Column(Text, nullable=True)
    created_by = Column(String(255), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class RndCaseMap(Base):
    """One case's evidence matrix within a study."""

    __tablename__ = "rnd_case_maps"
    __table_args__ = (UniqueConstraint("study_id", "test_case_id", name="uq_rnd_case_map"),)

    id = Column(Integer, primary_key=True, index=True)
    study_id = Column(Integer, nullable=False, index=True)
    test_case_id = Column(Integer, nullable=False, index=True)
    display_id = Column(String(100), nullable=True)
    title = Column(Text, nullable=True)
    readiness = Column(Integer, nullable=True)
    verdict = Column(String(30), nullable=True, index=True)  # ready|needs_work|blocked|needs_decision
    method = Column(String(20), nullable=True)  # rules|rules+ai
    matrix = Column(JSON, nullable=True)
    gaps = Column(JSON, nullable=True)
    script = Column(JSON, nullable=True)
    error = Column(Text, nullable=True)
    analysed_at = Column(DateTime, nullable=True)
