from sqlalchemy import Column, Integer, String, DateTime, Boolean, JSON, ForeignKey, CheckConstraint, UniqueConstraint
from sqlalchemy.orm import relationship
from ..database.connection import Base
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, DateTime, Text, JSON, Index, Boolean
from sqlalchemy.sql import func
from datetime import datetime
from zoneinfo import ZoneInfo
DUBAI_TZ = ZoneInfo("Asia/Dubai")   

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True)
    email = Column(String, unique=True)
    password = Column(String)
    role = Column(String)
    roles = Column(JSON)
    category = Column(String, nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime)
    modified_at = Column(DateTime)
    must_change_password = Column(Boolean, default=True)
    token_allocation = Column(Integer, default=10000)
    auth_source = Column(String, default="local", nullable=False)  # 'local' or 'ldap'
    allowed_time_start = Column(String, nullable=True)  # Format: "HH:MM" e.g., "08:00"
    allowed_time_end = Column(String, nullable=True)    # Format: "HH:MM" e.g., "17:00"
    sessions = relationship("Session", back_populates="user")

class Session(Base):
    __tablename__ = "sessions"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String, unique=True, index=True)
    username = Column(String, ForeignKey("users.username"))
    ip_address = Column(String, nullable=True)
    user_agent = Column(String, nullable=True)
    created_at = Column(DateTime)
    last_seen_at = Column(DateTime)
    expires_at = Column(DateTime, nullable=True)
    data = Column(JSON)
    is_active = Column(Boolean, default=True)
    status = Column(String)

    user = relationship("User", back_populates="sessions")

class AuditLog(Base):
    """Comprehensive audit trail for all user and admin activities"""
    __tablename__ = "audit_logs"
    
    id = Column(Integer, primary_key=True, index=True)
    
    # Actor information
    actor_id = Column(String(128), index=True, nullable=True)
    actor_username = Column(String(256), index=True, nullable=False)
    actor_role = Column(String(64), index=True, nullable=False)  # "user" | "admin"
    
    # Action classification
    module = Column(String(128), index=True, nullable=False)        # "Dashboard", "Users", "Sessions", "Settings", "Test Assistant"
    submodule = Column(String(128), index=True, nullable=True)      # "Test Cases", "Visual", "Test Data", "Changes", "Unit", "KB"
    action = Column(String(128), index=True, nullable=False)        # "navigate", "create", "update", "delete", "execute", "extend"
    
    # Resource information
    resource_type = Column(String(128), nullable=True)              # "session", "user", "test_case", "test_data", "setting"
    resource_id = Column(String(256), nullable=True, index=True)
    resource_name = Column(String(512), nullable=True)
    
    # Execution details
    status = Column(String(32), default="success")                  # "success", "failure", "warning"
    details = Column(JSON, nullable=True)                           # contextual data: {before, after, reason, error, ...}
    
    # Request context
    ip_address = Column(String(64), nullable=True)
    user_agent = Column(Text, nullable=True)
    
    # Timestamps (all Dubai timezone)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)
    
    __table_args__ = (
        Index("ix_audit_actor_role_created", "actor_role", "created_at"),
        Index("ix_audit_module_action_created", "module", "action", "created_at"),
    )


class TestCaseReview(Base):
    """Approval workflow state for generated test cases."""
    __tablename__ = "test_case_reviews"

    id = Column(Integer, primary_key=True, index=True)
    submitted_by = Column(String(255), nullable=False, index=True)
    status = Column(String(32), default="pending", index=True)
    payload = Column(JSON, nullable=False, default=dict)
    documents = Column(JSON, nullable=True, default=list)
    review_notes = Column(Text, nullable=True)
    reviewed_by = Column(String(255), nullable=True, index=True)
    reviewed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)


