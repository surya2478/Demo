# from fastapi import Request, APIRouter, Depends, HTTPException, status
# from sqlalchemy.orm import Session
# from pydantic import BaseModel
# from jose import JWTError
# from app.database import get_db
# from app.models.user import User
# from app.models.session import Session as SessionModel
# from app.utils.security import verify_password
# from app.utils.token import create_access_token, create_refresh_token, decode_access_token, new_token_id
# from app.services.ldap_service import ldap_authenticate
# from datetime import datetime, timedelta
# from app.services.audit_logger import log_action
# from app.config import settings

# router = APIRouter()

# class LoginRequest(BaseModel):
#     username : str
#     password : str

# @router.post("/login")
# def login(data: LoginRequest, response: Response, db: Session = Depends(get_db)):
#     username : data.username
#     password : data.password

#     # Store refresh tokens in httpOnly cookies
#     refresh_token = create_refresh_token({"sub": username, "tid": token_id, "role": user.role})

#     response.set_cookie(
#         key = "refresh_token",
#         value = refresh_token,
#         httponly = True,
#         secure = True,
#         samesite = "strict",
#         max_age = settings.REFRESH_EXP_DAYS * 86400  
#     )

# def require_roles(allowed_roles: list):
#     def checker(request: Request):
#         token = request.cookies.get("refresh_token")
#         if not token:
#             raise HTTPException(status_code=401, detail="Missing token")
#         try:
#             payload = decode_access_token(token)
#             role = payload.get("role")
#             if role not in allowed_roles:
#                 raise HTTPException(status_code=403, details="Access denied")
#             return payload
#         except JWTError:
#             raise HTTPException(status_code=401, detail="Invalid token")
#     return Depends(checker)
    
# @router.post("/admin/dashboard")
# def admin_dashboard(user=Depends(require_roles(["Admin"]))):
#     return {"message" : f"Welcome Admin {user['sub']}"}



# # @router.post("/login")
# # def login(username: str, password: str, db: Session = Depends(get_db)):
# #     user = db.query(User).filter_by(username=username, is_active=True).first()
# #     if not user:
# #         raise HTTPException(status_code=404, detail="User not found or inactive")

# #     # Local password check OR LDAP
# #     valid_local = verify_password(password, user.password_hash)
# #     valid_ldap = ldap_authenticate(username, password)
# #     if not (valid_local or valid_ldap):
# #         raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

# #     token_id = new_token_id()
# #     access_token = create_access_token({"sub": username, "tid": token_id})
# #     # session record
# #     timeout = int(db.query(...)) if False else int(settings.JWT_EXP_MINUTES)  # placeholder for future settings lookup
# #     expires_at = datetime.utcnow() + timedelta(minutes=timeout)
# #     session = SessionModel(username=username, token_id=token_id, expires_at=expires_at, is_active=True)
# #     db.add(session)
# #     db.commit()
# #     log_action(db, actor=username, action="login", resource=f"sessions/{token_id}", details={"ldap": settings.LDAP_ENABLED})

# #     return {"access_token": access_token, "token_type": "bearer"}

# @router.post("/logout")
# def logout(token: str, db: Session = Depends(get_db)):
#     try:
#         payload = decode_access_token(token)
#         token_id = payload.get("tid")
#         username = payload.get("sub")
#     except JWTError:
#         raise HTTPException(status_code=401, detail="Invalid token")

#     session = db.query(SessionModel).filter_by(token_id=token_id, is_active=True).first()
#     if not session:
#         raise HTTPException(status_code=404, detail="Session not found")
#     session.is_active = False
#     db.commit()
#     log_action(db, actor=username, action="logout", resource=f"sessions/{token_id}")
#     return {"message": "Logged out"}



