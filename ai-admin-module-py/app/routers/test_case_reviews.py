from typing import Any, Dict, List, Optional
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
import logging
import re

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from ..database.connection import get_db
from ..models.database import BitbucketSync, Project, TestCaseReview, TestCaseReviewDetail, TestCaseDetail
from ..services import bitbucket_sync
from .projects import serialize_project
from ..services.automation import applications as app_scope
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


def _syncs_by_request(db: Session, request_ids: set[str]) -> Dict[str, BitbucketSync]:
    if not request_ids:
        return {}
    rows = db.query(BitbucketSync).filter(BitbucketSync.request_id.in_(request_ids)).all()
    return {row.request_id: row for row in rows}


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
    """List distinct document IDs that have approved test cases."""
    rows = (
        db.query(TestCaseDetail.document_id)
        .filter(func.upper(TestCaseDetail.status) == 'APPROVED', TestCaseDetail.document_id.isnot(None), TestCaseDetail.document_id != '')
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
    """The approved test cases of a review request (drafts, pending and rejected ones are not listed)."""
    if not request_id or not request_id.strip():
        raise HTTPException(status_code=422, detail='request_id is required')

    detail = db.query(TestCaseReviewDetail).filter(TestCaseReviewDetail.request_id == request_id).first()
    if not detail:
        raise HTTPException(status_code=404, detail='Review request not found')
    test_cases = (
        db.query(TestCaseDetail)
        .filter(TestCaseDetail.request_id == request_id, func.upper(TestCaseDetail.status) == 'APPROVED')
        .all()
    )
    if not test_cases:
        raise HTTPException(status_code=409, detail='No test case in this request is approved yet')
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
        .filter(func.upper(TestCaseDetail.status) == 'APPROVED', TestCaseDetail.document_id == document_id)
        .all()
    )
    return {'items': [_serialize_test_case_detail(item) for item in test_cases]}

# Function to create a review submission in the database
def create_review_submission(
    payload: Dict[str, Any],
    current_user: Dict[str, Any],
    db: Session,
    *,
    saved: bool = False,
) -> Dict[str, Any]:
    """Create a review request -- sent for approval, or only saved (``saved``).

    A saved request is the record of the generated test cases, written when
    AI Checks start so nothing generated is lost if it is never sent. Sending
    it later turns that same request into one awaiting approval.
    """
    username = (current_user or {}).get('username') or (current_user or {}).get('sub') or 'system'

    request_id = str(payload.get('request_id') or payload.get('id') or f"REQ-{_dubai_now().strftime('%Y%m%d%H%M%S%f')}")
    existing = db.query(TestCaseReviewDetail).filter(TestCaseReviewDetail.request_id == request_id).first()
    if existing is not None:
        # A saved request is sent in one go or in parts, as AI Checks finish:
        # each send moves more of its saved cases to the manager.
        has_drafts = (
            db.query(TestCaseDetail)
            .filter(TestCaseDetail.request_id == request_id, TestCaseDetail.status == DRAFT_STATUS)
            .count()
            > 0
        )
        if saved or not (existing.overall_status == SAVED_STATUS or has_drafts):
            raise HTTPException(status_code=409, detail=f'Request {request_id} already exists.')
        return _send_saved_request(existing, payload, username, db)
    request_by = str(payload.get('request_by') or username)
    request_date_time = _to_dubai(payload.get('request_date_time')) or _dubai_now()

    rows_payload = payload.get('rows') or (payload.get('payload') or {}).get('rows') or []
    documents_payload = payload.get('brd_document') or payload.get('documents') or []

    # One document_id shared by every test case in this request
    document_id = _get_document_id(payload, request_id)
    scope = _application_scope(db, payload)
    assigned: Dict[str, Optional[str]] = {}

    detail = TestCaseReviewDetail(
        request_id=request_id,
        source=str(payload.get('source') or (payload.get('payload') or {}).get('source_type') or '').strip() or None,
        request_by=request_by,
        request_date_time=request_date_time,
        brd_document=documents_payload,
        no_of_test_cases=len(rows_payload),
        approved_count=0,
        rejected_count=0,
        overall_status=SAVED_STATUS if saved else 'PENDING_REVIEW',
        review_notes=payload.get('review_notes'),
        reviewed_by=None,
        reviewed_date_time=None,
        project_id=_project_id(db, payload.get('project_id')),
        generation=_generation(payload.get('generation')) if saved else None,
    )
    db.add(detail)

    for row_index, row in enumerate(rows_payload):
        test_case_payload = row.get('test_case_details') if isinstance(row, dict) and 'test_case_details' in row else row
        if not isinstance(test_case_payload, dict):
            test_case_payload = {'content': str(row)}

        test_case_id = str(row.get('test_case_id') if isinstance(row, dict) else row.get('id') or f"TC-{row_index + 1}")
        if not test_case_id:
            test_case_id = f"TC-{request_id}-{row_index + 1}"

        # --- AI Checks results travel with the case -------------------------
        # The page sends only which check a row came from. The scores and the
        # classification are read from that check here, so what the manager
        # approves on is what the checks produced, not what a browser said.
        # They live under "_ai", apart from the case's own columns.
        _attach_ai(db, test_case_payload, test_case_id=test_case_id, request_id=request_id, attach=not saved)
        # Each case is linked to the chosen application it is for, here, once:
        # everything after (AI Checks, approval, the Workbench) reads the link.
        if scope:
            choice = app_scope.stamp(test_case_payload, scope)
            assigned[test_case_id] = choice.name if choice else None

        test_case = TestCaseDetail(
            test_case_id=test_case_id,
            request_id=request_id,
            document_id=document_id,
            test_case_details=test_case_payload,
            status=DRAFT_STATUS if saved else 'PENDING',
            rejection_reason=None,
            reviewed_by=None,
            reviewed_datetime=None,
            generated_by=request_by,
        )
        db.add(test_case)

    db.commit()
    db.refresh(detail)
    return {'success': True, 'data': _serialize_review_detail(detail), 'request_id': request_id, 'applications': assigned}


