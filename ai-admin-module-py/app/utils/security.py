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
    try:
        payload = decode_token(token, verify_exp=True)
        username = payload.get("sub")
        if not username:
            raise HTTPException(status_code=401, detail="Invalid token payload")
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Invalid or expired token: {e}")
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

    try:
        payload = decode_token(token, verify_exp=True)
        username = payload.get("sub")
        if not username:
            raise HTTPException(status_code=401, detail="Invalid token payload")
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Invalid or expired token: {e}")

    user = get_user(db, username)
    print("user object return from db :: ", user)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user