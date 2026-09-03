from fastapi import Header, HTTPException, Depends, Request
from typing import Optional
from ..utils.token import decode_token
from ..database.users import get_user
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session
from ..database.connection import get_db

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="auth/login")

def parse_authorization_header(authorization: Optional[str] = None) -> Optional[str]:
    if not authorization:
        return None
    auth_value = authorization.strip()
    if not auth_value:
        return None

    # Standard format: "Bearer <token>"
    parts = auth_value.split()
    if len(parts) == 2 and parts[0].lower() == 'bearer':
        return parts[1].strip()

    # Fallback: allow raw token value (common in manual Swagger / Postman tests)
    if ' ' not in auth_value:
        return auth_value

    return None

# keep get_current_user_strict (header + db) as-is if used elsewhere
async def get_current_user_strict(
    request: Request,
    authorization: Optional[str] = Header(None, description="Bearer token"),
    db: Session = Depends(get_db)
):
    if not authorization:
        authorization = request.headers.get("Authorization")
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing Authorization header")
    token = parse_authorization_header(authorization)
    if not token:
        raise HTTPException(
            status_code=401,
            detail="Invalid Authorization header format. Use 'Bearer <token>' or provide raw token."
        )
    # decode_token returns a payload or None and raises nothing, so there is
    # nothing here to catch. The `except Exception` that used to wrap this did
    # three unhelpful things: it turned an expired token (None payload) into
    # "'NoneType' object has no attribute 'get'", it caught the deliberate
    # HTTPException two lines above and re-raised it as "Invalid or expired
    # token: 401: Invalid token payload", and it put whatever went wrong inside
    # this backend into a response body the client can read.
    payload = decode_token(token, verify_exp=True)
    if payload is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    username = payload.get("sub")
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token payload")
    user = get_user(db, username)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user

# New cookie/header aware dependency used by /auth/me and UI
async def get_current_user_strict_token(
    request: Request,
    db: Session = Depends(get_db)
):
    """
    Try Authorization header first, then fallback to 'access_token' cookie.
    Returns user dict or raises 401.
    """
    # 1) header
    auth_header = request.headers.get("Authorization")
    token = parse_authorization_header(auth_header) if auth_header else None

    # 2) fallback to cookie
    if not token:
        token = request.cookies.get("access_token")

    if not token:
        raise HTTPException(status_code=401, detail="Missing token (Authorization header or access_token cookie)")

    # decode_token returns a payload or None and raises nothing, so there is
    # nothing here to catch. The `except Exception` that used to wrap this did
    # three unhelpful things: it turned an expired token (None payload) into
    # "'NoneType' object has no attribute 'get'", it caught the deliberate
    # HTTPException two lines above and re-raised it as "Invalid or expired
    # token: 401: Invalid token payload", and it put whatever went wrong inside
    # this backend into a response body the client can read.
    payload = decode_token(token, verify_exp=True)
    if payload is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    username = payload.get("sub")
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    user = get_user(db, username)
    print("user object return from db :: ", user)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user