class Project(Base):
    """A project test cases are generated for, named by its PPM ID.

    Chosen on Generate Test Cases and carried by everything generated under
    it: the saved request, its AI Checks drafts, and the cases Automation
    Studio receives once approved. Shared -- everyone who opens a PPM ID sees
    its sessions.
    """
    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, autoincrement=True)
    ppm_id = Column(String(100), nullable=False, unique=True, index=True)
    name = Column(String(255), nullable=False)
    created_by = Column(String(255), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


class TestCaseReviewDetail(Base):
    """Parent row for a review request and summary counts."""
    __tablename__ = "test_case_review_details"

    request_id = Column(String(255), primary_key=True, index=True)
    source = Column(String(64), nullable=True, index=True)
    request_by = Column(String(255), nullable=False, index=True)
    request_date_time = Column(DateTime, nullable=False, default=datetime.utcnow)
    brd_document = Column(JSON, nullable=True)
    no_of_test_cases = Column(Integer, nullable=False, default=0)
    approved_count = Column(Integer, nullable=False, default=0)
    rejected_count = Column(Integer, nullable=False, default=0)
    overall_status = Column(
        String(32),
        nullable=False,
        default='PENDING_REVIEW',
        server_default='PENDING_REVIEW',
    )
    review_notes = Column(Text, nullable=True)
    reviewed_by = Column(String(255), nullable=True, index=True)
    reviewed_date_time = Column(DateTime, nullable=True)
    # --- Generation session ------------------------------------------------
    # Added in place by init_db._ensure_columns on existing databases.
    # project_id: the Project it was generated for (None: no project chosen).
    # ai_batch_id: its AI Checks batch, so the page can find it again.
    # generation: what the Test Cases page needs to restore the session --
    #   the generated output, input type, KB, environment, focus and the
    #   processed document text.
    project_id = Column(Integer, nullable=True, index=True)
    ai_batch_id = Column(String(32), nullable=True, index=True)
    generation = Column(JSON, nullable=True)

    __table_args__ = (
        # AI_CHECKS: saved when AI Checks start, not yet sent for approval.
        CheckConstraint("overall_status IN ('AI_CHECKS', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'PARTIALLY_APPROVED')", name='ck_test_case_review_overall_status'),
    )


class TestCaseDetail(Base):
    """Individual test case result for a review request."""
    __tablename__ = "test_cases_details"

    test_case_id = Column(String(255), primary_key=True, index=True)
    request_id = Column(String(255), ForeignKey('test_case_review_details.request_id'), nullable=False, index=True)
    document_id = Column(String(255), nullable=True, index=True)
    test_case_details = Column(JSON, nullable=False, default=dict)
    status = Column(String(32), nullable=False, default='PENDING', server_default='PENDING')
    rejection_reason = Column(Text, nullable=True)
    reviewed_by = Column(String(255), nullable=True, index=True)
    reviewed_datetime = Column(DateTime, nullable=True)
    generated_by = Column(String(255), nullable=True, index=True)

    review_request = relationship('TestCaseReviewDetail', backref='test_cases')

    __table_args__ = (
        # DRAFT: saved with its request, not (yet) sent for approval.
        CheckConstraint("status IN ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED')", name='ck_test_case_detail_status'),
    )

class TestCaseWorkflowStage(Base):
    """One stage of a Test Assistant journey, keyed by the flow it belongs to.

    Written by routers/test_case_workflows.py: a row per (flow, stage), so the
    journey bar can show where a document is -- processed, generated, in
    review, in automation -- without inferring it from the other tables.
    """
    __tablename__ = "test_case_workflow_stages"

    id = Column(Integer, primary_key=True, autoincrement=True)
    stage_request_id = Column(String(255), nullable=False, index=True)
    stage = Column(String(64), nullable=False)
    status = Column(String(32), nullable=False, default='PENDING', server_default='PENDING')
    document_name = Column(Text, nullable=True)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint('stage_request_id', 'stage', name='uq_test_case_workflow_stage'),
        CheckConstraint("status IN ('PENDING', 'ACTIVE', 'COMPLETED')", name='ck_test_case_workflow_stage_status'),
    )


class BitbucketSync(Base):
    """Durable state for exporting one review request to its PPM repository.

    Approval and remote publication are intentionally separate transactions.
    A Bitbucket outage must never undo a manager's decision, while a failed
    publication must remain visible and retryable instead of being lost in a
    log file.
    """

    __tablename__ = "bitbucket_syncs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    request_id = Column(
        String(255),
        ForeignKey("test_case_review_details.request_id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
        index=True,
    )
    project_id = Column(Integer, nullable=False, index=True)
    ppm_id = Column(String(100), nullable=False, index=True)
    provider = Column(String(30), nullable=False)
    repository_slug = Column(String(255), nullable=False)
    repository_url = Column(Text, nullable=True)
    branch = Column(String(255), nullable=False)
    file_path = Column(Text, nullable=False)
    status = Column(String(20), nullable=False, default="pending", index=True)
    repository_created = Column(Boolean, nullable=False, default=False)
    commit_hash = Column(String(255), nullable=True)
    content_hash = Column(String(64), nullable=True)
    approved_cases = Column(Integer, nullable=False, default=0)
    attempt_count = Column(Integer, nullable=False, default=0)
    last_error = Column(Text, nullable=True)
    synced_by = Column(String(255), nullable=True)
    synced_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'syncing', 'synced', 'failed')",
            name="ck_bitbucket_sync_status",
        ),
    )
