"""
--- Projects ---------------------------------------------------------------------

The project test cases are generated for: a PPM ID and a name. Chosen on
Generate Test Cases and carried through AI Checks, approval and Automation
Studio. Any signed-in user can create one or pick an existing one -- projects
are shared, so everyone who opens a PPM ID works on the same record.
"""
from __future__ import annotations

import re
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from ..database.connection import get_db
from ..models.database import Project
from ..utils.security import get_current_user_strict

router = APIRouter()


class ProjectIn(BaseModel):
    ppm_id: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=255)


def normalize_ppm_id(value: str) -> str:
    """One spelling per PPM ID: trimmed, upper case, inner spaces as hyphens."""
    return re.sub(r"\s+", "-", str(value or "").strip()).upper()


def serialize_project(project: Optional[Project]) -> Optional[dict[str, Any]]:
    if project is None:
        return None
    return {
        "id": project.id,
        "ppm_id": project.ppm_id,
        "name": project.name,
        "created_by": project.created_by,
        "created_at": project.created_at.isoformat() if project.created_at else None,
    }


def _actor(user: dict) -> str:
    return (user or {}).get("username") or (user or {}).get("sub") or "user"


@router.get("")
def list_projects(
    q: Optional[str] = Query(default=None, max_length=100),
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user_strict),
):
    query = db.query(Project)
    if q and q.strip():
        like = f"%{q.strip().lower()}%"
        query = query.filter(or_(func.lower(Project.ppm_id).like(like), func.lower(Project.name).like(like)))
    items = query.order_by(Project.updated_at.desc()).limit(limit).all()
    return {"items": [serialize_project(item) for item in items]}


@router.get("/by-ppm/{ppm_id}")
def get_by_ppm(
    ppm_id: str,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user_strict),
):
    project = db.query(Project).filter(Project.ppm_id == normalize_ppm_id(ppm_id)).first()
    if project is None:
        raise HTTPException(status_code=404, detail="No project with that PPM ID.")
    return serialize_project(project)


@router.get("/{project_id}")
def get_project(
    project_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user_strict),
):
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    return serialize_project(project)


@router.post("")
def create_or_open_project(
    body: ProjectIn,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user_strict),
):
    """Create a project, or open the one that already has this PPM ID.

    An existing PPM ID keeps its name: someone else may be working under it,
    and a rename here would change it under them. ``existing`` says which
    happened, so the page can tell the author.
    """
    ppm_id = normalize_ppm_id(body.ppm_id)
    name = body.name.strip()
    if not ppm_id or not name:
        raise HTTPException(status_code=400, detail="PPM ID and Project Name are both needed.")
    project = db.query(Project).filter(Project.ppm_id == ppm_id).first()
    if project is not None:
        return {**serialize_project(project), "existing": True}
    project = Project(ppm_id=ppm_id, name=name, created_by=_actor(current_user))
    db.add(project)
    db.commit()
    db.refresh(project)
    return {**serialize_project(project), "existing": False}


@router.put("/{project_id}")
def rename_project(
    project_id: int,
    body: ProjectIn,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user_strict),
):
    """Correct a project's name. The PPM ID is its identity and stays."""
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    if normalize_ppm_id(body.ppm_id) != project.ppm_id:
        raise HTTPException(status_code=409, detail="A project's PPM ID cannot be changed.")
    project.name = body.name.strip()
    db.commit()
    return serialize_project(project)