# A request saved when AI Checks start, and its cases, until they are sent.
SAVED_STATUS = 'AI_CHECKS'
DRAFT_STATUS = 'DRAFT'


def _attach_ai(db: Session, details: Dict[str, Any], *, test_case_id: str, request_id: str, attach: bool) -> None:
    """Replace the page's AI Checks reference with the check's own results.

    The page sends only which check a row came from. The scores and the
    classification are read from that check here, so what the manager
    approves on is what the checks produced, not what a browser said. They
    live under "_ai", apart from the case's own columns.
    """
    check_id = details.pop('_ai_check_id', None)
    details.pop('_ai', None)
    if not attach or check_id is None:
        return
    from ..services.automation import ai_checks

    ai_results = ai_checks.attach_to_review(db, check_id, test_case_id=test_case_id, request_id=request_id)
    if ai_results:
        details['_ai'] = ai_results


def _send_saved_request(
    detail: TestCaseReviewDetail, payload: Dict[str, Any], username: str, db: Session
) -> Dict[str, Any]:
    """Send a saved request for approval, with the cases the author chose.

    Each sent case replaces its saved (as-generated) row with the checked
    text and goes to PENDING. Cases not sent stay saved as DRAFT -- still on
    record, never shown to the manager.
    """
    rows_payload = payload.get('rows') or (payload.get('payload') or {}).get('rows') or []
    if not rows_payload:
        raise HTTPException(status_code=400, detail='Choose at least one test case to send.')
    saved_rows = {
        row.test_case_id: row
        for row in db.query(TestCaseDetail).filter(TestCaseDetail.request_id == detail.request_id).all()
    }
    request_application = _shared_request_application(db, list(saved_rows.values()))
    document_id = next((row.document_id for row in saved_rows.values() if row.document_id), None) or _get_document_id(payload, detail.request_id)
    request_by = str(payload.get('request_by') or username)
    scope = _application_scope(db, payload, detail.generation)

    for row_index, row in enumerate(rows_payload):
        details = row.get('test_case_details') if isinstance(row, dict) and 'test_case_details' in row else row
        if not isinstance(details, dict):
            details = {'content': str(row)}
        test_case_id = str((row.get('test_case_id') if isinstance(row, dict) else None) or f"{detail.request_id}-TC-S{row_index + 1}")
        _attach_ai(db, details, test_case_id=test_case_id, request_id=detail.request_id, attach=True)
        item = saved_rows.get(test_case_id)
        if item is None:
            item = TestCaseDetail(test_case_id=test_case_id, request_id=detail.request_id, document_id=document_id)
            db.add(item)
        elif str(item.status).upper() != DRAFT_STATUS:
            continue  # already sent
        # The page sends the checked text back without the link the save
        # wrote; keep it, and link a case that never had one.
        if item.test_case_details:
            app_scope.carry(details, item.test_case_details)
        if scope and not app_scope.linked(details):
            app_scope.stamp(details, scope)
        # The checked row sent by the browser contains the edited case, not
        # server-owned request metadata. Keep the application selected earlier
        # (including when this is another case sent from the same draft).
        if not _case_application_values(details):
            application = _case_application(item) if item is not None else None
            if application is None:
                application = request_application
            if application is not None:
                details['_automation_application'] = application
        item.test_case_details = details
        item.status = 'PENDING'
        item.generated_by = request_by

    db.flush()
    sent = (
        db.query(TestCaseDetail)
        .filter(TestCaseDetail.request_id == detail.request_id, TestCaseDetail.status != DRAFT_STATUS)
        .count()
    )
    # Cases the manager already decided keep their decisions; new ones wait.
    decided = detail.overall_status in ('APPROVED', 'REJECTED', 'PARTIALLY_APPROVED')
    detail.overall_status = 'PARTIALLY_APPROVED' if decided else 'PENDING_REVIEW'
    detail.no_of_test_cases = sent
    detail.request_by = request_by
    detail.request_date_time = _to_dubai(payload.get('request_date_time')) or _dubai_now()
    if payload.get('brd_document') or payload.get('documents'):
        detail.brd_document = payload.get('brd_document') or payload.get('documents')
    db.commit()
    db.refresh(detail)
    return {'success': True, 'data': _serialize_review_detail(detail), 'request_id': detail.request_id}


def _project_id(db: Session, value: Any) -> Optional[int]:
    """A project id the request may carry: an existing project, or None."""
    if value in (None, '', 0):
        return None
    try:
        project = db.get(Project, int(value))
    except (TypeError, ValueError):
        project = None
    if project is None:
        raise HTTPException(status_code=400, detail='That project no longer exists. Choose the project again.')
    return project.id


# The processed document can be long; the session keeps enough to show it
# again, not an unbounded copy of every upload.
_GENERATION_TEXT_LIMIT = 400_000
_GENERATION_KEYS = (
    'output', 'input_type', 'knowledge_base', 'knowledge_base_label', 'environment', 'focus',
    'document_text', 'document_names', 'text_input', 'ppm_id', 'stopped', 'applications',
)


