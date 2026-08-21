from __future__ import annotations
from pydantic import BaseModel
from typing import Optional, Dict, Any
from datetime import datetime

class AuditLog(BaseModel):
    timestamp: datetime
    actor: str
    action: str
    resource: str
    status: str
    details: Optional[Dict[str, Any]] = {}
    ip: Optional[str] = None

    model_config = {
        "json_schema_extra": {
            "example": {
                "timestamp": "2025-10-30T03:05:26Z",
                "actor": "admin",
                "action": "login",
                "resource": "auth",
                "status": "success",
                "details": {},
                "ip": "127.0.0.1"
            }
        }
    }