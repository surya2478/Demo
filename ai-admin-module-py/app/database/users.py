from __future__ import annotations
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any, List, Optional
from sqlalchemy.orm import Session
from ..models.database import User
from ..database.permissions import effective_permissions  # ...changed import...
import json

DATA_FILE = Path(__file__).with_name("users.json")

# internal helpers
def _to_iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

def _from_iso(s: str) -> datetime:
    # support trailing Z
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s).astimezone(timezone.utc)

def _load_json() -> Dict[str, Dict[str, Any]]:
    if not DATA_FILE.exists():
        return {}
    raw = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    # convert timestamps to datetime objects
    for k, v in raw.items():
        if "created_at" in v and isinstance(v["created_at"], str):
            try:
                v["created_at"] = _from_iso(v["created_at"])
            except Exception:
                v["created_at"] = datetime.utcnow().replace(tzinfo=timezone.utc)
        if "modified_at" in v and isinstance(v["modified_at"], str):
            try:
                v["modified_at"] = _from_iso(v["modified_at"])
            except Exception:
                v["modified_at"] = v.get("created_at", datetime.utcnow().replace(tzinfo=timezone.utc))
    return raw

def _save_json(db: Dict[str, Dict[str, Any]]) -> None:
    dump = {}
    for k, v in db.items():
        copy = dict(v)
        # convert datetimes to ISO strings
        if isinstance(copy.get("created_at"), datetime):
            copy["created_at"] = _to_iso(copy["created_at"])
        if isinstance(copy.get("modified_at"), datetime):
            copy["modified_at"] = _to_iso(copy["modified_at"])
        dump[k] = copy
    DATA_FILE.write_text(json.dumps(dump, indent=2, ensure_ascii=False), encoding="utf-8")

# load DB into memory on import
users_db: Dict[str, Dict[str, Any]] = _load_json()

# If file empty, initialize with minimal default users (so app can start)
if not users_db:
    now = datetime.utcnow().replace(tzinfo=timezone.utc)
    defaults = {
        "admin": {
            "username": "admin",
            "email": "admin@example.com",
            "password": "admin123",
            "role": "admin",
            "roles": ["admin"],
            "category": "system",
            "is_active": True,
            "created_at": now,
            "modified_at": now,
        },
        "manager": {
            "username": "manager",
            "email": "manager@example.com",
            "password": "manager123",
            "role": "manager",
            "roles": ["manager"],
            "category": "operations",
            "is_active": True,
            "created_at": now,
            "modified_at": now,
        },
    }
    users_db.update(defaults)
    _save_json(users_db)

# public DB functions (keep previous APIs)
def get_user(username: str) -> Optional[Dict[str, Any]]:
    return users_db.get(username)

def create_user(user_data: Dict[str, Any]) -> Dict[str, Any]:
    now = datetime.utcnow().replace(tzinfo=timezone.utc)
    user_data.setdefault("created_at", now)
    user_data.setdefault("modified_at", now)
    # ensure role/roles consistency
    if "role" in user_data and "roles" not in user_data:
        user_data["roles"] = [user_data["role"]]
    if "roles" in user_data and "role" not in user_data:
        user_data["role"] = user_data["roles"][0] if user_data["roles"] else "user"
    users_db[user_data["username"]] = user_data
    _save_json(users_db)
    return user_data