def _application_scope(db: Session, payload: Dict[str, Any], generation: Any = None) -> List[app_scope.AppChoice]:
    """The applications the cases were generated for: the payload's own
    `applications`, else the generation snapshot's. A stale choice is a 400."""
    chosen = payload.get('applications')
    if not chosen:
        chosen = ((payload.get('generation') or generation or {}) or {}).get('applications') or []
    try:
        return app_scope.choices(db, chosen)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _generation(value: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(value, dict):
        return None
    kept: Dict[str, Any] = {}
    for key in _GENERATION_KEYS:
        if key not in value:
            continue
        item = value[key]
        if isinstance(item, str):
            item = item[:_GENERATION_TEXT_LIMIT]
        kept[key] = item
    return kept


def _projects_by_id(db: Session, ids: set) -> Dict[int, Project]:
    ids = {item for item in ids if item}
    if not ids:
        return {}
    return {project.id: project for project in db.query(Project).filter(Project.id.in_(ids)).all()}


def _batch_progress(db: Session, batch_ids: set) -> Dict[str, Dict[str, int]]:
    from ..models.automation import AutomationAICheck

    batch_ids = {item for item in batch_ids if item}
    progress: Dict[str, Dict[str, int]] = {}
    if not batch_ids:
        return progress
    rows = (
        db.query(AutomationAICheck.batch_id, AutomationAICheck.status, func.count(AutomationAICheck.id))
        .filter(AutomationAICheck.batch_id.in_(batch_ids))
        .group_by(AutomationAICheck.batch_id, AutomationAICheck.status)
        .all()
    )
    for batch_id, status, count in rows:
        progress.setdefault(batch_id, {})[status] = count
    return progress


def _session_summary(
    detail: TestCaseReviewDetail,
    cases: List[TestCaseDetail],
    project: Optional[Project],
    progress: Optional[Dict[str, int]],
) -> Dict[str, Any]:
    statuses = [str(case.status).upper() for case in cases]
    checks = progress or {}
    checks_total = sum(checks.values())
    checks_running = checks.get('queued', 0) + checks.get('running', 0)
    if detail.overall_status == SAVED_STATUS and not detail.ai_batch_id:
        stage = 'generated'
    elif detail.overall_status == SAVED_STATUS:
        stage = 'ai_checks'
    elif DRAFT_STATUS in statuses:
        stage = 'partly_sent'
    else:
        stage = 'sent'
    generation = detail.generation or {}
    return {
        'request_id': detail.request_id,
        'project': serialize_project(project),
        'document_name': _document_name(detail, None),
        'source_group': _source_group(detail),
        'input_type': generation.get('input_type'),
        'knowledge_base_label': generation.get('knowledge_base_label'),
        'request_by': detail.request_by,
        'request_date_time': detail.request_date_time.isoformat() if detail.request_date_time else None,
        'overall_status': detail.overall_status,
        'stage': stage,
        'cases': len(cases),
        'draft': statuses.count(DRAFT_STATUS),
        'pending': statuses.count('PENDING'),
        'approved': statuses.count('APPROVED'),
        'rejected': statuses.count('REJECTED'),
        'ai_batch_id': detail.ai_batch_id,
        'checks': {
            'total': checks_total,
            'done': checks.get('done', 0),
            'failed': checks.get('failed', 0),
            'stopped': checks.get('stopped', 0),
            'running': checks_running,
        } if detail.ai_batch_id else None,
        # Only sessions saved from the Test Cases page can be reopened there.
        'restorable': detail.generation is not None,
    }


@router.get("/sessions")
def list_sessions(
    project_id: Optional[int] = Query(default=None),
    mine: bool = Query(default=False),
    open_only: bool = Query(default=False, alias='open'),
    limit: int = Query(default=20, ge=1, le=100),
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    """Generation sessions: saved requests and what became of their cases.

    With a project, every session under it -- projects are shared. Without
    one, only the caller's own sessions saved with no project. ``open`` keeps
    the sessions that still have cases not sent for approval.
    """
    username = (current_user or {}).get('username') or (current_user or {}).get('sub') or ''
    query = db.query(TestCaseReviewDetail).filter(TestCaseReviewDetail.generation.isnot(None))
    if project_id:
        query = query.filter(TestCaseReviewDetail.project_id == project_id)
    else:
        query = query.filter(TestCaseReviewDetail.project_id.is_(None), TestCaseReviewDetail.request_by == username)
    if mine:
        query = query.filter(TestCaseReviewDetail.request_by == username)
    details = query.order_by(TestCaseReviewDetail.request_date_time.desc()).limit(200).all()

    ids = [detail.request_id for detail in details]
    cases_by_request: Dict[str, List[TestCaseDetail]] = {}
    if ids:
        for case in db.query(TestCaseDetail).filter(TestCaseDetail.request_id.in_(ids)).all():
            cases_by_request.setdefault(case.request_id, []).append(case)
    projects = _projects_by_id(db, {detail.project_id for detail in details})
    progress = _batch_progress(db, {detail.ai_batch_id for detail in details})

    items = []
    for detail in details:
        summary = _session_summary(
            detail, cases_by_request.get(detail.request_id, []), projects.get(detail.project_id), progress.get(detail.ai_batch_id)
        )
        if open_only and not summary['draft']:
            continue
        items.append(summary)
        if len(items) >= limit:
            break
    return {'items': items}


@router.get("/sessions/{request_id}")
def get_session(
    request_id: str,
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    """Everything the Test Cases page needs to reopen a session."""
    detail = db.query(TestCaseReviewDetail).filter(TestCaseReviewDetail.request_id == request_id).first()
    if detail is None or detail.generation is None:
        raise HTTPException(status_code=404, detail='No saved session with that request id.')
    cases = db.query(TestCaseDetail).filter(TestCaseDetail.request_id == request_id).all()
    project = db.get(Project, detail.project_id) if detail.project_id else None
    progress = _batch_progress(db, {detail.ai_batch_id})
    return {
        **_session_summary(detail, cases, project, progress.get(detail.ai_batch_id)),
        'generation': detail.generation,
        'brd_document': detail.brd_document,
        'rows': [
            {
                'test_case_id': case.test_case_id,
                'display_id': str((case.test_case_details or {}).get('Test Case ID') or '').strip(),
                'status': case.status,
                **_row_application(case.test_case_details),
            }
            for case in cases
        ],
    }


def _row_application(details: Any) -> Dict[str, Any]:
    """{'application': name or None} for a case of a generation that chose
    applications (None = not matched to one yet); {} for an older case."""
    choice, chosen = app_scope.for_row(details if isinstance(details, dict) else {})
    if not chosen:
        return {}
    return {'application': choice.name if choice else None}


@router.post("/saved/{request_id}/application")
def assign_case_application(
    request_id: str,
    payload: Dict[str, Any],
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    """Link one generated case to the application the author picked.

    For a case the save could not match to one of the chosen applications
    (Unassigned), or one it matched wrongly. Only the request's own chosen
    applications are allowed, and only while the case is not yet approved --
    an approved case has moved on to the Workbench. A case already through AI
    Checks is checked again for its new application.
    """
    detail = db.query(TestCaseReviewDetail).filter(TestCaseReviewDetail.request_id == request_id).first()
    if detail is None:
        raise HTTPException(status_code=404, detail='Saved request not found')
    scope = _application_scope(db, {}, detail.generation)
    if not scope:
        raise HTTPException(status_code=400, detail='This request was generated without choosing applications.')
    try:
        application_id = int(payload.get('application_id'))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail='application_id is required.') from None
    choice = next((c for c in scope if c.id == application_id), None)
    if choice is None:
        raise HTTPException(status_code=400, detail='Choose one of the applications this request was generated for.')

    test_case_id = str(payload.get('test_case_id') or '')
    row = (
        db.query(TestCaseDetail)
        .filter(TestCaseDetail.request_id == request_id, TestCaseDetail.test_case_id == test_case_id)
        .first()
    )
    if row is None:
        raise HTTPException(status_code=404, detail='Test case not found in this request.')
    if str(row.status).upper() == 'APPROVED':
        raise HTTPException(status_code=409, detail='This test case is already approved; change its application in the Workbench.')

    details = dict(row.test_case_details or {})
    app_scope.link(details, choice, scope)
    rechecked: List[int] = []
    if detail.ai_batch_id:
        from ..services.automation import ai_checks

        display_id = str(details.get('Test Case ID') or '').strip()
        try:
            rechecked = ai_checks.relink(db, detail.ai_batch_id, display_id, choice, scope) if display_id else []
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    row.test_case_details = details
    db.commit()
    return {'test_case_id': test_case_id, 'application': choice.name, 'rechecked': rechecked}


@router.patch("/saved/{request_id}")
def update_saved_session(
    request_id: str,
    payload: Dict[str, Any],
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    """Keep a saved session in step with the page: its output, its project."""
    detail = db.query(TestCaseReviewDetail).filter(TestCaseReviewDetail.request_id == request_id).first()
    if detail is None or detail.generation is None:
        raise HTTPException(status_code=404, detail='No saved session with that request id.')
    if isinstance(payload.get('generation'), dict):
        detail.generation = {**(detail.generation or {}), **(_generation(payload['generation']) or {})}
    if 'project_id' in payload and detail.overall_status == SAVED_STATUS:
        detail.project_id = _project_id(db, payload.get('project_id'))
    db.commit()
    return {'success': True}


@router.post("/save")
async def save_generated_test_cases(
    payload: Dict[str, Any],
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    """Save generated test cases as a request, before AI Checks and approval."""
    rows = payload.get('rows') or (payload.get('payload') or {}).get('rows') or []
    if not rows:
        raise HTTPException(status_code=400, detail='There are no test cases to save.')
    return create_review_submission(payload, current_user, db, saved=True)


@router.post("/saved/{request_id}/remove")
async def remove_saved_test_cases(
    request_id: str,
    payload: Dict[str, Any],
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    """Delete saved cases the author removed. Only cases not yet sent go."""
    ids = [str(item) for item in (payload.get('test_case_ids') or []) if item]
    detail = db.query(TestCaseReviewDetail).filter(TestCaseReviewDetail.request_id == request_id).first()
    if detail is None:
        raise HTTPException(status_code=404, detail='Saved request not found')
    removed = 0
    if ids:
        removed = (
            db.query(TestCaseDetail)
            .filter(
                TestCaseDetail.request_id == request_id,
                TestCaseDetail.test_case_id.in_(ids),
                TestCaseDetail.status == DRAFT_STATUS,
            )
            .delete(synchronize_session=False)
        )
    left = db.query(TestCaseDetail).filter(TestCaseDetail.request_id == request_id).count()
    if detail.overall_status == SAVED_STATUS:
        if left == 0:
            db.delete(detail)
        else:
            detail.no_of_test_cases = left
    db.commit()
    return {'removed': removed}

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

def _recent_cutoff() -> datetime:
    # "Recent / Current" was the last 5 minutes: an approval dropped out of it
    # almost at once into the collapsed history list and looked lost.
    return _dubai_now() - timedelta(hours=24)


def _has_approved_cases():
    """Requests with at least one approved test case.

    Only overall_status == APPROVED used to count, so a request with some
    cases approved and others still pending (PARTIALLY_APPROVED), or out-voted
    by rejections (REJECTED), never reached the Approved area at all.
    """
    return or_(TestCaseReviewDetail.overall_status == 'APPROVED', TestCaseReviewDetail.approved_count > 0)

# Helper function to serialize approved review details into a dictionary
def _serialize_approved_review_details(details: List[TestCaseReviewDetail]) -> Dict[str, Any]:
    return {'items': [_serialize_review_detail(detail) for detail in details]}

# Endpoint to list current review details
@router.get("/pending-count")
def pending_review_count(
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    """Requests waiting for a decision -- the sidebar's Review & Approve badge."""
    _require_review_manager(current_user)
    count = (
        db.query(TestCaseReviewDetail)
        .filter(TestCaseReviewDetail.overall_status.in_(PENDING_STATUSES))
        .count()
    )
    return {'pending': count}


# A partly decided request still has cases waiting for the manager.
PENDING_STATUSES = ('PENDING_REVIEW', 'PARTIALLY_APPROVED')


def _source_group(detail: TestCaseReviewDetail) -> str:
    """BRD, SDD, ADO or e2e Spark -- the source filter on Review & Approval."""
    source = str(detail.source or '').upper()
    if source in ('ADO', 'AZURE_DEVOPS') or str(detail.request_id).upper().startswith('ADO-'):
        return 'ADO'
    if 'SPARK' in source:
        return 'e2e Spark'
    names = ' '.join(
        str(item.get('name') or '') for item in (detail.brd_document or []) if isinstance(item, dict)
    )
    # Not \b: document names use underscores (SDD_PPM ...), and _ is a word character.
    if re.search(r'(?<![A-Za-z])SDD(?![A-Za-z])', names, re.IGNORECASE):
        return 'SDD'
    return 'BRD'


def _document_name(detail: TestCaseReviewDetail, fallback: Optional[str]) -> str:
    names = [
        str(item.get('name')).strip()
        for item in (detail.brd_document or [])
        if isinstance(item, dict) and item.get('name')
    ]
    return ' | '.join(names) or fallback or detail.request_id


def _case_ai(case: TestCaseDetail) -> Dict[str, Any]:
    details = case.test_case_details if isinstance(case.test_case_details, dict) else {}
    ai = details.get('_ai')
    return ai if isinstance(ai, dict) else {}


def _case_application(case: TestCaseDetail) -> Optional[Dict[str, Any]]:
    details = case.test_case_details if isinstance(case.test_case_details, dict) else {}
    return _case_application_values(details)


def _case_application_values(details: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    value = details.get('_automation_application')
    return value if isinstance(value, dict) and value.get('id') else None


def _shared_request_application(db: Session, cases: List[TestCaseDetail]) -> Optional[Dict[str, Any]]:
    """Resolve only an unambiguous, active application already saved on this request."""
    ids = {str(app['id']) for case in cases if (app := _case_application(case))}
    if len(ids) != 1:
        return None
    from ..models.automation import AutomationApplication

    try:
        application = db.get(AutomationApplication, int(next(iter(ids))))
    except (TypeError, ValueError):
        return None
    if application is None or not application.is_active:
        return None
    return {
        'id': application.id,
        'name': application.name,
        'app_key': application.app_key,
        'base_url': application.base_url,
        'environment': application.environment,
    }


def _request_summary(detail: TestCaseReviewDetail, cases: List[TestCaseDetail]) -> Dict[str, Any]:
    ai = [_case_ai(case) for case in cases]
    checked = [item for item in ai if item]
    after = [float(item['score_after']) for item in checked if item.get('score_after') is not None]
    before = [float(item['score_before']) for item in checked if item.get('score_before') is not None]
    application = next((_case_application(case) for case in cases if _case_application(case)), None)
    review_cases = [case for case in cases if str(case.status).upper() != DRAFT_STATUS]
    application_complete = bool(application) and all(
        (_case_application(case) or {}).get('id') == application['id'] for case in review_cases
    )
    approved = [case for case in cases if str(case.status).upper() == 'APPROVED']
    document_id = next((case.document_id for case in cases if case.document_id), None)
    case_ids = []
    for case in cases:
        details = case.test_case_details if isinstance(case.test_case_details, dict) else {}
        for value in (
            case.test_case_id,
            details.get('Test Case ID'),
            details.get('TC ID'),
            details.get('Case ID'),
        ):
            text = str(value or '').strip()
            if text and text not in case_ids:
                case_ids.append(text)
    return {
        **_serialize_review_detail(detail),
        'document_name': _document_name(detail, document_id),
        'source_group': _source_group(detail),
        'cases': len(cases),
        # Lets the review queue find a request from either its request id or
        # any user-facing/internal test-case id without loading every detail.
        'case_ids': case_ids,
        'pending_cases': sum(1 for case in cases if str(case.status).upper() == 'PENDING'),
        'ai_checked': len(checked),
        'automation': sum(1 for item in checked if item.get('classification') == 'automation'),
        'manual': sum(1 for item in checked if item.get('classification') == 'manual'),
        'test_data_pending': sum(1 for item in checked if item.get('test_data_pending')),
        'avg_before': round(sum(before) / len(before), 1) if before else None,
        'avg_after': round(sum(after) / len(after), 1) if after else None,
        'sent_to_lab': sum(1 for case in approved if _case_ai(case).get('classification') == 'automation'),
        'application': application,
        'application_complete': application_complete,
    }


@router.get("/overview")
def review_overview(
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    """Every request with its AI Checks figures, for the Review & Approval screen.

    One call rather than the three the screen used to make (current, ADO,
    history): the tabs and the source filter are views over the same list.
    """
    _require_review_manager(current_user)
    details = (
        db.query(TestCaseReviewDetail)
        .filter(TestCaseReviewDetail.overall_status != SAVED_STATUS)
        .order_by(TestCaseReviewDetail.request_date_time.desc())
        .all()
    )
    cases_by_request: Dict[str, List[TestCaseDetail]] = {}
    for case in db.query(TestCaseDetail).filter(TestCaseDetail.status != DRAFT_STATUS).all():
        cases_by_request.setdefault(case.request_id, []).append(case)

    projects = _projects_by_id(db, {detail.project_id for detail in details})
    syncs = _syncs_by_request(db, {detail.request_id for detail in details})
    requests = [
        {
            **_request_summary(detail, cases_by_request.get(detail.request_id, [])),
            'project': serialize_project(projects.get(detail.project_id)),
            'bitbucket_sync': bitbucket_sync.serialize_sync(syncs.get(detail.request_id)),
        }
        for detail in details
    ]
    pending = [item for item in requests if item['overall_status'] in PENDING_STATUSES]
    pending_cases = sum(item['pending_cases'] for item in pending)
    pending_automation = sum(item['automation'] for item in pending)
    after = [item['avg_after'] for item in pending if item['avg_after'] is not None]
    before = [item['avg_before'] for item in pending if item['avg_before'] is not None]
    oldest = min(pending, key=lambda item: item['request_date_time'] or '', default=None)

    return {
        'now': _dubai_now().isoformat(),
        'kpis': {
            'pending_requests': len(pending),
            'pending_cases': pending_cases,
            'automation_ready': pending_automation,
            'checked_cases': sum(item['ai_checked'] for item in pending),
            'avg_after': round(sum(after) / len(after), 1) if after else None,
            'avg_before': round(sum(before) / len(before), 1) if before else None,
            'oldest_request_id': oldest['request_id'] if oldest else None,
            'oldest_request_time': oldest['request_date_time'] if oldest else None,
            'oldest_document': oldest['document_name'] if oldest else None,
        },
        'requests': requests,
    }


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
            TestCaseReviewDetail.overall_status != SAVED_STATUS,
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
            TestCaseReviewDetail.overall_status != SAVED_STATUS,
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
            _has_approved_cases(),
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
        .filter(_has_approved_cases(), TestCaseReviewDetail.source.in_(['ADO', 'AZURE_DEVOPS']))
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
            _has_approved_cases(),
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

    details = (
        db.query(TestCaseReviewDetail)
        .filter(TestCaseReviewDetail.overall_status != SAVED_STATUS)
        .order_by(TestCaseReviewDetail.request_date_time.desc())
        .all()
    )
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

    # Cases saved but never sent are not part of the review.
    test_cases = (
        db.query(TestCaseDetail)
        .filter(TestCaseDetail.request_id == request_id, TestCaseDetail.status != DRAFT_STATUS)
        .all()
    )
    project = db.get(Project, detail.project_id) if getattr(detail, 'project_id', None) else None
    sync = db.query(BitbucketSync).filter(BitbucketSync.request_id == request_id).first()
    from ..services.automation.evaluation_handoff import linked_check, packet
    from ..models.automation import AutomationTestCase
    serialized = []
    for item in test_cases:
        output = _serialize_test_case_detail(item)
        check = linked_check(db, item)
        if check:
            output['test_case_details'] = {**(item.test_case_details or {}),
                '_agent_resolution': packet(check, db.get(AutomationTestCase, check.case_id))}
        serialized.append(output)
    return {
        'data': {
            **_serialize_review_detail(detail),
            'project': serialize_project(project),
            'application': next((_case_application(item) for item in test_cases if _case_application(item)), None),
            'bitbucket_sync': bitbucket_sync.serialize_sync(sync),
            'bitbucket_config': bitbucket_sync.configuration_status(),
        },
        'test_cases': serialized,
    }


@router.post("/detail/{request_id}/cases/{test_case_id}/resume-agents", status_code=202)
def resume_review_agents(request_id: str, test_case_id: str, payload: Dict[str, Any],
                         current_user=Depends(get_current_user_strict), db: Session = Depends(get_db)):
    _require_review_manager(current_user)
    from ..services.authz import user_has_permission
    if not user_has_permission(current_user, 'automation.execute'):
        raise HTTPException(status_code=403, detail='Browser execution permission is required to continue the agents.')
    from ..services.automation.evaluation_handoff import linked_check
    from ..services.automation import ai_checks
    row = db.query(TestCaseDetail).filter(TestCaseDetail.request_id == request_id, TestCaseDetail.test_case_id == test_case_id).first()
    if not row or row.status != 'PENDING':
        raise HTTPException(status_code=409, detail='Only a pending evaluation case can be resumed.')
    check = linked_check(db, row)
    if not check:
        raise HTTPException(status_code=409, detail='This case has no matching saved agent handoff.')
    if check.status in {'queued', 'running'}:
        return {'status': check.status}
    if ai_checks._is_active(check.batch_id):
        raise HTTPException(status_code=409, detail='Wait for the other cases in this batch to finish before changing its inputs.')
    try:
        if 'steps' in payload:
            revised = payload['steps']
            if not isinstance(revised, str) or not revised.strip() or len(revised) > 20000:
                raise ValueError('Provide the intended steps (up to 20,000 characters).')
            state = dict(check.steps or {})
            state.setdefault('_original_source', dict(check.source_row or {}))
            state['_human_edits'] = [*(state.get('_human_edits') or []), {'steps': revised.strip()}]
            check.steps = state
            check.source_row = {**(check.source_row or {}), 'Test Steps': revised.strip()}
        if payload.get('page_url'):
            from ..services.automation.registry import address_for_crawl
            from ..services.automation.discovery import validated_capture_urls
            state = dict(check.steps or {})
            setup = dict(state.get('_agent_setup') or {})
            address = address_for_crawl(db, setup['app_key'], setup['environment'])
            extra = validated_capture_urls(address or '', [str(payload['page_url'])])
            setup['additional_urls'] = list(dict.fromkeys([*(setup.get('additional_urls') or []), *extra]))[-5:]
            check.steps = {**state, '_agent_setup': setup, '_force_discovery': True}
            db.commit()
        if 'steps' in payload:
            ai_checks._reset(check)
            db.commit()
            ai_checks._launch(check.batch_id, [check.id])
        else:
            ai_checks.retry(db, check.batch_id, check.id)
    except (LookupError, ValueError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {'status': 'queued'}


@router.post('/detail/{request_id}/cases/{test_case_id}/record-login', status_code=202)
def record_review_login(request_id: str, test_case_id: str, current_user=Depends(get_current_user_strict), db: Session = Depends(get_db)):
    _require_review_manager(current_user)
    from ..services.authz import user_has_permission
    from ..services.automation.evaluation_handoff import linked_check
    from ..services.journeys import journey_record, crawl_runs
    from ..models.kb_changes import KbCrawlRun
    if not user_has_permission(current_user, 'automation.execute'):
        raise HTTPException(status_code=403, detail='Browser execution permission is required.')
    row = db.query(TestCaseDetail).filter(TestCaseDetail.request_id == request_id, TestCaseDetail.test_case_id == test_case_id).first()
    check = linked_check(db, row) if row and row.status == 'PENDING' else None
    if not check or check.status in {'running', 'queued'}:
        raise HTTPException(status_code=409, detail='Wait for the agents to pause before recording this pending case.')
    state = dict(check.steps or {})
    previous = db.get(KbCrawlRun, state.get('_review_recording_id')) if state.get('_review_recording_id') else None
    if previous and previous.status in {'running', 'queued'}:
        return crawl_runs.view(previous)
    setup = state.get('_agent_setup') or {}
    try:
        crawl = journey_record.start(db, app_id=setup['app_key'], journey_id='', application_id=setup['application_id'],
            environment=setup['environment'], actor=current_user.get('username'), new_journey_name=f'Login capture for {test_case_id}', profile_id=setup.get('profile_id'))
    except (ValueError, LookupError, crawl_runs.Unavailable) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    check.steps = {**state, '_review_recording_id': crawl.id}
    db.commit()
    return crawl_runs.view(crawl)


@router.get("/detail/{request_id}/bitbucket-sync")
def get_bitbucket_sync_status(
    request_id: str,
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    _require_review_manager(current_user)
    if not db.get(TestCaseReviewDetail, request_id):
        raise HTTPException(status_code=404, detail='Review request not found')
    record = db.query(BitbucketSync).filter(BitbucketSync.request_id == request_id).first()
    return {
        'config': bitbucket_sync.configuration_status(),
        'sync': bitbucket_sync.serialize_sync(record),
    }


@router.post("/detail/{request_id}/bitbucket-sync")
def sync_review_detail_to_bitbucket(
    request_id: str,
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    _require_review_manager(current_user)
    actor = (current_user or {}).get('username') or (current_user or {}).get('sub') or 'manager'
    try:
        record = bitbucket_sync.sync_review_request(db, request_id, actor)
    except bitbucket_sync.BitbucketSyncError as exc:
        message = str(exc)
        status = 503 if any(word in message.lower() for word in ('config', 'disabled', 'required')) else 502
        raise HTTPException(status_code=status, detail=message) from exc
    return {'success': True, 'sync': bitbucket_sync.serialize_sync(record)}

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
    # Approving or rejecting was open to any signed-in user: this endpoint
    # never checked the role its sibling endpoints check.
    _require_review_manager(current_user)
    detail = db.query(TestCaseReviewDetail).filter(TestCaseReviewDetail.request_id == request_id).first()
    if not detail:
        raise HTTPException(status_code=404, detail='Review request not found')
    if detail.overall_status == SAVED_STATUS:
        raise HTTPException(status_code=409, detail='This request has not been sent for approval yet.')

    decision = str(payload.get('decision') or '').upper()
    if decision in {'APPROVED', 'APPROVE'}:
        decision = 'APPROVE'
    elif decision in {'REJECTED', 'REJECT'}:
        decision = 'REJECT'
    if decision not in {'APPROVE', 'REJECT'}:
        raise HTTPException(status_code=400, detail='Decision must be APPROVE or REJECT')

    if decision == 'APPROVE':
        requested_ids = {
            str(row.get('test_case_id') or row.get('id'))
            for row in (payload.get('rows') or [])
            if row.get('test_case_id') or row.get('id')
        }
        all_request_rows = db.query(TestCaseDetail).filter(TestCaseDetail.request_id == request_id).all()
        approval_rows = (
            db.query(TestCaseDetail)
            .filter(TestCaseDetail.request_id == request_id, TestCaseDetail.status != DRAFT_STATUS)
            .all()
        )
        if requested_ids:
            approval_rows = [row for row in approval_rows if str(row.test_case_id) in requested_ids]
            if len(approval_rows) != len(requested_ids):
                raise HTTPException(status_code=400, detail='One or more selected test cases are not available for approval.')
        from ..services.automation.evaluation_handoff import linked_check, packet
        from ..models.automation import AutomationTestCase
        for row in approval_rows:
            if (row.test_case_details or {}).get('_agent_resolution'):
                check = linked_check(db, row)
                if not check or packet(check, db.get(AutomationTestCase, check.case_id))['state'] != 'ready':
                    raise HTTPException(status_code=409, detail='Complete the outstanding agent work in Human Evaluation before approving this case for automation.')
        if any(_case_application(row) is None for row in approval_rows):
            shared_application = _shared_request_application(db, all_request_rows)
            if shared_application is not None:
                for row in all_request_rows:
                    if _case_application(row) is None:
                        row.test_case_details = {**(row.test_case_details or {}), '_automation_application': shared_application}
        if any(_case_application(row) is None for row in approval_rows):
            raise HTTPException(
                status_code=409,
                detail='Select or register the application before approving these test cases.',
            )

    row_updates = payload.get('rows') or []
    if row_updates:
        for row in row_updates:
            test_case_id = row.get('test_case_id') or row.get('id')
            if not test_case_id:
                continue
            item = db.query(TestCaseDetail).filter(TestCaseDetail.request_id == request_id, TestCaseDetail.test_case_id == str(test_case_id)).first()
            if not item or str(item.status).upper() == DRAFT_STATUS:
                continue
            item.status = 'APPROVED' if decision == 'APPROVE' else 'REJECTED'
            item.reviewed_by = (current_user or {}).get('username') or (current_user or {}).get('sub') or 'manager'
            item.reviewed_datetime = _dubai_now()
            if decision == 'REJECT':
                item.rejection_reason = row.get('rejection_reason') or payload.get('review_notes') or 'Rejected by manager'
    else:
        test_cases = (
            db.query(TestCaseDetail)
            .filter(TestCaseDetail.request_id == request_id, TestCaseDetail.status != DRAFT_STATUS)
            .all()
        )
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


@router.put("/detail/{request_id}/application")
def assign_review_application(
    request_id: str,
    payload: Dict[str, Any],
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    """Persist the target application on every case in one review request."""
    _require_review_manager(current_user)
    detail = db.query(TestCaseReviewDetail).filter(TestCaseReviewDetail.request_id == request_id).first()
    if not detail:
        raise HTTPException(status_code=404, detail='Review request not found')

    from ..models.automation import AutomationApplication

    try:
        application_id = int(payload.get('application_id'))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail='Choose an application.')
    application = db.get(AutomationApplication, application_id)
    if application is None or not application.is_active:
        raise HTTPException(status_code=404, detail='The selected application is not available.')

    association = {
        'id': application.id,
        'name': application.name,
        'app_key': application.app_key,
        'base_url': application.base_url,
        'environment': application.environment,
    }
    rows = db.query(TestCaseDetail).filter(TestCaseDetail.request_id == request_id).all()
    if not rows:
        raise HTTPException(status_code=404, detail='No test cases were found for this request.')
    for row in rows:
        values = dict(row.test_case_details or {})
        values['_automation_application'] = association
        row.test_case_details = values
    db.commit()
    return {'success': True, 'application': association, 'updated': len(rows)}


@router.post("/delete")
def delete_review_requests(
    payload: Dict[str, Any],
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db),
):
    """Delete review requests and their test cases (Review & Approval).

    Cases already approved into Automation Studio are copies there and stay.
    AI Checks drafts still waiting on these requests go with them: nothing
    else could ever approve them now.
    """
    _require_review_manager(current_user)
    ids = [str(item) for item in (payload.get('request_ids') or []) if item]
    if not ids:
        raise HTTPException(status_code=400, detail='Choose the requests to delete.')
    details = db.query(TestCaseReviewDetail).filter(TestCaseReviewDetail.request_id.in_(ids)).all()
    if not details:
        raise HTTPException(status_code=404, detail='None of those requests exist.')
    found = [detail.request_id for detail in details]

    from ..models.automation import AutomationAICheck, AutomationTestCase
    from ..services.automation import ai_checks

    drafts = (
        db.query(AutomationTestCase)
        .filter(AutomationTestCase.origin == ai_checks.ORIGIN, AutomationTestCase.origin_request_id.in_(found))
        .all()
    )
    if drafts:
        db.query(AutomationAICheck).filter(
            AutomationAICheck.case_id.in_([case.id for case in drafts])
        ).delete(synchronize_session=False)
        for case in drafts:
            db.delete(case)

    cases = (
        db.query(TestCaseDetail)
        .filter(TestCaseDetail.request_id.in_(found))
        .delete(synchronize_session=False)
    )
    for detail in details:
        db.delete(detail)
    db.commit()
    return {'deleted': len(found), 'test_cases': cases, 'drafts': len(drafts)}


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