from fastapi import APIRouter, Depends, Response, HTTPException
from pydantic import BaseModel
from datetime import datetime
from ..services.ldap_service import ldap_authenticate
from ..utils.token import create_access_token, create_refresh_token, decode_token
from ..utils.security import get_current_user_optional, get_current_user_strict
from ..services.audit_logger import audit_log
from ..database import upsert_session, remove_session
from ..models.session import SessionRecord
from ..config import settings
import uuid

router = APIRouter()

class LoginRequest(BaseModel):
    username: str
    password: str

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"

@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, response: Response):
    # Accept credentials via JSON body only
    user = db.query(User).filter_by(username=username, is_active=True).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found or inactive")

    
    # user = ldap_authenticate(payload.username, payload.password)
    # if not user or user.disabled:
    #     audit_log(actor=payload.username, action="login", resource="auth", status="failure", details={"reason": "invalid credentials"})
    #     raise HTTPException(status_code=401, detail="Invalid credentials")

    access_token = create_access_token({"sub": user.username, "roles": user.roles})
    refresh_token = create_refresh_token({"sub": user.username})

    # Create server-side session record
    session_id = str(uuid.uuid4())
    upsert_session(SessionRecord(
        session_id=session_id,
        username=user.username,
        created_at=datetime.utcnow(),
        last_seen_at=datetime.utcnow(),
        revoked=False
    ))

    # Set httpOnly refresh cookie (no JS access)
    response.set_cookie(
        key="refresh_token",
        value=refresh_token,
        httponly=True,
        secure=settings.COOKIE_SECURE,
        samesite=settings.COOKIE_SAMESITE,
        domain=settings.COOKIE_DOMAIN,
        path="/auth",
        max_age=60 * 60 * 24 * settings.REFRESH_TOKEN_EXPIRE_DAYS
    )
    # Also store session id cookie
    response.set_cookie(
        key="session_id",
        value=session_id,
        httponly=True,
        secure=settings.COOKIE_SECURE,
        samesite=settings.COOKIE_SAMESITE,
        domain=settings.COOKIE_DOMAIN,
        path="/",
        max_age=60 * 60 * 24 * settings.REFRESH_TOKEN_EXPIRE_DAYS
    )

    audit_log(actor=user.username, action="login", resource="auth", status="success")
    return TokenResponse(access_token=access_token)

class RefreshResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"

@router.post("/refresh", response_model=RefreshResponse)
def refresh_token(response: Response, current=Depends(get_current_user_optional)):
    # Refresh uses httpOnly cookie; user may or may not send existing access
    # We trust only the refresh cookie. If missing or invalid, 401.
    from fastapi import Request
    # We don't need Request object; cookie accessed via starlette response? We need Request.
    # Adjust to accept Request to read cookies.
    raise NotImplementedError("Use /auth/refresh2 with Request. See updated endpoint below.")

# Updated endpoint with Request to read cookies
from fastapi import Request

@router.post("/refresh2", response_model=RefreshResponse)
def refresh2(request: Request):
    rt = request.cookies.get("refresh_token")
    if not rt:
        raise HTTPException(status_code=401, detail="Missing refresh token")

    payload = decode_token(rt, verify_exp=True, refresh=True)
    if not payload or "sub" not in payload:
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    username = payload["sub"]
    # Issue new access token
    new_access = create_access_token({"sub": username})
    audit_log(actor=username, action="refresh", resource="auth", status="success")
    return RefreshResponse(access_token=new_access)

@router.post("/logout")
def logout(response: Response, user=Depends(get_current_user_strict), request: Request = None):
    # Revoke server-side session
    session_id = request.cookies.get("session_id") if request else None
    if session_id:
        remove_session(session_id)

    # Clear cookies
    response.delete_cookie("refresh_token", path="/auth", domain=settings.COOKIE_DOMAIN)
    response.delete_cookie("session_id", path="/", domain=settings.COOKIE_DOMAIN)
    audit_log(actor=user.username, action="logout", resource="auth", status="success")
    return {"detail": "Logged out"}