def update_user(username: str, user_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if username not in users_db:
        return None
    # update fields
    users_db[username].update(user_data)
    users_db[username]["modified_at"] = datetime.utcnow().replace(tzinfo=timezone.utc)
    # role/roles consistency
    if "role" in user_data and "roles" not in users_db[username]:
        users_db[username]["roles"] = [users_db[username]["role"]]
    if "roles" in user_data and "role" not in users_db[username]:
        users_db[username]["role"] = users_db[username]["roles"][0] if users_db[username]["roles"] else "user"
    _save_json(users_db)
    return users_db[username]

def delete_user(username: str) -> bool:
    if username not in users_db:
        return False
    users_db[username]["is_active"] = False
    users_db[username]["modified_at"] = datetime.utcnow().replace(tzinfo=timezone.utc)
    _save_json(users_db)
    return True

def get_active_users() -> List[Dict[str, Any]]:
    return [u for u in users_db.values() if u.get("is_active", False)]

def get_users_by_role(role: str) -> List[Dict[str, Any]]:
    return [u for u in users_db.values() if role in (u.get("roles") or []) and u.get("is_active", False)]

def _normalize_roles(raw) -> list:
    if raw is None:
        return []
    if isinstance(raw, list):
        return [str(r).lower() for r in raw]
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                return [str(r).lower() for r in parsed]
        except Exception:
            pass
        return [r.strip().lower() for r in raw.split(",") if r.strip()]
    return [str(raw).lower()]

def get_user(db: Session, username: str) -> Optional[Dict[str, Any]]:
    user = db.query(User).filter(User.username == username).first()
    print(f'Fetched user from DB {username}:', user)
    if not user:
        return None


    # print('user ====> ',user)
    # print('user.roles ====> ',user.roles)
    roles = _normalize_roles(user.roles)
    # print('roles list ====> ',roles)
    permissions = effective_permissions(roles)
    # print('permissions list ====> ',permissions)
    return {
        "username": user.username,
        "email": user.email,
        "password": user.password,
        "role": (user.role or "").lower(),
        "roles": roles,
        "permissions": permissions,        # <-- added
        "category": user.category,
        "is_active": user.is_active,
        "created_at": user.created_at,
        "modified_at": user.modified_at,
        "must_change_password": user.must_change_password,
        "token_allocation": user.token_allocation if hasattr(user, 'token_allocation') else 10000,
        "auth_source": user.auth_source if hasattr(user, 'auth_source') else "local",
        "allowed_time_start": user.allowed_time_start if hasattr(user, 'allowed_time_start') else None,
        "allowed_time_end": user.allowed_time_end if hasattr(user, 'allowed_time_end') else None,
    }

def create_user(db: Session, user_data: Dict[str, Any]) -> Dict[str, Any]:
    now = datetime.now(timezone.utc)
    db_user = User(
        username=user_data["username"],
        email=user_data["email"],
        password=user_data["password"],
        role=user_data.get("role", "user"),
        roles=user_data.get("roles", [user_data.get("role", "user")]),
        category=user_data.get("category"),
        is_active=user_data.get("is_active", True),
        must_change_password=user_data.get("must_change_password", True),
        auth_source=user_data.get("auth_source", "local"),
        token_allocation=user_data.get("token_allocation", 10000),
        allowed_time_start=user_data.get("allowed_time_start"),
        allowed_time_end=user_data.get("allowed_time_end"),
        created_at=user_data.get("created_at", now),
        modified_at=user_data.get("modified_at", now)
    )
    db.add(db_user)
    db.commit()
    db.refresh(db_user)

    return {
        "username": db_user.username,
        "email": db_user.email,
        "role": db_user.role,
        "roles": db_user.roles,
        "category": db_user.category,
        "is_active": db_user.is_active,
        "must_change_password": db_user.must_change_password,
        "token_allocation": db_user.token_allocation,
        "auth_source": db_user.auth_source,
        "allowed_time_start": db_user.allowed_time_start,
        "allowed_time_end": db_user.allowed_time_end,
        "created_at": db_user.created_at,
        "modified_at": db_user.modified_at
    }

def update_user(db: Session, username: str, user_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    db_user = db.query(User).filter(User.username == username).first()
    if not db_user:
        return None
    for k, v in user_data.items():
        if hasattr(db_user, k):
            setattr(db_user, k, v)
    db_user.modified_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(db_user)
    return get_user(db, username)

# def delete_user(db: Session, username: str) -> bool:
#     db_user = db.query(User).filter(User.username == username).first()
#     if not db_user:
#         return False
#     db_user.is_active = False
#     db_user.modified_at = datetime.now(timezone.utc)
#     db.commit()
#     return True

def delete_user(db: Session, username: str) -> bool:
    print('Attempting to delete user from database call :', username)
    # Prevent deletion of admin user
    if username.lower() == "admin":
        return False
    db_user = db.query(User).filter(User.username == username).first()
    if not db_user:
        return False
    db.delete(db_user)  # Actually delete the record
    db.commit()
    return True

__all__ = [
    "users_db",
    "get_user",
    "create_user",
    "update_user",
    "delete_user",
    "get_active_users",
    "get_users_by_role",
]