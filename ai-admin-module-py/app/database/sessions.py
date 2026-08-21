from sqlalchemy.orm import Session
from ..models.database import Session as SessionModel
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, Any, List
from zoneinfo import ZoneInfo

def add_session(
    db: Session,
    session_id: str,
    username: str,
    ip_address: Optional[str] = None,
    user_agent: Optional[str] = None,
    expires_in: Optional[int] = None
) -> Dict[str, Any]:
    """Add new session to database"""
    now = datetime.now(timezone.utc)
    # Convert using ZoneInfo
    now = now.astimezone(ZoneInfo("Asia/Dubai"))
    print(f"Current time in Asia/Dubai: {now}")
    print(f"Expires in (seconds): {expires_in}")
    expires_at = now + timedelta(seconds=expires_in) if expires_in else None
    print(f"Session expires at: {expires_at}")

    db_session = SessionModel(
        session_id=session_id,
        username=username,
        ip_address=ip_address,
        user_agent=user_agent,
        created_at=now,
        last_seen_at=now,
        expires_at=expires_at,
        data={},
        is_active=True,
        status="active"
    )

    db.add(db_session)
    db.commit()
    db.refresh(db_session)
    return _session_to_dict(db_session)

def get_session(db: Session, session_id: str) -> Optional[Dict[str, Any]]:
    session = db.query(SessionModel).filter(SessionModel.session_id == session_id).first()
    return _session_to_dict(session) if session else None

def remove_session(db: Session, session_id: str) -> bool:
    session = db.query(SessionModel).filter(SessionModel.session_id == session_id).first()
    if session:
        session.is_active = False
        session.status = "revoked"
        db.commit()
        return True
    return False

def purge_expired_sessions(db: Session) -> int:
    now = datetime.now(timezone.utc)
    print(f"Current time (UTC): {now}")
    now = now.astimezone(ZoneInfo("Asia/Dubai"))
    print(f"Current time in Asia/Dubai: {now}")
    
    expired = db.query(SessionModel).filter(
        SessionModel.expires_at < now,
        SessionModel.is_active == True
    ).all()
    print(f"Found {len(expired)} expired sessions to purge")
    count = 0
    for session in expired:
        session.is_active = False
        session.status = "expired"
        count += 1
    
    if count:
        db.commit()
    return count

def _session_to_dict(session: SessionModel) -> Dict[str, Any]:
    """Convert session model to dictionary"""
    return {
        "session_id": session.session_id,
        "username": session.username,
        "ip_address": session.ip_address,
        "user_agent": session.user_agent,
        "created_at": session.created_at,
        "last_seen_at": session.last_seen_at,
        "expires_at": session.expires_at,
        "data": session.data,
        "is_active": session.is_active,
        "status": session.status
    }