# import uuid
# from datetime import datetime, timedelta
# from jose import jwt
# from app.config import settings

# def create_access_token(data: dict, expires_minutes: int | None = None):
#     to_encode = data.copy()
#     expire = datetime.utcnow() + timedelta(minutes=expires_minutes or settings.JWT_EXP_MINUTES)
#     to_encode.update({"exp": expire})
#     return jwt.encode(to_encode, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)

# def decode_access_token(token: str):
#     return jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])

# def new_token_id() -> str:
#     return uuid.uuid4().hex



# import jwt
from jose import jwt
from datetime import datetime, timedelta, timezone
from ..config import settings

def _now():
    return datetime.now(tz=timezone.utc)

def create_access_token(data: dict):
    to_encode = data.copy()
    expire = _now() + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire, "iat": _now(), "type": "access"})
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.JWT_ALGORITHM)

def create_refresh_token(data: dict):
    to_encode = data.copy()
    expire = _now() + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    to_encode.update({"exp": expire, "iat": _now(), "type": "refresh"})
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.JWT_ALGORITHM)

def decode_token(token: str, verify_exp: bool = True, refresh: bool = False):
    try:
        payload = jwt.decode(
            token,
            settings.SECRET_KEY,
            algorithms=[settings.JWT_ALGORITHM],
            options={"verify_exp": verify_exp}
        )
        if refresh and payload.get("type") != "refresh":
            return None
        if not refresh and payload.get("type") != "access":
            return None
        return payload
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None