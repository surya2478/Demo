from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..database.connection import get_db
from ..models.database import TestCaseWorkflowStage
from ..utils.security import get_current_user_strict

router = APIRouter()

WORKFLOW_STAGES = (
    'PROCESS_DOCUMENT',
    'GENERATE_TEST_CASES',
    'REVIEW_APPROVAL',
    'AUTOMATION_REVIEW',
    'AUTOMATION_EXECUTION',
)
VALID_STATUSES = {'PENDING', 'ACTIVE', 'COMPLETED'}


def update_workflow_stage(
    db: Session,
    stage_request_id: str,
    stage: str,
    status: str,
    document_name: str | None = None,
) -> None:
    if not stage_request_id or stage not in WORKFLOW_STAGES or status not in VALID_STATUSES:
        return
    record = db.query(TestCaseWorkflowStage).filter(
        TestCaseWorkflowStage.stage_request_id == stage_request_id,
        TestCaseWorkflowStage.stage == stage,
    ).first()
    if record is None:
        record = TestCaseWorkflowStage(stage_request_id=stage_request_id, stage=stage, status=status)
        db.add(record)
    else:
        record.status = status
    if document_name:
        record.document_name = document_name
    record.updated_at = datetime.utcnow()


def initialize_workflow(db: Session, stage_request_id: str, document_name: str | None, statuses: dict[str, str]) -> None:
    for stage in WORKFLOW_STAGES:
        update_workflow_stage(db, stage_request_id, stage, statuses.get(stage, 'PENDING'), document_name)


@router.post('/{stage_request_id}/start')
def start_workflow(
    stage_request_id: str,
    payload: dict[str, Any],
    current_user: dict = Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    initialize_workflow(
        db,
        stage_request_id,
        str(payload.get('document_name') or '').strip() or None,
        {str(stage).upper(): str(status).upper() for stage, status in (payload.get('stages') or {}).items()},
    )
    db.commit()
    return {'success': True, 'stage_request_id': stage_request_id}


@router.get('/{stage_request_id}')
def get_workflow(
    stage_request_id: str,
    current_user: dict = Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    records = db.query(TestCaseWorkflowStage).filter(
        TestCaseWorkflowStage.stage_request_id == stage_request_id,
    ).all()
    by_stage = {record.stage: record for record in records}
    return {
        'stage_request_id': stage_request_id,
        'document_name': next((record.document_name for record in records if record.document_name), ''),
        'stages': [
            {
                'stage': stage,
                'status': by_stage[stage].status if stage in by_stage else 'PENDING',
                'updated_at': by_stage[stage].updated_at.isoformat() if stage in by_stage else None,
            }
            for stage in WORKFLOW_STAGES
        ],
    }


@router.put('/{stage_request_id}/{stage}')
def set_workflow_stage(
    stage_request_id: str,
    stage: str,
    payload: dict[str, Any],
    current_user: dict = Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    normalized_stage = stage.upper()
    status = str(payload.get('status') or '').upper()
    if normalized_stage not in WORKFLOW_STAGES or status not in VALID_STATUSES:
        raise HTTPException(status_code=422, detail='Invalid workflow stage or status')
    update_workflow_stage(db, stage_request_id, normalized_stage, status, str(payload.get('document_name') or '').strip() or None)
    db.commit()
    return {'success': True}
