"""
--- Knowledge Base change sets and versions -------------------------------------

Every change to a Knowledge Base -- the Journey KB (design) or the Automation
KB (crawled) -- arrives as a change set: a draft listing its changes, each with
the value it had when the draft was made and the value it proposes. Approving
publishes it to the files and records a version; the version keeps the whole
of every file it touched, before and after, so it can be reverted exactly.

The files stay the published form the loaders read. These tables are the
history and the review queue around them.
"""
from datetime import datetime

from sqlalchemy import JSON, Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import relationship

from ..database.connection import Base


class KbChangeSet(Base):
    __tablename__ = "kb_change_sets"

    id = Column(Integer, primary_key=True, index=True)
    app_id = Column(String(100), nullable=False, index=True)
    # journey | automation -- which Knowledge Base the changes apply to.
    kb = Column(String(20), nullable=False)
    title = Column(String(300), nullable=False)
    description = Column(Text, nullable=True)
    # manual | reconcile | extraction | brd | crawl | qa | revert
    source = Column(String(30), nullable=False, default="manual")
    # change | defect -- a defect records a decision that changes no file.
    kind = Column(String(20), nullable=False, default="change")
    # draft | published | rejected | conflicted
    status = Column(String(20), nullable=False, default="draft", index=True)
    created_by = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    decided_by = Column(String(255), nullable=True)
    decided_at = Column(DateTime, nullable=True)
    decision_note = Column(Text, nullable=True)
    # Where the change came from, e.g. {"reconcile": {"screen_id", "element_id", "decision"}}.
    origin = Column(JSON, nullable=True)
    published_version_id = Column(Integer, ForeignKey("kb_versions.id"), nullable=True)

    changes = relationship(
        "KbChange", cascade="all, delete-orphan", order_by="KbChange.position", back_populates="change_set"
    )


class KbChange(Base):
    __tablename__ = "kb_changes"

    id = Column(Integer, primary_key=True, index=True)
    change_set_id = Column(Integer, ForeignKey("kb_change_sets.id"), nullable=False, index=True)
    position = Column(Integer, nullable=False, default=0)
    # File relative to the Knowledge Base folder, e.g. "screens.json".
    file = Column(String(300), nullable=False)
    # set (create or replace) | remove
    op = Column(String(10), nullable=False)
    # Address inside the file, e.g. screens[screen_id=SCR_LOGIN].elements[element_id=username].label
    path = Column(Text, nullable=False)
    # {"present": bool, "value": ...} when the draft was made; checked again at publish.
    before = Column(JSON, nullable=True)
    after = Column(JSON, nullable=True)
    note = Column(Text, nullable=True)

    change_set = relationship("KbChangeSet", back_populates="changes")


class KbVersion(Base):
    __tablename__ = "kb_versions"

    id = Column(Integer, primary_key=True, index=True)
    app_id = Column(String(100), nullable=False, index=True)
    kb = Column(String(20), nullable=False)
    # 1, 2, 3 ... per (app_id, kb).
    number = Column(Integer, nullable=False)
    change_set_id = Column(Integer, nullable=True)
    summary = Column(String(300), nullable=True)
    published_by = Column(String(255), nullable=True)
    published_at = Column(DateTime, default=datetime.utcnow)
    # {file: {"before": text|None, "after": text|None}} -- whole files, so a
    # revert restores exactly what was there.
    files = Column(JSON, nullable=False)
    reverted_by_version_id = Column(Integer, nullable=True)


class KbCrawlRun(Base):
    """One journey-guided crawl: walking a Journey KB journey in the running
    application and capturing each design element it reaches.

    The browser work is an ordinary AutomationRun (run_key); this row holds
    what the crawl was asked to do, what it found once evaluated, and the pair
    of change sets it proposed, if any.
    """

    __tablename__ = "kb_crawl_runs"

    id = Column(Integer, primary_key=True, index=True)
    app_id = Column(String(100), nullable=False, index=True)
    journey_id = Column(String(200), nullable=False)
    application_id = Column(Integer, nullable=True)
    environment = Column(String(40), nullable=True)
    profile_id = Column(String(100), nullable=True)
    base_url = Column(Text, nullable=True)
    run_key = Column(String(40), nullable=True, index=True)
    # queued | running | completed | failed
    status = Column(String(20), nullable=False, default="queued")
    plan = Column(JSON, nullable=True)
    result = Column(JSON, nullable=True)
    error = Column(Text, nullable=True)
    automation_change_set_id = Column(Integer, nullable=True)
    journey_change_set_id = Column(Integer, nullable=True)
    created_by = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    finished_at = Column(DateTime, nullable=True)


