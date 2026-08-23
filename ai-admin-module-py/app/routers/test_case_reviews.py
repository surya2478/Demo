from typing import Any, Dict, List, Optional
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..database.connection import get_db
from ..models.database import TestCaseReview, TestCaseReviewDetail, TestCaseDetail
from ..utils.security import get_current_user_strict

router = APIRouter()


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
    return {
        'request_id': review_detail.request_id,
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
        'test_case_details': test_case_detail.test_case_details,
        'status': test_case_detail.status,
        'rejection_reason': test_case_detail.rejection_reason,
        'reviewed_by': test_case_detail.reviewed_by,
        'reviewed_datetime': test_case_detail.reviewed_datetime.isoformat() if test_case_detail.reviewed_datetime else None,
        'generated_by': test_case_detail.generated_by,
    }


@router.post("/submit")
async def submit_for_approval(
    payload: Dict[str, Any],
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    username = (current_user or {}).get('username') or (current_user or {}).get('sub') or 'system'

    request_id = str(payload.get('request_id') or payload.get('id') or f"REQ-{datetime.utcnow().strftime('%Y%m%d%H%M%S%f')}")
    request_by = str(payload.get('request_by') or username)
    request_date_time = payload.get('request_date_time') or datetime.utcnow()
    if isinstance(request_date_time, str):
        try:
            request_date_time = datetime.fromisoformat(request_date_time)
        except ValueError:
            request_date_time = datetime.utcnow()

    rows_payload = payload.get('rows') or (payload.get('payload') or {}).get('rows') or []
    documents_payload = payload.get('brd_document') or payload.get('documents') or []

    detail = TestCaseReviewDetail(
        request_id=request_id,
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
        request_by=str(payload.get('request_by') or (current_user or {}).get('username') or 'system'),
        request_date_time=payload.get('request_date_time') or datetime.utcnow(),
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


@router.get("/details")
async def list_review_details(
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    user_roles = (current_user or {}).get('roles') or []
    if isinstance(user_roles, str):
        user_roles = [user_roles]
    if 'admin' not in user_roles and 'manager' not in user_roles:
        raise HTTPException(status_code=403, detail='Manager access required')

    details = db.query(TestCaseReviewDetail).order_by(TestCaseReviewDetail.request_date_time.desc()).all()
    return {'items': [_serialize_review_detail(detail) for detail in details]}


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
            item.reviewed_datetime = datetime.utcnow()
            if decision == 'REJECT':
                item.rejection_reason = row.get('rejection_reason') or payload.get('review_notes') or 'Rejected by manager'
    else:
        test_cases = db.query(TestCaseDetail).filter(TestCaseDetail.request_id == request_id).all()
        for item in test_cases:
            item.status = 'APPROVED' if decision == 'APPROVE' else 'REJECTED'
            item.reviewed_by = (current_user or {}).get('username') or (current_user or {}).get('sub') or 'manager'
            item.reviewed_datetime = datetime.utcnow()
            if decision == 'REJECT':
                item.rejection_reason = payload.get('review_notes') or 'Rejected by manager'

    all_case_rows = db.query(TestCaseDetail).filter(TestCaseDetail.request_id == request_id).all()
    approved_count = sum(1 for row in all_case_rows if str(row.status).upper() == 'APPROVED')
    rejected_count = sum(1 for row in all_case_rows if str(row.status).upper() == 'REJECTED')
    pending_count = sum(1 for row in all_case_rows if str(row.status).upper() == 'PENDING')

    if pending_count > 0:
        detail.overall_status = 'PARTIALLY_APPROVED' if approved_count or rejected_count else 'PENDING_REVIEW'
    elif approved_count and rejected_count:
        detail.overall_status = 'PARTIALLY_APPROVED'
    elif approved_count and not rejected_count:
        detail.overall_status = 'APPROVED'
    elif rejected_count and not approved_count:
        detail.overall_status = 'REJECTED'
    else:
        detail.overall_status = 'PENDING_REVIEW'

    detail.approved_count = approved_count
    detail.rejected_count = rejected_count
    detail.review_notes = payload.get('review_notes') or detail.review_notes
    detail.reviewed_by = (current_user or {}).get('username') or (current_user or {}).get('sub') or 'manager'
    detail.reviewed_date_time = datetime.utcnow()

    db.commit()
    db.refresh(detail)

    if decision == 'APPROVE':
        try:
            from ..services.automation import workbench as wb
            wb.sync_approved_test_cases(db)
        except Exception:
            pass

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
    review.reviewed_at = datetime.utcnow()
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
