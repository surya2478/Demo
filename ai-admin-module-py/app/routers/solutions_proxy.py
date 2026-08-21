from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session
import requests

from ..config import settings
from ..database.connection import get_db
from ..utils.security import get_current_user_strict


router = APIRouter(tags=["Solutions Proxy"])


def _get_solutions_base_url() -> str:
    base_url = (settings.SOLUTIONS_API_BASE_URL or "").strip().rstrip("/")
    if not base_url:
        raise HTTPException(
            status_code=500,
            detail="SOLUTIONS_API_BASE_URL is not configured on the backend",
        )
    return base_url


def _forward_auth_header() -> dict:
    headers = {"Accept": "application/json"}
    token = (settings.SOLUTIONS_API_AUTH_TOKEN or "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


@router.post("/solutions/search")
def proxy_solution_search(
    payload: dict,
    current_user: dict = Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    target_url = f"{_get_solutions_base_url()}/api/solutions/search"
    try:
        response = requests.post(
            target_url,
            json=payload,
            headers={**_forward_auth_header(), "Content-Type": "application/json"},
            timeout=settings.SOLUTIONS_API_TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Solutions search proxy failed: {exc}")

    content_type = response.headers.get("content-type", "application/json")
    if "application/json" in content_type.lower():
        try:
            return JSONResponse(content=response.json(), status_code=response.status_code)
        except ValueError:
            pass

    return Response(content=response.content, status_code=response.status_code, media_type=content_type)


@router.get("/solutions/files/{storage_key}/content")
def proxy_solution_file_content(
    storage_key: str,
    current_user: dict = Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    target_url = f"{_get_solutions_base_url()}/api/solutions/files/{storage_key}/content"
    try:
        response = requests.get(
            target_url,
            headers=_forward_auth_header(),
            timeout=settings.SOLUTIONS_API_TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Solutions file proxy failed: {exc}")

    content_type = response.headers.get("content-type", "text/plain; charset=utf-8")
    if "application/json" in content_type.lower():
        try:
            return JSONResponse(content=response.json(), status_code=response.status_code)
        except ValueError:
            pass

    return Response(content=response.content, status_code=response.status_code, media_type=content_type)