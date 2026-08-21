from fastapi import APIRouter, HTTPException, Depends
import threading
from typing import Any

from ..config import settings, AiConfigModel  # use the model and settings from config.py
from ..database.connection import get_db
from sqlalchemy.orm import Session
from ..utils.security import get_current_user_strict

router = APIRouter(tags=["Config"])
_FILE_LOCK = threading.Lock()

def _ensure_admin(current_user: dict) -> None:
    roles = current_user.get("roles", []) if isinstance(current_user, dict) else []
    if isinstance(roles, str):
        roles = [roles]
    if "admin" not in [r.lower() for r in roles]:
        raise HTTPException(status_code=403, detail="Admin access required")

@router.get("/settings/ai-config", response_model=AiConfigModel)
def get_ai_config(
    current_user: dict = Depends(get_current_user_strict),
    db: Session = Depends(get_db)
):
    _ensure_admin(current_user)
    # return typed ai_config from settings
    return settings.ai_config

@router.put("/settings/ai-config", response_model=AiConfigModel)
def update_ai_config(
    payload: AiConfigModel,
    current_user: dict = Depends(get_current_user_strict),
    db: Session = Depends(get_db)
):
    _ensure_admin(current_user)
    # update in-memory settings; if you want persistence also write to file here
    with _FILE_LOCK:
        settings.ai_config = payload
    return settings.ai_config