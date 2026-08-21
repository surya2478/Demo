from zoneinfo import ZoneInfo
from fastapi import APIRouter, Depends, HTTPException, Query, Request
import jwt as pyjwt
from sqlalchemy.orm import Session
from typing import Optional, List
from datetime import datetime, timezone, timedelta
from ..services.audit_logger import audit_log

from ..database.connection import get_db
from ..utils.security import get_current_user_strict
from ..database.sessions import (
    purge_expired_sessions,
    get_session,
    remove_session,
)
from ..models.database import Session as SessionModel
from ..services.audit_logger import audit_log

router = APIRouter(tags=["Sessions"])

async def broadcast_sessions_to_admins(db: Session):
    """
    Placeholder async broadcaster used by cleanup endpoint to notify admins about session cleanup.
    If a project-level broadcaster exists, replace this implementation with an import.
    This function is intentionally a no-op to avoid raising NameError when awaited.
    """
    try:
        # No-op implementation; keep compatibility for callers that await this coroutine.
        return None
    except Exception:
        # Swallow any unexpected errors to avoid impacting cleanup flow.
        return None

def revoke_user_sessions(db: Session, username: str) -> int:
    """
    Revoke all active sessions for a given username.
    Returns number of sessions revoked.
    """
    try:
        # Update all active sessions for the user to inactive
        result = db.query(SessionModel).filter(
            SessionModel.username == username,
            SessionModel.is_active == True
        ).update({
            "is_active": False,
            "status": "revoked"
        })
        
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


