from typing import Any, Dict, List, Optional
from sqlalchemy.orm import Session
from sqlalchemy import func
from ..models.database import AuditLog
from ..database.connection import get_db

def create_audit_entry(db: Session, payload: Dict[str, Any]) -> AuditLog:
    """
    Persist audit log to DB. Expects payload keys matching AuditLog columns.
    """
    entry = AuditLog(
        actor_id = payload.get("actor_id"),
        actor_username = payload.get("actor_username") or payload.get("actor") or payload.get("username"),
        actor_role = payload.get("actor_role", "user"),
        module = payload.get("module", "Unknown"),
        submodule = payload.get("submodule"),
        action = payload.get("action", "unknown"),
        resource_type = payload.get("resource_type"),
        resource_id = payload.get("resource_id"),
        resource_name = payload.get("resource_name"),
        status = payload.get("status", "success"),
        details = payload.get("details"),
        ip_address = payload.get("ip_address"),
        user_agent = payload.get("user_agent"),
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry

def list_audits(db: Session, *, role: Optional[str]=None, module: Optional[str]=None,
                action: Optional[str]=None, page: int = 1, size: int = 50) -> Dict[str, Any]:
    q = db.query(AuditLog)
    if role:
        q = q.filter(func.lower(AuditLog.actor_role) == role.lower())
    if module:
        q = q.filter(AuditLog.module == module)
    if action:
        q = q.filter(AuditLog.action == action)
    total = q.count()
    items = q.order_by(AuditLog.created_at.desc()).offset((page-1)*size).limit(size).all()
    return {"total": total, "page": page, "size": size, "items": items}

# helper to be used where get_db dependency is available
def append_audit_from_payload(payload: Dict[str, Any]) -> Optional[AuditLog]:
    db_iter = get_db()
    db = next(db_iter)
    try:
        return create_audit_entry(db, payload)
    finally:
        try:
            db.close()
        except Exception:
            pass