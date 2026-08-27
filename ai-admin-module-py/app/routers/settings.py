from fastapi import APIRouter, HTTPException, Depends
from pathlib import Path
import json
import logging
import threading
from typing import Dict, Any
from pydantic import BaseModel, Field

from ..config import settings, AiConfigModel
from ..database.connection import get_db
from sqlalchemy.orm import Session
from ..utils.security import get_current_user_strict
from ..services.audit_logger import audit_log

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Settings"])
_CONFIG_PATH: Path = Path(__file__).resolve().parent.parent / "config.json"
_ENV_PATH: Path = Path(__file__).resolve().parent.parent / "environment.json"
_FILE_LOCK = threading.Lock()


class EnvironmentConfigModel(BaseModel):
    SOLUTIONS_API_AUTH_TOKEN: str = Field(default="")

def _ensure_admin(current_user: dict) -> None:
    roles = current_user.get("roles", []) if isinstance(current_user, dict) else []
    if isinstance(roles, str):
        roles = [roles]
    if "admin" not in [r.lower() for r in roles]:
        raise HTTPException(status_code=403, detail="Admin access required")

def _read_raw() -> Dict[str, Any]:
    if not _CONFIG_PATH.exists():
        default = settings.ai_config.model_dump()
        _CONFIG_PATH.write_text(json.dumps(default, indent=2, ensure_ascii=False), encoding="utf-8")
        return default
    text = _CONFIG_PATH.read_text(encoding="utf-8")
    try:
        return json.loads(text)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to parse config.json: {e}")

def _write_raw(obj: Dict[str, Any]) -> None:
    _CONFIG_PATH.write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")


def _publish(raw: Dict[str, Any]) -> AiConfigModel:
    """Validate `raw` and make it the process-wide ai_config.

    The publish step is the point of this function. Before it existed, GET
    handed config.json to the browser and left settings.ai_config holding the
    defaults from config.py -- so the frontend and this backend read two
    different configurations. The frontend followed the file; services/
    automation/llm.py resolved ai_config.BASE_URL and ENDPOINTS.chatStream
    against values baked into source. The two agreed only for as long as
    nobody edited the file, and nothing said so when they stopped.

    That matters most for the Automation module: LLM_PROVIDER=ai_service sends
    its prompts to ai_config.BASE_URL, so a stale in-memory copy points the
    module at a different AI service than the one the Settings screen shows.
    """
    model = AiConfigModel.model_validate(raw)
    settings.ai_config = model
    return model


def load_ai_config_from_disk() -> bool:
    """Populate settings.ai_config from config.json. Called once at startup.

    Read-only and quiet when the file is absent: a fresh container ships
    without one (.dockerignore excludes it) until the first GET writes it, and
    the defaults in config.py are correct for production anyway. Creating it
    here would also mean writing a file as an import-time side effect, which
    tests should not have to work around.

    Never raises. A malformed config.json must not stop the app booting -- the
    same parse error still surfaces with a proper status code on the next GET.
    """
    try:
        with _FILE_LOCK:
            if not _CONFIG_PATH.exists():
                logger.info(
                    "No config.json at %s; ai_config keeps the defaults from "
                    "config.py", _CONFIG_PATH
                )
                return False
            raw = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
        _publish(raw)
        logger.info(
            "Loaded ai_config from %s (BASE_URL=%s)",
            _CONFIG_PATH,
            settings.ai_config.BASE_URL,
        )
        return True
    except Exception as exc:  # noqa: BLE001 - booting matters more than this
        logger.error(
            "Could not load %s: %s. ai_config keeps the defaults from config.py.",
            _CONFIG_PATH,
            exc,
        )
        return False


def _read_env_raw() -> Dict[str, Any]:
    if not _ENV_PATH.exists():
        default = {"SOLUTIONS_API_AUTH_TOKEN": settings.SOLUTIONS_API_AUTH_TOKEN}
        _ENV_PATH.write_text(json.dumps(default, indent=2, ensure_ascii=False), encoding="utf-8")
        return default
    text = _ENV_PATH.read_text(encoding="utf-8")
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
        return {"SOLUTIONS_API_AUTH_TOKEN": ""}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to parse environment.json: {e}")


def _write_env_raw(obj: Dict[str, Any]) -> None:
    _ENV_PATH.write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")

@router.get("/ai-config", response_model=AiConfigModel)
def get_ai_config(
    current_user: dict = Depends(get_current_user_strict),
    db: Session = Depends(get_db)
):
    # temporarily disable logging to capture from frontend

    # # Log the action
    # audit_log(
    #     actor=current_user.get("username"),
    #     action="get AI config",
    #     actor_role=current_user.get("role"),
    #     module="Settings",
    #     resource_name="Settings",
    #     resource_id="get AI configuration",
    #     resource_type="tab",
    #     status="success",
    #     details={"backend endpoint called to get the AI config": True}
    # )

    """Any authenticated user: read AI config (from app/config.json)."""
    # allow all authenticated users (no admin check)
    with _FILE_LOCK:
        raw = _read_raw()
    try:
        # Publish, don't just return: this is the only read that happens after
        # an out-of-band edit to config.json (a bind-mounted file changed on
        # the host, say), so it is where the backend's own copy catches up.
        return _publish(raw)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Invalid config format: {e}")

@router.put("/ai-config", response_model=AiConfigModel)
def update_ai_config(
    payload: AiConfigModel,
    current_user: dict = Depends(get_current_user_strict),
    db: Session = Depends(get_db)
):
    # temporarily disable logging to capture from frontend
    
    # # Log the action
    # audit_log(
    #     actor=current_user.get("username"),
    #     action="update AI config",
    #     actor_role=current_user.get("role"),
    #     module="Settings",
    #     resource_name="Settings",
    #     resource_id="update AI configuration",
    #     resource_type="tab",
    #     status="success",
    #     details={"backend endpoint called to update the AI config": True}
    # )

    """Admin-only: update AI config (persist to app/config.json)."""
    _ensure_admin(current_user)
    obj = payload.model_dump()
    with _FILE_LOCK:
        _write_raw(obj)
        # update in-memory settings as source of truth for runtime
        settings.ai_config = payload
    return payload


@router.get("/environment", response_model=EnvironmentConfigModel)
def get_environment_config(
    current_user: dict = Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    with _FILE_LOCK:
        raw = _read_env_raw()

    model = EnvironmentConfigModel.model_validate(raw)
    settings.SOLUTIONS_API_AUTH_TOKEN = model.SOLUTIONS_API_AUTH_TOKEN
    return model


@router.put("/environment", response_model=EnvironmentConfigModel)
def update_environment_config(
    payload: EnvironmentConfigModel,
    current_user: dict = Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    _ensure_admin(current_user)
    obj = payload.model_dump()
    with _FILE_LOCK:
        _write_env_raw(obj)

    settings.SOLUTIONS_API_AUTH_TOKEN = payload.SOLUTIONS_API_AUTH_TOKEN
    return payload