@router.post("/keepAlive")
async def keep_alive_session(
    request: Request,
    ttl_seconds: Optional[int] = Query(None, description="Optional TTL in seconds to extend session by; defaults to configured session TTL"),
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    """
    Extend the current session's expiration time.
    
    Query params:
      - ttl_seconds: optional TTL extension in seconds (e.g., 300 for 5 mins). If not provided, uses the default session TTL from config.
    
    Response: { "session_id": str, "username": str, "expires_at": datetime, "extended_by_seconds": int }
    """
    # Determine username from current_user
    username = current_user.get("username") if isinstance(current_user, dict) else getattr(current_user, "username", None)
    if not username:
        raise HTTPException(status_code=400, detail="Unable to determine current user")

    # Extract session_id from query, cookies, header, or JWT claims (same logic as /status)
    sid = None
    
    # 1) cookies
    sid = request.cookies.get("sessionId") or request.cookies.get("sid") or request.cookies.get("currentSessionId")

    # 2) custom header
    if not sid:
        sid = request.headers.get("x-session-id") or request.headers.get("X-Session-Id")

    # 3) Authorization Bearer token claims
    if not sid:
        auth = request.headers.get("authorization") or request.headers.get("Authorization")
        if auth and auth.lower().startswith("bearer "):
            token = auth.split(" ", 1)[1]
            try:
                payload = pyjwt.decode(token, options={"verify_signature": False, "verify_aud": False})
                sid = payload.get("jti") or payload.get("sid") or payload.get("session_id") or payload.get("sessionId")
            except Exception as e:
                print(f"Failed to decode JWT for keepAlive: {e}")
                sid = None

    # Find the session
    session_obj = None
    if sid:
        session_obj = db.query(SessionModel).filter(
            SessionModel.session_id == sid,
            SessionModel.username == username
        ).first()

    if not session_obj:
        # Fallback: find the most recent active session for this user
        session_obj = (
            db.query(SessionModel)
            .filter(SessionModel.username == username, SessionModel.is_active == True)
            .order_by(SessionModel.last_seen_at.desc().nullslast(), SessionModel.created_at.desc())
            .first()
        )

    if not session_obj:
        raise HTTPException(status_code=404, detail="No active session found for user")

    # Check if session is already revoked
    if session_obj.status == "revoked" or not session_obj.is_active:
        raise HTTPException(status_code=403, detail="Session has been revoked or is inactive")

    # Get default TTL from config (or hardcoded fallback)
    default_ttl = 3600  # 1 hour fallback
    try:
        from ..config import settings
        default_ttl = getattr(settings, "SESSION_EXPIRY_SECONDS", 3600)
    except Exception:
        pass

    # Use provided ttl_seconds or fall back to default
    extension_seconds = ttl_seconds if ttl_seconds and ttl_seconds > 0 else default_ttl
    
    # Calculate new expiration time
    now =   datetime.now(timezone.utc)
    now = now.astimezone(ZoneInfo("Asia/Dubai"))
    print(f"=======================Current time (Asia/Dubai): {now}") 
    new_expires_at = now + timedelta(seconds=extension_seconds)
    print(f"===============Extending session {session_obj.session_id} for user {username} by {extension_seconds} seconds to new expires_at {new_expires_at}")  
    # Update session in DB
    try:
        session_obj.expires_at = new_expires_at
        session_obj.last_seen_at = now
        session_obj.status = "active"  # ensure status is active
        session_obj.is_active = True
        db.add(session_obj)
        db.commit()
        db.refresh(session_obj)
        
        print(f"SUCCESS: Session {session_obj.session_id} extended for user {username}. New expires_at: {new_expires_at}")
        
        # Audit log the extension
        # Log the action
        audit_log(
            actor=username,
            action="extend_session",
            resource="sessions",
            actor_role=current_user.get("role"),
            resource_name="Sessions",
            resource_id="extend session",
            resource_type="api endpoint",
            module="Sessions",
            status="success",
            details={
                "session_id": session_obj.session_id[:4] + "****" + session_obj.session_id[-4:],
                "new_expires_at": new_expires_at.isoformat(),
                "extended_by_seconds": extension_seconds
            }
        )
        
        
        return {
            "session_id": session_obj.session_id[:4] + "****" + session_obj.session_id[-4:],
            "username": session_obj.username,
            "expires_at": new_expires_at.isoformat(),
            "extended_by_seconds": extension_seconds,
        }
    except Exception as e:
        db.rollback()
        # print(f"ERROR: Failed to extend session {session_obj.session_id[:4] + "****" + session_obj.session_id[-4:]}: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Failed to extend session")


@router.post("/cleanup")
async def cleanup_sessions(
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db)
):
    """
    Manually trigger cleanup of expired sessions (admin only).
    
    WARNING: Only call this during low-traffic windows (e.g., nightly cron job).
    Do NOT call frequently as it may interfere with active extend operations.
    """
    user_roles = current_user.get("roles", []) if isinstance(current_user, dict) else getattr(current_user, "roles", [])
    if isinstance(user_roles, str):
        user_roles = [user_roles]

    if "admin" not in [r.lower() for r in user_roles]:
        raise HTTPException(status_code=403, detail="Admin access required")

    # # Log the action
    # audit_log(
    #     actor=current_user.get("username"),
    #     action="cleanup_sessions",
    #     actor_role=current_user.get("role"),
    #     resource_name="Sessions",
    #     resource_id="cleanup sessions",
    #     resource_type="api endpoint",
    #     module="Sessions",
    #     status="success",
    #     details={"backend endpoint called to cleanup sessions": True}
    # )

    try:
        now = datetime.now(timezone.utc)
        
        # Only purge sessions that are:
        # 1) marked as expired/revoked already, OR
        # 2) have expires_at in the past AND haven't been updated in last 30 seconds (grace period)
        grace_period = timedelta(seconds=30)
        cutoff_time = now - grace_period
        
        purged_count = db.query(SessionModel).filter(
            (SessionModel.status.in_(["expired", "revoked"])) |
            ((SessionModel.expires_at <= now) & (SessionModel.last_seen_at <= cutoff_time))
        ).delete(synchronize_session=False)
        
        db.commit()
        print(f"Purged {purged_count} expired sessions (with 30s grace period)")
        
        await broadcast_sessions_to_admins(db)
        return {"message": f"Purged {purged_count} expired sessions"}
    except Exception as e:
        db.rollback()
        print(f"ERROR during cleanup: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Cleanup failed")

