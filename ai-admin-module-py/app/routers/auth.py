from fastapi import APIRouter, Depends, Response, HTTPException, Request
from sqlalchemy.orm import Session
import uuid
from typing import List, Callable
from functools import wraps
from datetime import datetime
from zoneinfo import ZoneInfo

from ..database.connection import get_db
from ..database.users import get_user
from ..database.sessions import add_session
from ..services.audit_logger import audit_log
from ..config import settings
from ..utils.token import create_access_token, create_refresh_token
from ..utils.security import get_current_user_strict, get_current_user_strict_token

router = APIRouter(tags=["Authentication"])

def _parse_hhmm_minutes(value: str) -> int:
    parts = value.split(":")
    if len(parts) != 2:
        raise ValueError("Time must be in HH:MM format")
    hours = int(parts[0])
    minutes = int(parts[1])
    if hours < 0 or hours > 23 or minutes < 0 or minutes > 59:
        raise ValueError("Time must be in 24-hour HH:MM format")
    return (hours * 60) + minutes

def _is_time_allowed(current_minutes: int, start_minutes: int, end_minutes: int) -> bool:
    if start_minutes == end_minutes:
        return True
    if start_minutes < end_minutes:
        return start_minutes <= current_minutes <= end_minutes
    return current_minutes >= start_minutes or current_minutes <= end_minutes

def require_roles(allowed_roles: List[str]) -> Callable:
    """
    Decorator to check if user has required roles.
    Usage: @require_roles(["admin", "manager"])
    """
    def decorator(func: Callable) -> Callable:
        @wraps(func)
        async def wrapper(*args, **kwargs):
            # Get current user from kwargs (passed by dependency)
            current_user = kwargs.get('current_user')
            if not current_user:
                raise HTTPException(
                    status_code=401,
                    detail="Not authenticated"
                )

            # Get user roles (handle both string and list)
            user_roles = current_user.get('roles', [])
            if isinstance(user_roles, str):
                user_roles = [user_roles]
            
            # Check if user has any of the required roles
            if not any(role in allowed_roles for role in user_roles):
                raise HTTPException(
                    status_code=403,
                    detail="Not authorized for this operation"
                )
            
            return await func(*args, **kwargs)
        return wrapper
    return decorator

@router.post("/login")
async def login(
    request: Request,
    response: Response,
    db: Session = Depends(get_db)
):
    """
    Accepts JSON or form body. Returns access and refresh tokens.
    Authentication flow:
    1. Check SQLite database for user
    2. If user not found, reject immediately
    3. If user found, authenticate based on auth_source:
       - 'local': validate password hash from database
       - 'ldap': validate via LDAP server
    """
    username = password = None
    try:
        body = await request.json()
        username = body.get("username")
        password = body.get("password")
    except Exception:
        form = await request.form()
        username = form.get("username")
        password = form.get("password")
    
    if not username or not password:
        raise HTTPException(status_code=422, detail="username and password required")

    # Step 1: Always check SQLite first - verify user is registered
    user = get_user(db, username)
    print(f"Login attempt for user: {username} and auth_source: {user}")
    if not user:
        # User not found in database - provide professional message
        raise HTTPException(
            status_code=404, 
            detail="User not registered. Please contact your system administrator to request access."
        )
    print(f"User {username} found in database with auth_source: {user.get('auth_source', 'local')}")
    
    # Step 2: Check if user is active
    if not user.get("is_active", True):
        raise HTTPException(
            status_code=403,
            detail="Your account has been deactivated. Please contact your system administrator for assistance."
        )
    
    # Step 3: Validate time slot access (if time slots are configured)
    allowed_start = user.get("allowed_time_start")
    allowed_end = user.get("allowed_time_end")
    
    if bool(allowed_start) ^ bool(allowed_end):
        raise HTTPException(
            status_code=403,
            detail="Access denied. Your account has an incomplete login time slot configuration. Please contact your system administrator."
        )

    if allowed_start and allowed_end:
        try:
            start_minutes = _parse_hhmm_minutes(allowed_start)
            end_minutes = _parse_hhmm_minutes(allowed_end)
        except ValueError:
            raise HTTPException(
                status_code=403,
                detail="Access denied. Your account has an invalid login time slot configuration. Please contact your system administrator."
            )

        current_time = datetime.now(ZoneInfo("Asia/Dubai"))
        current_minutes = (current_time.hour * 60) + current_time.minute
        current_hour_min = current_time.strftime("%H:%M")

        if not _is_time_allowed(current_minutes, start_minutes, end_minutes):
            raise HTTPException(
                status_code=403,
                detail=f"Access denied. Your account is only accessible between {allowed_start} and {allowed_end} (Dubai Time). Current time: {current_hour_min}"
            )
    
    # Step 4: Authenticate based on auth_source
    auth_source = user.get("auth_source", "local")
    print(f"Authenticating user {username} via auth_source: {auth_source}")
    if auth_source == "ldap":
        # LDAP authentication with SQLite whitelist validation
        # The ldap_authenticate function will:
        # 1. Verify user is authorized in SQLite whitelist (auth_source='ldap')
        # 2. Authenticate against LDAP using service account
        from ..services.ldap_service import ldap_authenticate
        if not ldap_authenticate(username, password, db):
            raise HTTPException(status_code=401, detail="Invalid LDAP credentials or not authorized")
    else:
        # Local database authentication (default)
        # For 'admin' user, keep existing simple password comparison
        # For other users, you should use password hashing (bcrypt, etc.)
        if user.get("password") != password:
            raise HTTPException(status_code=401, detail="Invalid credentials")

    # Authentication successful - create tokens
    access_token = create_access_token({"sub": username})
    print(f"Access token created for user {username}: {access_token}")
    refresh_token = create_refresh_token({"sub": username})

    session_id = f"{username}-{uuid.uuid4().hex}"
    ip = request.client.host if request.client else None
    ua = request.headers.get("user-agent")

    add_session(
        db=db,
        session_id=session_id,
        username=username,
        ip_address=ip,
        user_agent=ua,
        expires_in=(getattr(settings, "ACCESS_TOKEN_EXPIRE_MINUTES", None) * 60) if getattr(settings, "ACCESS_TOKEN_EXPIRE_MINUTES", None) else None
    )

    # Audit log the login event
    audit_log(
        actor=username,
        action="Login",
        module="Authentication",
        actor_role=user.get("role"),
        resource_type="Authentication",
        resource_id="Modal: Login",
        status="success",
        details={
            f"Description " : f"{username} logged in from the IP address: {ip}", 
            "Session": session_id[:4] + "****" + session_id[-4:],
            "auth_source": auth_source
             }
    )
    
    # Do NOT set cookies here (use Authorization header from frontend instead).
    # Removed response.set_cookie(...) calls.

    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "session_id": session_id
    }

@router.get("/me")
async def get_current_user(
    current_user=Depends(get_current_user_strict_token),  # Use the OAuth2 based verification
    db: Session = Depends(get_db)
):
    """Get current authenticated user's information"""
    # Remove sensitive information
    user_data = dict(current_user)
    user_data.pop("password", None)
    
    return user_data