class KbSourceDocument(Base):
    """A design document or BRD uploaded to a Journey KB, and its extraction.

    The file itself is kept under the Journey KB's sources/documents/ folder, as
    evidence next to the knowledge drawn from it. `extraction` holds what the
    model proposed, item by item, until a reviewer turns the items they accept
    into a Journey KB change set (`change_set_id`).
    """
    __tablename__ = "kb_source_documents"

    id = Column(Integer, primary_key=True, index=True)
    app_id = Column(String(100), nullable=False, index=True)
    filename = Column(String(255), nullable=False)
    # Relative to the Journey KB folder, e.g. sources/documents/3f2a9c1e_sign-in.pdf
    stored_as = Column(String(400), nullable=False)
    sha256 = Column(String(64), nullable=False, index=True)
    size_bytes = Column(Integer, nullable=False, default=0)
    pages = Column(Integer, nullable=True)
    # screen_flow | brd
    doc_kind = Column(String(20), nullable=False, default="screen_flow")
    # uploaded | extracting | extracted | failed | drafted
    status = Column(String(20), nullable=False, default="uploaded")
    error = Column(Text, nullable=True)
    extraction = Column(JSON, nullable=True)
    change_set_id = Column(Integer, nullable=True)
    created_by = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    extracted_at = Column(DateTime, nullable=True)


class KbHeal(Base):
    """What a published Journey KB change touched, and what was done about it.

    Recorded when a Journey KB change set is approved (or a version reverted):
    the impact (journeys, elements, rules, test cases, selectors), the KB diff
    of every affected test case refreshed before -> after, and the follow-ups a
    person started from it -- AI Checks re-run on the affected cases and
    journey-guided crawls that confirm the change in the application.
    """
    __tablename__ = "kb_heals"

    id = Column(Integer, primary_key=True, index=True)
    app_id = Column(String(100), nullable=False, index=True)
    change_set_id = Column(Integer, nullable=True, index=True)
    version_id = Column(Integer, nullable=True, index=True)
    title = Column(String(300), nullable=False)
    source = Column(String(30), nullable=True)
    impact = Column(JSON, nullable=True)
    # [{case_id, display_id, journey_id, before: {STATUS: n}, after: {STATUS: n}, changed: bool}]
    rediff = Column(JSON, nullable=True)
    # {requested_by, requested_at, case_ids, queued, skipped: [{case_id, reason}]}
    recheck = Column(JSON, nullable=True)
    # [{journey_id, crawl_id, started_by, started_at}]
    crawls = Column(JSON, nullable=True)
    created_by = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class KbCapture(Base):
    """A browser capture sent straight from the capture tool, waiting to be reviewed.

    The tool hands its pages to the app's receiving page (window.postMessage),
    which stores them here. On the Crawl stage the reviewer sees them as a
    flow -- pages in order, each page's objects and which journey step each
    answers -- edits it (`edits`: page order, dropped pages or objects, a
    page's screen, the object a step uses) and imports it as a walk
    (`crawl_run_id`), which then goes through the usual review, change sets,
    approval and publishing. services/journeys/journey_capture.py.
    """

    __tablename__ = "kb_captures"

    id = Column(Integer, primary_key=True, index=True)
    # Unknown until the reviewer chooses it, when the host matched no application.
    app_id = Column(String(100), nullable=True, index=True)
    environment = Column(String(40), nullable=True)
    journey_id = Column(String(200), nullable=True)
    name = Column(String(200), nullable=True)
    host = Column(String(255), nullable=True)
    # Where the tool ran (the page that sent it), as the browser reported it.
    origin = Column(String(255), nullable=True)
    # inbox | imported | discarded
    status = Column(String(20), nullable=False, default="inbox", index=True)
    manifest = Column(JSON, nullable=True)
    pages = Column(JSON, nullable=False)
    edits = Column(JSON, nullable=True)
    crawl_run_id = Column(Integer, nullable=True)
    created_by = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