@router.get("/list")
async def list_sessions(
    username: Optional[str] = Query(None, description="Filter by username"),
    include_expired: bool = Query(False, description="Include expired/revoked sessions"),
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db)
):
    """List all sessions (admin only)"""
    user_roles = current_user.get("roles", []) if isinstance(current_user, dict) else getattr(current_user, "roles", [])
    if isinstance(user_roles, str):
        user_roles = [user_roles]

    if "admin" not in [r.lower() for r in user_roles]:
        raise HTTPException(status_code=403, detail="Admin access required")

    query = db.query(SessionModel)
    if username:
        query = query.filter(SessionModel.username == username)
    if not include_expired:
        query = query.filter(SessionModel.is_active == True)

    sessions = query.all()

    # Add sequential IDs for UI
    result = []
    for idx, session in enumerate(sessions, 1):
        session_dict = {
            "seq_id": idx,
            "session_id": session.session_id,
            "username": session.username,
            "ip_address": session.ip_address,
            "user_agent": session.user_agent,
            "created_at": session.created_at,
            "last_seen_at": session.last_seen_at,
            "expires_at": session.expires_at,
            "is_active": session.is_active,
            "status": session.status
        }
        result.append(session_dict)

    # # Log the action
    # audit_log(
    #     actor=current_user.get("username"),
    #     action="Session",
    #     actor_role=current_user.get("role"),
    #     resource_name="Sessions",
    #     resource_id="Session Management",
    #     resource_type="View",
    #     module="Sessions",
    #     status="success",
    #     details={"backend endpoint called to list sessions": True}
    # )

    return {"sessions": result}

@router.delete("/delete/{session_id}")
async def terminate_session(
    session_id: str,
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db)
):
    """Terminate single session"""
    # Handle current_user as dictionary
    user_roles = current_user.get("roles", []) if isinstance(current_user, dict) else getattr(current_user, "roles", [])
    username = current_user.get("username") if isinstance(current_user, dict) else getattr(current_user, "username")
    if isinstance(user_roles, str):
        user_roles = [user_roles]

    # find session record by session_id field
    session_obj = db.query(SessionModel).filter(SessionModel.session_id == session_id).first()
    if not session_obj:
        raise HTTPException(status_code=404, detail="Session not found")

    if "admin" not in [r.lower() for r in user_roles]:
        # Non-admins can only terminate their own sessions
        if session_obj.username != username:
            raise HTTPException(status_code=403, detail="Not authorized")

    success = remove_session(db, session_id)
    if success:
        # audit_log(
        #     actor=username,
        #     action="Terminate",
        #     resource_name="Sessions",
        #     module="Sessions",
        #     resource_id="user session",
        #     actor_role=current_user.get("role"),
        #     resource_type="Delete",
        #     status="success",
        #     details={"session terminated by session_id": session_obj.session_id[:4] + "****" + session_obj.session_id[-4:]}
        # )
        return {"message": "Session terminated"}
    raise HTTPException(status_code=500, detail="Failed to terminate session")

@router.delete("/user/{username}")
async def terminate_user_sessions(
    username: str,
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db)
):
    """Terminate all sessions for a user"""
    # Handle current_user as dictionary
    user_roles = current_user.get("roles", []) if isinstance(current_user, dict) else getattr(current_user, "roles", [])
    current_username = current_user.get("username") if isinstance(current_user, dict) else getattr(current_user, "username")
    if isinstance(user_roles, str):
        user_roles = [user_roles]

    if "admin" not in [r.lower() for r in user_roles] and current_username != username:
        raise HTTPException(status_code=403, detail="Not authorized")

    count = revoke_user_sessions(db, username)
    # audit_log(
    #     actor=current_username,
    #     action="Terminate",
    #     resource_name="Sessions",
    #     resource_type="Delete",
    #     module="Sessions",
    #     actor_role=current_user.get("role"),
    #     resource_id="terminate user sessions",
    #     status="success",
    #     details={"terminate user sessions by username": username, "count": count}
    # )

    return {"message": f"Terminated {count} sessions"}

@router.get("/dashboard/recent")
def recent_sessions_summary(
    limit: int = 10,
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db)
):
    """
    Admin-only: return active sessions count and recent session list.
    Response:
      {
        "active_sessions": int,
        "recent_sessions": [ {session fields} ... ]
      }
    """
    # authorize admin
    roles = current_user.get("roles", []) if isinstance(current_user, dict) else []
    if isinstance(roles, str):
        roles = [roles]
    if "admin" not in [r.lower() for r in roles]:
        raise HTTPException(status_code=403, detail="Admin access required")

    now = datetime.now(timezone.utc)
    # active sessions: is_active True and not expired (if expires_at exists)
    active_q = db.query(SessionModel).filter(SessionModel.is_active == True)
    active_q = active_q.filter(
        (SessionModel.expires_at == None) | (SessionModel.expires_at > now)
    )
    active_count = active_q.count()

    recent = (
        db.query(SessionModel)
        .filter(SessionModel.is_active == True)
        .filter((SessionModel.expires_at == None) | (SessionModel.expires_at > now))
        .order_by(SessionModel.created_at.desc())
        .limit(limit)
        .all()
    )

    recent_list = [
        {
            "session_id": s.session_id,
            "username": s.username,
            "ip_address": s.ip_address,
            "user_agent": s.user_agent,
            "created_at": s.created_at,
            "last_seen_at": s.last_seen_at,
            "expires_at": s.expires_at,
            "is_active": s.is_active,
            "status": s.status,
        }
        for s in recent
    ]

    return {"active_sessions": active_count, "recent_sessions": recent_list}

