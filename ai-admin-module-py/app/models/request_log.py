"""
Request Log Model for SQLAlchemy ORM
Stores API request tracking data from Test Assistant tabs
"""

from sqlalchemy import Column, Integer, String, DateTime, Text, Enum as SQLEnum, Index
from datetime import datetime, timedelta, timezone
from app.database import Base
import enum


# Dubai timezone (UTC+4)
DUBAI_TZ = timezone(timedelta(hours=4))


def get_dubai_time():
    """Get current time in Dubai timezone"""
    return datetime.now(DUBAI_TZ).replace(tzinfo=None)


class TabEnum(str, enum.Enum):
    """Test Assistant tab names"""
    testcases = 'testcases'
    visual = 'visual'
    data = 'data'
    changes = 'changes'
    unit = 'unit'
    kb = 'kb'


class RequestLog(Base):
    __tablename__ = "request_logs"

    # Primary key
    id = Column(String(50), primary_key=True, index=True)
    
    # Request metadata
    timestamp = Column(DateTime, default=get_dubai_time, index=True)
    tab = Column(SQLEnum(TabEnum), nullable=False, index=True)
    method = Column(String(10), nullable=False)  # GET, POST, etc.
    url = Column(String(500), nullable=False)
    endpoint = Column(String(200), nullable=False, index=True)
    
    # Request/Response data
    request_payload = Column(Text, nullable=True)  # JSON string
    response_status = Column(Integer, nullable=True, index=True)
    response_data = Column(Text, nullable=True)  # JSON string
    duration = Column(Integer, nullable=True)  # milliseconds
    
    # Token tracking (from AI API responses)
    prompt_tokens = Column(Integer, nullable=True)  # Tokens in prompt
    response_tokens = Column(Integer, nullable=True)  # Tokens in response
    total_tokens = Column(Integer, nullable=True)  # Total tokens used
    
    # Error tracking
    error = Column(String(500), nullable=True)
    
    # User/Session info
    user = Column(String(100), nullable=True, index=True)
    session_id = Column(String(100), nullable=True, index=True)
    
    # Timestamps (Dubai timezone - UTC+4)
    created_at = Column(DateTime, default=get_dubai_time, index=True)
    updated_at = Column(DateTime, default=get_dubai_time, onupdate=get_dubai_time)

    __table_args__ = (
        # Composite index for common queries
        Index('idx_tab_timestamp', 'tab', 'timestamp'),
        Index('idx_user_timestamp', 'user', 'timestamp'),
        Index('idx_tab_user', 'tab', 'user'),
    )

    def to_dict(self):
        """Convert to dictionary for JSON response"""
        return {
            'id': self.id,
            'timestamp': self.timestamp.isoformat() if self.timestamp else None,
            'tab': self.tab.value if isinstance(self.tab, TabEnum) else self.tab,
            'method': self.method,
            'url': self.url,
            'endpoint': self.endpoint,
            'requestPayload': self.request_payload,
            'responseStatus': self.response_status,
            'responseData': self.response_data,
            'duration': self.duration,
            'promptTokens': self.prompt_tokens,
            'responseTokens': self.response_tokens,
            'totalTokens': self.total_tokens,
            'error': self.error,
            'user': self.user,
            'sessionId': self.session_id,
        }
