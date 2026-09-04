from typing import Any, Dict, List, Optional
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..database.connection import get_db
from ..models.database import TestCaseReview, TestCaseReviewDetail, TestCaseDetail
from ..utils.security import get_current_user_strict

logger = logging.getLogger(__name__)

router = APIRouter()

DUBAI_TZ = ZoneInfo("Asia/Dubai")


def _dubai_now() -> datetime:
    """Current Dubai time as a naive datetime (matches naive DB columns)."""
    return datetime.now(DUBAI_TZ).replace(tzinfo=None)


def _to_dubai(value: Any) -> Optional[datetime]:
    """Parse an ISO timestamp (UTC or naive) and convert to naive Dubai time."""
    if value is None:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        except ValueError:
            return None
    if parsed.tzinfo is not None:
        return parsed.astimezone(DUBAI_TZ).replace(tzinfo=None)
    # Naive input is assumed to already be Dubai-local
    return parsed


def _get_document_id(payload: Dict[str, Any], request_id: str) -> str:
    document_id = str(payload.get('document_id') or '').strip()
    if document_id:
        return document_id

    input_type = str((payload.get('payload') or {}).get('inputType') or '').lower()
    if input_type == 'text':
        return f'input_text_{_dubai_now().strftime("%Y%m%d%H%M%S")}'
    if input_type == 'e2e-spark':
        return 'e2e_spark'

    documents = payload.get('brd_document') or payload.get('documents') or []
    names = [str(item.get('name')).strip() for item in documents if isinstance(item, dict) and item.get('name')]
    return ' | '.join(names) or f'DOC-{request_id}'


def _serialize_review(review: TestCaseReview) -> Dict[str, Any]:
    return {
        'id': review.id,
        'submitted_by': review.submitted_by,
        'status': review.status,
        'payload': review.payload or {},
        'documents': review.documents or [],
        'review_notes': review.review_notes,
        'reviewed_by': review.reviewed_by,
        'reviewed_at': review.reviewed_at.isoformat() if review.reviewed_at else None,
        'created_at': review.created_at.isoformat() if review.created_at else None,
        'updated_at': review.updated_at.isoformat() if review.updated_at else None,
    }


def _serialize_review_detail(review_detail: TestCaseReviewDetail) -> Dict[str, Any]:
    document_id = next(
        (test_case.document_id for test_case in review_detail.test_cases if test_case.document_id),
        None,
    )
    return {
        'request_id': review_detail.request_id,
        'document_id': document_id,
        'source': review_detail.source,
        'request_by': review_detail.request_by,
        'request_date_time': review_detail.request_date_time.isoformat() if review_detail.request_date_time else None,
        'brd_document': review_detail.brd_document,
        'no_of_test_cases': review_detail.no_of_test_cases,
        'approved_count': review_detail.approved_count,
        'rejected_count': review_detail.rejected_count,
        'overall_status': review_detail.overall_status,
        'review_notes': review_detail.review_notes,
        'reviewed_by': review_detail.reviewed_by,
        'reviewed_date_time': review_detail.reviewed_date_time.isoformat() if review_detail.reviewed_date_time else None,
    }


def _serialize_test_case_detail(test_case_detail: TestCaseDetail) -> Dict[str, Any]:
    return {
        'test_case_id': test_case_detail.test_case_id,
        'request_id': test_case_detail.request_id,
        'document_id': test_case_detail.document_id,
        'test_case_details': test_case_detail.test_case_details,
        'status': test_case_detail.status,
        'rejection_reason': test_case_detail.rejection_reason,
        'reviewed_by': test_case_detail.reviewed_by,
        'reviewed_datetime': test_case_detail.reviewed_datetime.isoformat() if test_case_detail.reviewed_datetime else None,
        'generated_by': test_case_detail.generated_by,
    }


