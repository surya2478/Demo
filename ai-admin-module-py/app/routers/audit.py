from fastapi import APIRouter, Depends, HTTPException, Request, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import and_, or_
from typing import Optional, Any, Dict, List
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from ..database.connection import get_db
from ..utils.security import get_current_user_strict
from ..models.database import AuditLog
from ..services.audit_logger import audit_log as create_audit_log
from ..services.audit_logger import audit_log

router = APIRouter(tags=["Audit"])
DUBAI_TZ = ZoneInfo("Asia/Dubai")

class AuditCreateRequest(BaseModel):
    """Frontend audit log creation payload"""
    actor: str
    actor_id: Optional[str] = None
    actor_role: str = "user"
    module: str
    submodule: Optional[str] = None
    action: str
    resource_type: Optional[str] = None
    resource_id: Optional[str] = None
    resource_name: Optional[str] = None
    status: str = "success"
    details: Optional[Dict[str, Any]] = None

class AuditResponse(BaseModel):
    """Audit log response model"""
    id: int
    actor_id: Optional[str]
    actor_username: str
    actor_role: str
    module: str
    submodule: Optional[str]
    action: str
    resource_type: Optional[str]
    resource_id: Optional[str]
    resource_name: Optional[str]
    status: str
    details: Optional[Dict[str, Any]]
    ip_address: Optional[str]
    user_agent: Optional[str]
    created_at: datetime
    
    class Config:
        from_attributes = True

@router.post("/log", response_model=AuditResponse, status_code=201)
async def create_audit(
    payload: AuditCreateRequest,
    request: Request,
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db)
):
    """
    Frontend endpoint to log audit events.
    
    Called from any module when user performs action (navigate, create, update, delete, etc.)
    
    Example:
    POST /audit/log
    {
      "module": "Sessions",
      "submodule": null,
      "action": "terminate",
      "resource_type": "session",
      "resource_id": "sess_123",
      "resource_name": "User Session",
      "status": "success",
      "details": {"reason": "admin manual terminate"}
    }
    """
    # Extract server-side actor info if not provided
    actor_username = payload.actor or (current_user.get("username") if isinstance(current_user, dict) else getattr(current_user, "username", None))
    actor_id = payload.actor_id or (current_user.get("id") if isinstance(current_user, dict) else getattr(current_user, "id", None))
    
    # Determine role
    user_roles = current_user.get("roles", []) if isinstance(current_user, dict) else getattr(current_user, "roles", []) or []
    if isinstance(user_roles, str):
        user_roles = [user_roles]
    is_admin = "admin" in [r.lower() for r in user_roles]
    actor_role = payload.actor_role if payload.actor_role in ("user", "admin") else ("admin" if is_admin else "user")
    
    try:
        entry = create_audit_log(
            actor=actor_username,
            actor_id=actor_id,
            actor_role=actor_role,
            module=payload.module,
            submodule=payload.submodule,
            action=payload.action,
            resource_type=payload.resource_type,
            resource_id=payload.resource_id,
            resource_name=payload.resource_name,
            status=payload.status,
            details=payload.details,
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
            db=db
        )
        
        if not entry:
            raise HTTPException(status_code=500, detail="Failed to create audit log")
        
        return entry
    except Exception as e:
        print(f"[AUDIT] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/users", response_model=Dict[str, Any])
async def list_user_audits(
    module: Optional[str] = Query(None),
    action: Optional[str] = Query(None),
    resource_type: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=500),
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db)
):
    """
    Get audit logs for regular users (non-admin actions).
    
    Query filters:
      - module: filter by module name
      - action: filter by action type
      - resource_type: filter by resource type
      - page, size: pagination
    """
    # Only admins can view audit logs
    user_roles = current_user.get("roles", []) if isinstance(current_user, dict) else getattr(current_user, "roles", []) or []
    if isinstance(user_roles, str):
        user_roles = [user_roles]
    if "admin" not in [r.lower() for r in user_roles]:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    query = db.query(AuditLog).filter(AuditLog.actor_role != "admin")
    
    if module:
        query = query.filter(AuditLog.module == module)
    if action:
        query = query.filter(AuditLog.action == action)
    if resource_type:
        query = query.filter(AuditLog.resource_type == resource_type)
    
    total = query.count()
    items = query.order_by(AuditLog.created_at.desc()).offset((page-1)*size).limit(size).all()
    
    # # Audit log the action
    # audit_log(
    #     actor=current_user.get("username"),
    #     action="list_user_audits",
    #     module="Audit",
    #     actor_role=current_user.get("role"),
    #     resource_type="/audit/users",
    #     status="success",
    #     details={"viewed the audit logs for normal user module": module, "action": action, "resource_type": resource_type, "page": page, "size": size},
    #     db=db
    # )

    return {
        "page": page,
        "size": size,
        "total": total,
        "items": [AuditResponse.from_orm(item).dict() for item in items]
    }

