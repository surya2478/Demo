# Expose DB modules without triggering circular imports during model initialization.
from .connection import get_db, Base, engine, SessionLocal

__all__ = [
    "get_db",
    "Base",
    "engine",
    "SessionLocal",
    "get_user",
    "create_user",
    "update_user",
    "delete_user",
    "ROLE_PERMISSIONS",
    "has_permission",
    "DB_AUDIT",
    "add_session",
    "get_session",
    "remove_session",
    "purge_session",
]


def __getattr__(name):
    if name in {"get_user", "create_user", "update_user", "delete_user"}:
        from .users import get_user, create_user, update_user, delete_user
        mapping = {
            "get_user": get_user,
            "create_user": create_user,
            "update_user": update_user,
            "delete_user": delete_user,
        }
        return mapping[name]
    if name in {"ROLE_PERMISSIONS", "has_permission"}:
        from .permissions import ROLE_PERMISSIONS, has_permission
        return ROLE_PERMISSIONS if name == "ROLE_PERMISSIONS" else has_permission
    if name == "DB_AUDIT":
        from .audit import DB_AUDIT
        return DB_AUDIT
    if name in {"add_session", "get_session", "remove_session", "purge_session"}:
        from .sessions import add_session, get_session, remove_session, purge_session
        mapping = {
            "add_session": add_session,
            "get_session": get_session,
            "remove_session": remove_session,
            "purge_session": purge_session,
        }
        return mapping[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")