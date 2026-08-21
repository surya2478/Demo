from datetime import datetime
from zoneinfo import ZoneInfo
from typing import Any, Dict, Optional
from sqlalchemy.orm import Session
from ..models.database import AuditLog

DUBAI_TZ = ZoneInfo("Asia/Dubai")

def audit_log(
    actor: str,
    actor_id: Optional[str] = None,
    actor_role: str = "user",
    module: str = "Unknown",
    submodule: Optional[str] = None,
    action: str = "unknown",
    resource: Optional[str] = None,  # backward compat
    resource_type: Optional[str] = None,
    resource_id: Optional[str] = None,
    resource_name: Optional[str] = None,
    status: str = "success",
    details: Optional[Dict[str, Any]] = None,
    ip_address: Optional[str] = None,
    user_agent: Optional[str] = None,
    db: Optional[Session] = None
) -> Optional[AuditLog]:
    """
    Log an audit entry with Dubai timezone support.
    
    Args:
        actor: username of actor
        actor_id: user id (optional)
        actor_role: "user" or "admin"
        module: main module name (e.g., "Sessions", "Test Assistant")
        submodule: sub-section (e.g., "Test Cases")
        action: action type (e.g., "navigate", "create", "update", "delete")
        resource: backward compat (maps to resource_type if resource_type not set)
        resource_type: type of resource affected
        resource_id: ID of resource
        resource_name: human-readable name of resource
        status: "success", "failure", "warning"
        details: dict with contextual data (before/after, error, reason)
        ip_address: client IP
        user_agent: client user agent
        db: SQLAlchemy session (if None, will try to get from dependency)
    
    Returns:
        AuditLog entry if successful, None on error
    """
    if details is None:
        details = {}
    
    # Backward compat: resource -> resource_type
    if resource and not resource_type:
        resource_type = resource
    
    try:
        # If no DB session provided, get from dependency
        if db is None:
            from ..database.connection import get_db
            db = next(get_db())
            should_close = True
        else:
            should_close = False
        
        ts = datetime.now(DUBAI_TZ)
        
        entry = AuditLog(
            actor_id=actor_id,
            actor_username=actor,
            actor_role=actor_role,
            module=module,
            submodule=submodule,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            resource_name=resource_name,
            status=status,
            details=details,
            ip_address=ip_address,
            user_agent=user_agent,
            created_at=ts
        )
        
        db.add(entry)
        db.commit()
        db.refresh(entry)
        
        print(f"[AUDIT] {ts} | {actor_role.upper()} {actor} | {module}/{action} | {resource_type}:{resource_id} | {status}")
        
        return entry
    
    except Exception as e:
        print(f"[AUDIT ERROR] Failed to log audit entry: {e}")
        import traceback
        traceback.print_exc()
        return None
    
    finally:
        if should_close and db:
            try:
                db.close()
            except:
                pass