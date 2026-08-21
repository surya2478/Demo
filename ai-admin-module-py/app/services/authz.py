"""
Server-side permission enforcement.

--- Automation Module: new file ---------------------------------------------

Added for the Automation Module, but written as a general helper because the
codebase had no reusable one. Today each router hand-rolls its own check --
`_ensure_admin()` appears separately in routers/config.py and
routers/settings.py -- and services/rbac.py contains a `roles_required`
decorator that cannot work as written (it wraps the endpoint in a closure
FastAPI never resolves as a dependency) and which nothing imports.

This module deliberately does NOT modify either of those. Existing routers
keep their existing checks; this is for new code.

Why it matters more for automation than for the rest of the app: the React
router enforces permissions client-side, and the token quota in the Test
Assistant tabs is checked entirely in the browser. For generation that is
merely untidy. For execution it is not -- a run spends real CPU, memory and
browser time on the server, so `automation.execute` has to be verified where
it cannot be bypassed.

Usage:

    from ..services.authz import require_permission

    @router.post("/runs")
    async def create_run(current_user: dict = Depends(require_permission("automation.execute"))):
        ...

The dependency returns the same user dict `get_current_user_strict` yields, so
it substitutes directly for it -- no endpoint needs both.
"""
from typing import Callable, List

from fastapi import Depends, HTTPException, status

from ..database.permissions import has_permission
from ..utils.security import get_current_user_strict


def extract_roles(user: dict) -> List[str]:
    """Every role name on a user, from either shape the app stores.

    The users table carries both `role` (a single string, the older column)
    and `roles` (a JSON list). Rows exist with one, the other, or both, so
    reading only one field silently under-privileges some users. Values are
    lower-cased because ROLE_PERMISSIONS is keyed in lower case while the
    ROLES setting is title-case.
    """
    if not user:
        return []

    roles: List[str] = []

    single = user.get("role")
    if single:
        roles.append(str(single))

    many = user.get("roles")
    if isinstance(many, list):
        roles.extend(str(r) for r in many if r)
    elif isinstance(many, str) and many:
        roles.append(many)

    # De-duplicate case-insensitively, preserving first-seen order.
    seen = set()
    result = []
    for role in roles:
        key = role.strip().lower()
        if key and key not in seen:
            seen.add(key)
            result.append(key)
    return result


def user_has_permission(user: dict, permission: str) -> bool:
    """Whether this user holds `permission`, admin override included.

    Mirrors the frontend's rule (see hasPermission in routes.tsx and
    TestAssistant.tsx) so that a screen the UI shows is a screen the API
    also allows. Divergence between the two would be worse than either
    rule alone.
    """
    roles = extract_roles(user)
    if "admin" in roles:
        return True
    return has_permission(roles, permission)


def require_permission(permission: str) -> Callable:
    """FastAPI dependency that admits only holders of `permission`.

    Fails closed: an unknown permission string matches no role, so a typo
    denies access rather than granting it.
    """

    async def _dependency(current_user: dict = Depends(get_current_user_strict)) -> dict:
        if not user_has_permission(current_user, permission):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"You do not have the '{permission}' permission required for this action.",
            )
        return current_user

    return _dependency


def require_any_permission(*permissions: str) -> Callable:
    """Same, but any one of several permissions is enough.

    For screens reachable by more than one role, matching how ProtectedRoute
    accepts an `allowedPermissions` list on the frontend.
    """

    async def _dependency(current_user: dict = Depends(get_current_user_strict)) -> dict:
        if not any(user_has_permission(current_user, p) for p in permissions):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    "You do not have any of the permissions required for this action: "
                    + ", ".join(permissions)
                ),
            )
        return current_user

    return _dependency
