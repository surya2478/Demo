# RBAC = {
#     "Admin": {
#         "view_users": True, "edit_users": True,
#         "view_settings": True, "edit_settings": True,
#         "view_logs": True, "manage_sessions": True,
#     },
#     "QA": {
#         "view_users": True, "edit_users": False,
#         "view_settings": True, "edit_settings": False,
#         "view_logs": True, "manage_sessions": False,
#     },
#     "Manager": {
#         "view_users": True, "edit_users": True,
#         "view_settings": True, "edit_settings": False,
#         "view_logs": True, "manage_sessions": True,
#     },
#     "Tester": {
#         "view_users": True, "edit_users": False,
#         "view_settings": False, "edit_settings": False,
#         "view_logs": False, "manage_sessions": False,
#     }
# }

# def can(role_name: str, permission: str) -> bool:
#     role = RBAC.get(role_name, {})
#     return role.get(permission, False)


from fastapi import Depends, HTTPException
from functools import wraps
from typing import List, Callable, Any
from ..utils.security import get_current_user_strict

def roles_required(allowed_roles: List[str]):
    def decorator(func: Callable[..., Any]):
        @wraps(func)
        def wrapper(*args, **kwargs):
            # FastAPI dependency injection doesn't run inside wrapper directly.
            # We'll return a FastAPI endpoint function that enforces roles via Depends.
            async def endpoint(current=Depends(get_current_user_strict), **kw):
                user_roles = set(current.roles or [])
                if not user_roles.intersection(set(allowed_roles)):
                    raise HTTPException(status_code=403, detail="Insufficient permissions")
                return await func(*args, **kw, current=current)
            return endpoint
        return wrapper
    return decorator