@router.get("/admins", response_model=Dict[str, Any])
async def list_admin_audits(
    module: Optional[str] = Query(None),
    action: Optional[str] = Query(None),
    resource_type: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=500),
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db)
):
    """
    Get audit logs for admin actions only.
    
    Query filters: same as /users endpoint
    """
    # Only admins can view audit logs
    user_roles = current_user.get("roles", []) if isinstance(current_user, dict) else getattr(current_user, "roles", []) or []
    if isinstance(user_roles, str):
        user_roles = [user_roles]
    if "admin" not in [r.lower() for r in user_roles]:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    query = db.query(AuditLog).filter(AuditLog.actor_role == "admin")
    
    if module:
        query = query.filter(AuditLog.module == module)
    if action:
        query = query.filter(AuditLog.action == action)
    if resource_type:
        query = query.filter(AuditLog.resource_type == resource_type)
    
    total = query.count()
    items = query.order_by(AuditLog.created_at.desc()).offset((page-1)*size).limit(size).all()
    
    # # Audit log the action
    # audit_log(
    #     actor=current_user.get("username"),
    #     action="list_admin_audits",
    #     actor_role=current_user.get("role"),
    #     module="Audit",
    #     resource_type="/audit/admins",
    #     status="success",
    #     details={"viewed the audit logs for admin module": module, "action": action, "resource_type": resource_type, "page": page, "size": size},
    #     db=db
    # )

    return {
        "page": page,
        "size": size,
        "total": total,
        "items": [AuditResponse.from_orm(item).dict() for item in items]
    }

@router.get("/list", response_model=Dict[str, Any])
async def audit_summary(
    days: int = Query(7, ge=1, le=365),
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db)
):
    """
    Get summary stats of audit logs (last N days).
    
    Returns:
      - total_events: count of all events
      - user_events: count of user (non-admin) events
      - admin_events: count of admin events
      - top_modules: most active modules
      - top_actions: most common actions
    """
    # Only admins
    user_roles = current_user.get("roles", []) if isinstance(current_user, dict) else getattr(current_user, "roles", []) or []
    if isinstance(user_roles, str):
        user_roles = [user_roles]
    if "admin" not in [r.lower() for r in user_roles]:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    cutoff = datetime.now(DUBAI_TZ) - timedelta(days=days)
    query = db.query(AuditLog).filter(AuditLog.created_at >= cutoff)
    
    total = query.count()
    user_count = query.filter(AuditLog.actor_role == "user").count()
    admin_count = query.filter(AuditLog.actor_role == "admin").count()
    
    # Top modules (by event count)
    from sqlalchemy import func
    top_modules = db.query(AuditLog.module, func.count().label("count")) \
        .filter(AuditLog.created_at >= cutoff) \
        .group_by(AuditLog.module) \
        .order_by(func.count().desc()) \
        .limit(10).all()
    
    # Top actions
    top_actions = db.query(AuditLog.action, func.count().label("count")) \
        .filter(AuditLog.created_at >= cutoff) \
        .group_by(AuditLog.action) \
        .order_by(func.count().desc()) \
        .limit(10).all()
    
    # Audit log the action
    # audit_log(
    #     actor=current_user.get("username"),
    #     action="audit_summary",
    #     actor_role=current_user.get("role"),
    #     module="Audit",
    #     resource_type="/audit/list",
    #     status="success",
    #     details={"viewed the audit summary for the last N days": days},
    #     db=db
    # )

    return {
        "period_days": days,
        "total_events": total,
        "user_events": user_count,
        "admin_events": admin_count,
        "top_modules": [{"module": m, "count": c} for m, c in top_modules],
        "top_actions": [{"action": a, "count": c} for a, c in top_actions]
    }

@router.get("/export", response_model=List[AuditResponse])
async def export_audits(
    actor_role: Optional[str] = Query(None),
    module: Optional[str] = Query(None),
    days: int = Query(7, ge=1, le=365),
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db)
):
    """
    Export audit logs as JSON (useful for reporting, compliance, archival).
    """
    # Only admins
    user_roles = current_user.get("roles", []) if isinstance(current_user, dict) else getattr(current_user, "roles", []) or []
    if isinstance(user_roles, str):
        user_roles = [user_roles]
    if "admin" not in [r.lower() for r in user_roles]:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    cutoff = datetime.now(DUBAI_TZ) - timedelta(days=days)
    query = db.query(AuditLog).filter(AuditLog.created_at >= cutoff)
    
    if actor_role:
        query = query.filter(AuditLog.actor_role == actor_role)
    if module:
        query = query.filter(AuditLog.module == module)
    
    # Audit log the action
    audit_log(
        actor=current_user.get("username"),
        action="export_audits",
        actor_role=current_user.get("role"),
        resource_type="/audit/export",
        status="success",
        details={"exported audit logs": True, "actor_role": actor_role, "module": module, "days": days},
        db=db
    )

    items = query.order_by(AuditLog.created_at.desc()).all()
    return [AuditResponse.from_orm(item) for item in items]