@router.get("/status")
async def session_status(
    request: Request,
    session_id: Optional[str] = Query(None, description="Optional session id to check"),
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    """
    Return status for the current session. This endpoint is available to the authenticated user
    and will attempt to resolve session id from:
      1) query param, 2) cookies (sessionId/sid), 3) header X-Session-Id, 4) Authorization JWT claims (jti/sid/session_id).
    Response: { "session_id": str|None, "username": str, "is_active": bool, "status": str, "expires_at": datetime|None }
    """
    # determine username from current_user
    username = current_user.get("username") if isinstance(current_user, dict) else getattr(current_user, "username", None)
    if not username:
        raise HTTPException(status_code=400, detail="Unable to determine current user")

    # 1) explicit query param
    sid = session_id

    # 2) cookies
    if not sid:
        sid = request.cookies.get("sessionId") or request.cookies.get("sid") or request.cookies.get("currentSessionId")

    # 3) custom header
    if not sid:
        sid = request.headers.get("x-session-id") or request.headers.get("X-Session-Id")

    # 4) Authorization Bearer token claims / jti (best-effort)
    if not sid:
        auth = request.headers.get("authorization") or request.headers.get("Authorization")
        if auth and auth.lower().startswith("bearer "):
            token = auth.split(" ", 1)[1]
            try:
                # decode without signature verification to read claims
                # (best-effort; requires PyJWT). If PyJWT is not present this will skip.
                payload = pyjwt.decode(token, options={"verify_signature": False, "verify_aud": False})
                sid = sid or payload.get("jti") or payload.get("sid") or payload.get("session_id") or payload.get("sessionId")
            except Exception as e:
                # ignore decode errors - keep sid None
                print(f"Failed to decode JWT: {e}")
                sid = sid

    # If still no session id attempt to find the most recent active session for this user
    session_obj = None
    if sid:
        session_obj = db.query(SessionModel).filter(SessionModel.session_id == sid, SessionModel.username == username).first()

    if not session_obj:
        # fallback: choose user's latest active session (if any)
        session_obj = (
            db.query(SessionModel)
            .filter(SessionModel.username == username)
            .order_by(SessionModel.last_seen_at.desc().nullslast(), SessionModel.created_at.desc())
            .first()
        )

    if not session_obj:
        return {
            "session_id": None,
            "username": username,
            "is_active": False,
            "status": "not_found",
            "expires_at": None,
        }

    # compute expired-by-time (normalize naive datetimes to UTC before comparison)
    now = datetime.now(timezone.utc)
    expired_by_time = False
    
    if session_obj.expires_at:
        expires_at = session_obj.expires_at
        
        # If DB returned a naive datetime (no tzinfo), assume UTC
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        
        expired_by_time = expires_at <= now

    # If session is expired by time, update DB to mark it as expired and inactive
    if expired_by_time:
        try:
            session_obj.status = "expired"
            session_obj.is_active = False
            db.add(session_obj)
            db.commit()
            print(f"SUCCESS: Session {session_obj.session_id} marked as expired in DB")
        except Exception as e:
            db.rollback()
            print(f"ERROR: Failed to update expired session in DB: {e}")
            import traceback
            traceback.print_exc()
    
    # Log the action
    # audit_log(
    #     actor=current_user.get("username"),
    #     action="get_session",
    #     actor_role=current_user.get("role"),
    #     resource_type="/session",
    #     status="success",
    #     details={"get the session status for session_id": session_obj.session_id}
    # )

    # normalize response
    resp = {
        "session_id": session_obj.session_id,
        "username": session_obj.username,
        "is_active": bool(session_obj.is_active) and not expired_by_time and (session_obj.status != "revoked"),
        "status": session_obj.status if session_obj.status else ("expired" if expired_by_time else "active"),
        "expires_at": session_obj.expires_at,
    }
    return resp