@router.get("/approved/documents")
async def list_approved_document_ids(
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    """List distinct document IDs belonging to fully approved review requests."""
    approved_request_ids = (
        db.query(TestCaseReviewDetail.request_id)
        .filter(TestCaseReviewDetail.overall_status == 'APPROVED')
        .subquery()
    )
    rows = (
        db.query(TestCaseDetail.document_id)
        .filter(TestCaseDetail.request_id.in_(approved_request_ids), TestCaseDetail.document_id.isnot(None), TestCaseDetail.document_id != '')
        .distinct()
        .all()
    )
    return {'items': sorted([row[0] for row in rows if row[0]])}


@router.get("/approved/request/{request_id}")
async def get_approved_test_cases_by_request(
    request_id: str,
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    """Retrieve test cases for a fully approved review request."""
    if not request_id or not request_id.strip():
        raise HTTPException(status_code=422, detail='request_id is required')

    detail = db.query(TestCaseReviewDetail).filter(TestCaseReviewDetail.request_id == request_id).first()
    if not detail:
        raise HTTPException(status_code=404, detail='Review request not found')
    if detail.overall_status != 'APPROVED':
        raise HTTPException(status_code=409, detail='Review request is not fully approved')

    test_cases = db.query(TestCaseDetail).filter(TestCaseDetail.request_id == request_id).all()
    return {'items': [_serialize_test_case_detail(item) for item in test_cases]}


@router.get("/approved/{document_id}")
async def get_approved_test_cases_by_document(
    document_id: str,
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    """Retrieve test cases for a document from fully approved review requests. document_id is mandatory."""
    if not document_id or not document_id.strip():
        raise HTTPException(status_code=422, detail='document_id is required')

    test_cases = (
        db.query(TestCaseDetail)
        .join(TestCaseReviewDetail, TestCaseDetail.request_id == TestCaseReviewDetail.request_id)
        .filter(TestCaseReviewDetail.overall_status == 'APPROVED', TestCaseDetail.document_id == document_id)
        .all()
    )
    return {'items': [_serialize_test_case_detail(item) for item in test_cases]}

# Function to create a review submission in the database
def create_review_submission(
    payload: Dict[str, Any],
    current_user: Dict[str, Any],
    db: Session,
) -> Dict[str, Any]:
    username = (current_user or {}).get('username') or (current_user or {}).get('sub') or 'system'

    request_id = str(payload.get('request_id') or payload.get('id') or f"REQ-{_dubai_now().strftime('%Y%m%d%H%M%S%f')}")
    request_by = str(payload.get('request_by') or username)
    request_date_time = _to_dubai(payload.get('request_date_time')) or _dubai_now()

    rows_payload = payload.get('rows') or (payload.get('payload') or {}).get('rows') or []
    documents_payload = payload.get('brd_document') or payload.get('documents') or []

    # One document_id shared by every test case in this request
    document_id = _get_document_id(payload, request_id)

    detail = TestCaseReviewDetail(
        request_id=request_id,
        source=str(payload.get('source') or (payload.get('payload') or {}).get('source_type') or '').strip() or None,
        request_by=request_by,
        request_date_time=request_date_time,
        brd_document=documents_payload,
        no_of_test_cases=len(rows_payload),
        approved_count=0,
        rejected_count=0,
        overall_status='PENDING_REVIEW',
        review_notes=payload.get('review_notes'),
        reviewed_by=None,
        reviewed_date_time=None,
    )
    db.add(detail)

    for row_index, row in enumerate(rows_payload):
        test_case_payload = row.get('test_case_details') if isinstance(row, dict) and 'test_case_details' in row else row
        if not isinstance(test_case_payload, dict):
            test_case_payload = {'content': str(row)}

        test_case_id = str(row.get('test_case_id') if isinstance(row, dict) else row.get('id') or f"TC-{row_index + 1}")
        if not test_case_id:
            test_case_id = f"TC-{request_id}-{row_index + 1}"

        test_case = TestCaseDetail(
            test_case_id=test_case_id,
            request_id=request_id,
            document_id=document_id,
            test_case_details=test_case_payload,
            status='PENDING',
            rejection_reason=None,
            reviewed_by=None,
            reviewed_datetime=None,
            generated_by=request_by,
        )
        db.add(test_case)

    db.commit()
    db.refresh(detail)
    return {'success': True, 'data': _serialize_review_detail(detail), 'request_id': request_id}

# Endpoint to submit a review for approval
@router.post("/submit")
async def submit_for_approval(
    payload: Dict[str, Any],
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    return create_review_submission(payload, current_user, db)

# Endpoint to create a review detail
@router.post("/detail")
async def create_review_detail(
    payload: Dict[str, Any],
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    request_id = str(payload.get('request_id') or payload.get('id') or '')
    if not request_id:
        raise HTTPException(status_code=400, detail='request_id is required')

    detail = TestCaseReviewDetail(
        request_id=request_id,
        source=str(payload.get('source') or (payload.get('payload') or {}).get('source_type') or '').strip() or None,
        request_by=str(payload.get('request_by') or (current_user or {}).get('username') or 'system'),
        request_date_time=_to_dubai(payload.get('request_date_time')) or _dubai_now(),
        brd_document=payload.get('brd_document'),
        no_of_test_cases=int(payload.get('no_of_test_cases') or 0),
        approved_count=int(payload.get('approved_count') or 0),
        rejected_count=int(payload.get('rejected_count') or 0),
        overall_status=str(payload.get('overall_status') or 'PENDING_REVIEW').upper(),
        review_notes=payload.get('review_notes'),
        reviewed_by=payload.get('reviewed_by'),
        reviewed_date_time=payload.get('reviewed_date_time') or None,
    )
    db.add(detail)
    db.commit()
    db.refresh(detail)
    return {'success': True, 'data': _serialize_review_detail(detail)}

# Helper function to enforce that the current user has manager access
def _require_review_manager(current_user: Dict[str, Any]) -> None:
    user_roles = (current_user or {}).get('roles') or []
    if isinstance(user_roles, str):
        user_roles = [user_roles]
    if 'admin' not in user_roles and 'manager' not in user_roles:
        raise HTTPException(status_code=403, detail='Manager access required')

# Helper function to determine the cutoff datetime for recent reviews
def _recent_cutoff() -> datetime:
    return _dubai_now() - timedelta(minutes=5)

# Helper function to serialize approved review details into a dictionary
def _serialize_approved_review_details(details: List[TestCaseReviewDetail]) -> Dict[str, Any]:
    return {'items': [_serialize_review_detail(detail) for detail in details]}

# Endpoint to list current review details
@router.get("/details/current")
async def list_current_review_details(
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    _require_review_manager(current_user)
    details = (
        db.query(TestCaseReviewDetail)
        .filter(
            TestCaseReviewDetail.request_date_time >= _recent_cutoff(),
            ~TestCaseReviewDetail.request_id.like('ADO-%'),
        )
        .order_by(TestCaseReviewDetail.request_date_time.desc())
        .all()
    )
    return {'items': [_serialize_review_detail(detail) for detail in details]}

# Endpoint to list ADO review details
@router.get("/details/ado")
async def list_ado_review_details(
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    _require_review_manager(current_user)
    local_details = (
        db.query(TestCaseReviewDetail)
        .filter(TestCaseReviewDetail.request_id.like('ADO-%'))
        .order_by(TestCaseReviewDetail.request_date_time.desc())
        .all()
    )
    return {'items': [_serialize_review_detail(detail) for detail in local_details]}


# Endpoint to list historical review details
@router.get("/details/history")
async def list_review_history(
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    _require_review_manager(current_user)
    details = (
        db.query(TestCaseReviewDetail)
        .filter(
            TestCaseReviewDetail.request_date_time < _recent_cutoff(),
            ~TestCaseReviewDetail.request_id.like('ADO-%'),
        )
        .order_by(TestCaseReviewDetail.request_date_time.desc())
        .all()
    )
    return {'items': [_serialize_review_detail(detail) for detail in details]}


# Endpoint to list recent approved review details
@router.get("/approved/details/current")
async def list_recent_approved_review_details(
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    _require_review_manager(current_user)
    details = (
        db.query(TestCaseReviewDetail)
        .filter(
            TestCaseReviewDetail.overall_status == 'APPROVED',
            TestCaseReviewDetail.reviewed_date_time >= _recent_cutoff(),
            ~TestCaseReviewDetail.request_id.like('ADO-%'),
        )
        .order_by(TestCaseReviewDetail.reviewed_date_time.desc())
        .all()
    )
    return _serialize_approved_review_details(details)


# Endpoint to list ADO approved review details
@router.get("/approved/details/ado")
async def list_ado_approved_review_details(
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    _require_review_manager(current_user)
    details = (
        db.query(TestCaseReviewDetail)
        .filter(TestCaseReviewDetail.overall_status == 'APPROVED', TestCaseReviewDetail.source.in_(['ADO', 'AZURE_DEVOPS']))
        .order_by(TestCaseReviewDetail.request_date_time.desc())
        .all()
    )
    return _serialize_approved_review_details(details)


# Endpoint to list historical approved review details
@router.get("/approved/details/history")
async def list_approved_review_history(
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    _require_review_manager(current_user)
    details = (
        db.query(TestCaseReviewDetail)
        .filter(
            TestCaseReviewDetail.overall_status == 'APPROVED',
            TestCaseReviewDetail.reviewed_date_time < _recent_cutoff(),
            ~TestCaseReviewDetail.request_id.like('ADO-%'),
        )
        .order_by(TestCaseReviewDetail.reviewed_date_time.desc())
        .all()
    )
    return _serialize_approved_review_details(details)

## Endpoint to list all review details
@router.get("/details")
async def list_review_details(
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    _require_review_manager(current_user)

    details = db.query(TestCaseReviewDetail).order_by(TestCaseReviewDetail.request_date_time.desc()).all()
    return {'items': [_serialize_review_detail(detail) for detail in details]}

# Endpoint to get review detail by request ID
@router.get("/detail/{request_id}")
async def get_review_detail_by_request_id(
    request_id: str,
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    detail = db.query(TestCaseReviewDetail).filter(TestCaseReviewDetail.request_id == request_id).first()
    if not detail:
        raise HTTPException(status_code=404, detail='Review request not found')

    test_cases = db.query(TestCaseDetail).filter(TestCaseDetail.request_id == request_id).all()
    return {
        'data': _serialize_review_detail(detail),
        'test_cases': [_serialize_test_case_detail(item) for item in test_cases],
    }

# Endpoint to create a new test case detail
@router.post("/detail/test-case")
async def create_test_case_detail(
    payload: Dict[str, Any],
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    request_id = payload.get('request_id')
    test_case_id = payload.get('test_case_id')
    if not request_id or not test_case_id:
        raise HTTPException(status_code=400, detail='request_id and test_case_id are required')

    item = TestCaseDetail(
        test_case_id=str(test_case_id),
        request_id=str(request_id),
        document_id=str(payload.get('document_id') or f'DOC-{request_id}'),
        test_case_details=payload.get('test_case_details') or {},
        status=str(payload.get('status') or 'PENDING').upper(),
        rejection_reason=payload.get('rejection_reason'),
        reviewed_by=payload.get('reviewed_by') or (current_user or {}).get('username'),
        reviewed_datetime=payload.get('reviewed_datetime') or None,
        generated_by=payload.get('generated_by') or (current_user or {}).get('username'),
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return {'success': True, 'data': _serialize_test_case_detail(item)}

## Endpoint to update the decision for a review detail
@router.post("/detail/{request_id}/decision")
async def update_review_detail_decision(
    request_id: str,
    payload: Dict[str, Any],
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    detail = db.query(TestCaseReviewDetail).filter(TestCaseReviewDetail.request_id == request_id).first()
    if not detail:
        raise HTTPException(status_code=404, detail='Review request not found')

    decision = str(payload.get('decision') or '').upper()
    if decision in {'APPROVED', 'APPROVE'}:
        decision = 'APPROVE'
    elif decision in {'REJECTED', 'REJECT'}:
        decision = 'REJECT'
    if decision not in {'APPROVE', 'REJECT'}:
        raise HTTPException(status_code=400, detail='Decision must be APPROVE or REJECT')

    row_updates = payload.get('rows') or []
    if row_updates:
        for row in row_updates:
            test_case_id = row.get('test_case_id') or row.get('id')
            if not test_case_id:
                continue
            item = db.query(TestCaseDetail).filter(TestCaseDetail.request_id == request_id, TestCaseDetail.test_case_id == str(test_case_id)).first()
            if not item:
                continue
            item.status = 'APPROVED' if decision == 'APPROVE' else 'REJECTED'
            item.reviewed_by = (current_user or {}).get('username') or (current_user or {}).get('sub') or 'manager'
            item.reviewed_datetime = _dubai_now()
            if decision == 'REJECT':
                item.rejection_reason = row.get('rejection_reason') or payload.get('review_notes') or 'Rejected by manager'
    else:
        test_cases = db.query(TestCaseDetail).filter(TestCaseDetail.request_id == request_id).all()
        for item in test_cases:
            item.status = 'APPROVED' if decision == 'APPROVE' else 'REJECTED'
            item.reviewed_by = (current_user or {}).get('username') or (current_user or {}).get('sub') or 'manager'
            item.reviewed_datetime = _dubai_now()
            if decision == 'REJECT':
                item.rejection_reason = payload.get('review_notes') or 'Rejected by manager'

    all_case_rows = db.query(TestCaseDetail).filter(TestCaseDetail.request_id == request_id).all()
    approved_count = sum(1 for row in all_case_rows if str(row.status).upper() == 'APPROVED')
    rejected_count = sum(1 for row in all_case_rows if str(row.status).upper() == 'REJECTED')
    pending_count = sum(1 for row in all_case_rows if str(row.status).upper() == 'PENDING')

    if pending_count > 0:
        # Any pending test case keeps the request partially approved
        detail.overall_status = 'PARTIALLY_APPROVED'
    elif approved_count >= rejected_count:
        # Fully decided: majority wins, ties default to APPROVED
        detail.overall_status = 'APPROVED'
    else:
        detail.overall_status = 'REJECTED'

    detail.approved_count = approved_count
    detail.rejected_count = rejected_count
    detail.review_notes = payload.get('review_notes') or detail.review_notes
    detail.reviewed_by = (current_user or {}).get('username') or (current_user or {}).get('sub') or 'manager'
    detail.reviewed_date_time = _dubai_now()

    db.commit()
    db.refresh(detail)

    if decision == 'APPROVE':
        try:
            from ..services.automation import workbench as wb
            from ..models.automation import AutomationDeletedOrigin

            # Approving again outranks an earlier delete, and is the undo for
            # it. A case removed from Automation Studio leaves a tombstone so
            # the mirror stops re-creating it; a reviewer deciding APPROVE on
            # that same case is saying it belongs there after all, so the
            # tombstone goes and the mirror below picks it up on this pass.
            decided_ids = [
                str(r.test_case_id)
                for r in all_case_rows
                if str(r.status).upper() == 'APPROVED'
            ]
            if decided_ids:
                (
                    db.query(AutomationDeletedOrigin)
                    .filter(AutomationDeletedOrigin.origin_test_case_id.in_(decided_ids))
                    .delete(synchronize_session=False)
                )
                db.commit()

            wb.sync_approved_test_cases(db)
        except Exception:
            # The approval above is committed and stands on its own; mirroring
            # into Automation Studio is best-effort, so it must not fail the
            # request. Swallowing it in silence was the problem: a failed mirror
            # was indistinguishable from a successful one to both the API (which
            # still answers success) and the reviewer, and an ENAMETOOLONG out
            # of the Knowledge Base lookup went unseen for as long as it did
            # precisely because nothing recorded it. sync_approved_test_cases
            # re-reads every APPROVED row, so a later approval -- or the call
            # run by hand -- mirrors whatever this one missed.
            logger.exception(
                "Failed to mirror approved test cases into the Workbench "
                "for review request %s", request_id
            )

    return {'success': True, 'data': _serialize_review_detail(detail)}


@router.get("/list")
async def list_reviews(
    status: Optional[str] = Query(default=None),
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    user_roles = (current_user or {}).get('roles') or []
    if isinstance(user_roles, str):
        user_roles = [user_roles]
    if 'admin' not in user_roles and 'manager' not in user_roles:
        raise HTTPException(status_code=403, detail='Manager access required')

    query = db.query(TestCaseReview)
    if status:
        query = query.filter(TestCaseReview.status == status)
    reviews = query.order_by(TestCaseReview.created_at.desc()).all()
    return {'items': [_serialize_review(review) for review in reviews]}


@router.post("/{review_id}/decision")
async def review_decision(
    review_id: int,
    payload: Dict[str, Any],
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    user_roles = (current_user or {}).get('roles') or []
    if isinstance(user_roles, str):
        user_roles = [user_roles]
    if 'admin' not in user_roles and 'manager' not in user_roles:
        raise HTTPException(status_code=403, detail='Manager access required')

    review = db.query(TestCaseReview).filter(TestCaseReview.id == review_id).first()
    if not review:
        raise HTTPException(status_code=404, detail='Review not found')

    decision = str(payload.get('decision', '')).lower()
    if decision not in {'approve', 'reject'}:
        raise HTTPException(status_code=400, detail='Decision must be approve or reject')

    review.status = decision
    review.review_notes = payload.get('review_notes') or review.review_notes
    review.reviewed_by = (current_user or {}).get('username') or (current_user or {}).get('sub') or 'manager'
    review.reviewed_at = _dubai_now()
    db.commit()
    db.refresh(review)
    return {'success': True, 'data': _serialize_review(review)}


@router.get("/summary")
async def review_summary(
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    user_roles = (current_user or {}).get('roles') or []
    if isinstance(user_roles, str):
        user_roles = [user_roles]
    if 'admin' not in user_roles and 'manager' not in user_roles:
        raise HTTPException(status_code=403, detail='Manager access required')

    rows = db.query(TestCaseReview.status, db.func.count(TestCaseReview.id)).group_by(TestCaseReview.status).all()
    summary = {status: count for status, count in rows}
    return {'counts': summary}
