from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from app.routers.auth import require_roles
from ..utils.security import get_current_user_strict
from typing import Dict, Any, List

router = APIRouter()

def get_dashboard_data(user_roles: List[str]) -> Dict[str, Any]:
    """Get dashboard data based on user roles"""
    dashboard_data = {
        "user": {
            "widgets": ["basic_stats", "my_tasks", "announcements"],
            "permissions": ["dashboard.view"]
        },
        "admin": {
            "widgets": ["system_stats", "user_management", "audit_logs", "all_tasks"],
            "permissions": ["dashboard.view", "user.manage", "audit.view", "settings.manage"]
        },
        "manager": {
            "widgets": ["team_stats", "team_tasks", "reports"],
            "permissions": ["dashboard.view", "team.manage", "reports.view"]
        },
        "qa": {
            "widgets": ["test_metrics", "bug_reports", "test_cases"],
            "permissions": ["dashboard.view", "test.manage"]
        }
    }

    # Role priority determines which dashboard to show
    priority_roles = ["admin", "manager", "qa", "user"]
    for role in priority_roles:
        if role in user_roles:
            data = {"role": role, **dashboard_data.get(role, dashboard_data["user"])}
            data["user_roles"] = user_roles
            return data

    # Default
    return {"role": "user", **dashboard_data["user"], "user_roles": user_roles}

def require_roles(allowed_roles: List[str]):
    """
    Dependency factory that ensures the current user has at least one of the allowed roles.
    Works whether the user returned by get_current_user_strict is a dict or an object.
    """
    def checker(user=Depends(get_current_user_strict)):
        if not user:
            raise HTTPException(status_code=401, detail="Unauthorized")

        # extract roles whether `user` is a dict or an object
        if isinstance(user, dict):
            roles = user.get("roles") or user.get("role") or []
        else:
            roles = getattr(user, "roles", None) or getattr(user, "role", None) or []

        if isinstance(roles, str):
            roles = [roles]
        if roles is None:
            roles = []

        if not any(role in allowed_roles for role in roles):
            raise HTTPException(status_code=403, detail="Forbidden")

        return user
    return checker

@router.get("/main")
def admin_dashboard(user=Depends(require_roles(["admin"]))):
    # ensure username access works for dict/object
    if isinstance(user, dict):
        username = user.get("username") or user.get("sub") or "user"
    else:
        username = getattr(user, "username", None) or getattr(user, "sub", None) or "user"

    return JSONResponse({
        "message": f"Welcome Admin {username}",
        "role": "admin"
    })

@router.get("/user")
def user_dashboard(user=Depends(require_roles(["user"]))):
    if isinstance(user, dict):
        username = user.get("username") or user.get("sub") or "user"
    else:
        username = getattr(user, "username", None) or getattr(user, "sub", None) or "user"

    return JSONResponse({
        "message": f"Welcome User {username}",
        "role": "user"
    })

@router.get("/role")
async def dashboard(user=Depends(get_current_user_strict)):
    """Single dashboard endpoint that returns role-specific content"""
    # ensure dependency returned a value
    if not user:
        raise HTTPException(status_code=401, detail="Unauthorized")

    # extract roles whether `user` is a dict or an object
    if isinstance(user, dict):
        roles = user.get("roles") or user.get("role") or []
        username = user.get("username") or user.get("user") or user.get("sub")
    else:
        roles = getattr(user, "roles", None) or getattr(user, "role", None) or []
        username = getattr(user, "username", None) or getattr(user, "sub", None)

    # normalize roles to list
    if isinstance(roles, str):
        roles = [roles]
    if roles is None:
        roles = []

    dashboard_data = get_dashboard_data(roles)

    return JSONResponse({
        "message": f"Welcome {username or 'user'}",
        "user_info": {
            "username": username,
            "roles": roles
        },
        "dashboard": dashboard_data
    })