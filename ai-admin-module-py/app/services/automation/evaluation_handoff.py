"""Durable, idempotent handoff of agent work to the human resolution workspace."""
from datetime import datetime

from ...models.automation import AutomationAICheck, AutomationTestCase
from ...models.database import TestCaseDetail, TestCaseReviewDetail


def packet(check, case):
    state = check.steps or {}
    setup = state.get('_agent_setup') or {}
    agents = state.get('_agents') or {}
    capture = state.get('_live_navigation') or {}
    ready = bool(check.status == 'done' and case and case.classification == 'automation'
                 and case.test_data_status != 'pending' and not state.get('_kb_publication_held')
                 and (agents.get('automation') or {}).get('status') == 'done'
                 and (agents.get('automation') or {}).get('crawl_id'))
    active = check.status in {'running', 'queued'}
    return {
        'check_id': check.id, 'batch_id': check.batch_id,
        'recording_id': state.get('_review_recording_id'),
        'state': 'working' if active else 'ready' if ready else 'needs_input',
        'reason': None if ready else check.error or (case.classification_reason if case else None)
                  or 'The agents need more evidence before this case can produce a verified script.',
        'completed_agents': [name for name, value in agents.items() if value.get('status') == 'done'],
        'recovery': [{key: attempt[key] for key in ('status', 'at', 'crawl_id', 'change_set_id') if key in attempt}
                     for attempt in state.get('_live_recoveries') or []],
        'browser_summary': {
            'observed_instructions': len(capture.get('completed_steps') or []),
            'total_instructions': len(capture.get('source_actions') or []),
            'replay_status': (capture.get('script_verification') or {}).get('status', 'not_verified'),
        },
        'setup': {key: setup.get(key) for key in ('app_key', 'application_id', 'environment', 'profile_id', 'reuse_kb_evidence')},
        'evidence': {name: {key: value[key] for key in ('discovery_id', 'crawl_id', 'journey_id', 'change_set_ids') if key in value}
                     for name, value in agents.items() if any(key in value for key in ('discovery_id', 'crawl_id', 'journey_id', 'change_set_ids'))},
    }


def linked_check(db, row):
    ref = (row.test_case_details or {}).get('_agent_resolution') or {}
    check = db.get(AutomationAICheck, ref.get('check_id')) if ref.get('check_id') else None
    if not check or check.batch_id != ref.get('batch_id'):
        return None
    case = db.get(AutomationTestCase, check.case_id) if check.case_id else None
    if not case or case.origin_request_id != row.request_id or case.origin_test_case_id != row.test_case_id:
        return None
    return check


def handoff(db, check):
    """Publish partial work after recovery ends; never overwrite a human decision."""
    state = check.steps or {}
    if state.get('_mode') != 'agents' or check.status not in {'done', 'failed', 'awaiting_approval'}:
        return False
    request_id = state.get('_review_request_id')
    request = (db.query(TestCaseReviewDetail).filter(TestCaseReviewDetail.request_id == request_id).first()
               if request_id else db.query(TestCaseReviewDetail).filter(TestCaseReviewDetail.ai_batch_id == check.batch_id).first())
    if not request:
        return False
    case = db.get(AutomationTestCase, check.case_id) if check.case_id else None
    if not case:
        return False
    from . import workbench as wb
    rows = db.query(TestCaseDetail).filter(TestCaseDetail.request_id == request.request_id).all()
    matches = [row for row in rows if row.test_case_id == case.origin_test_case_id] if case.origin_test_case_id else [
        row for row in rows if wb.detail_value(row.test_case_details or {}, 'display_id') == case.display_id]
    if len(matches) != 1:
        raise ValueError('The agent result could not be matched uniquely to its saved test case.')
    row = matches[0]
    if row.status not in {'DRAFT', 'PENDING'}:
        return False
    case.origin_request_id = request.request_id
    case.origin_test_case_id = row.test_case_id
    details = dict(row.test_case_details or {})
    details['_agent_resolution'] = packet(check, case)
    setup = state.get('_agent_setup') or {}
    if setup.get('application_id'):
        from ...models.automation import AutomationApplication
        app = db.get(AutomationApplication, setup['application_id'])
        if app:
            details['_automation_application'] = {'id': app.id, 'name': app.name,
                'app_key': setup.get('app_key'), 'base_url': case.application_url,
                'environment': setup.get('environment')}
    if check.status == 'done':
        from .ai_checks import attach_to_review
        details['_ai'] = attach_to_review(db, check.id, test_case_id=row.test_case_id, request_id=request.request_id)
        details.update({'Test Case Description': case.description, 'Preconditions': case.preconditions or 'None',
                        'Test Steps': case.steps_raw or details.get('Test Steps', ''),
                        'Expected Result': case.expected_result or '', 'Test Data': case.test_data or 'None'})
    if row.status == 'PENDING' and row.test_case_details == details and state.get('_evaluation_handoff'):
        return False
    row.test_case_details = details
    row.status = 'PENDING'
    request.overall_status = 'PARTIALLY_APPROVED' if request.approved_count or request.rejected_count else 'PENDING_REVIEW'
    request.no_of_test_cases = sum(item.status != 'DRAFT' for item in rows)
    check.steps = {**state, '_review_request_id': request.request_id,
                   '_evaluation_handoff': {'request_id': request.request_id, 'test_case_id': row.test_case_id,
                                           'updated_at': datetime.now().isoformat()}}
    db.commit()
    return True
