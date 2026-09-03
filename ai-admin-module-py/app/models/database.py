from sqlalchemy import Column, Integer, String, DateTime, Boolean, JSON, ForeignKey, CheckConstraint
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


class TestCaseReviewDetail(Base):
    """Parent row for a review request and summary counts."""
    __tablename__ = "test_case_review_details"

    request_id = Column(String(255), primary_key=True, index=True)
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

    __table_args__ = (
        CheckConstraint("overall_status IN ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'PARTIALLY_APPROVED')", name='ck_test_case_review_overall_status'),
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
        CheckConstraint("status IN ('PENDING', 'APPROVED', 'REJECTED')", name='ck_test_case_detail_status'),
    )