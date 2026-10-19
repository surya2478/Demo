import asyncio
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database.connection import Base
from app.models.automation import AutomationAICheck, AutomationApplication, AutomationTestCase
from app.models.database import TestCaseDetail, TestCaseReviewDetail
from app.services.automation.evaluation_handoff import handoff, linked_check, packet
from app.routers.test_case_reviews import update_review_detail_decision


@pytest.fixture
def data():
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine, tables=[model.__table__ for model in (
        AutomationAICheck, AutomationApplication, AutomationTestCase, TestCaseDetail, TestCaseReviewDetail)])
    db = sessionmaker(bind=engine)()
    request = TestCaseReviewDetail(request_id='request', request_by='tester', ai_batch_id='batch', overall_status='AI_CHECKS', no_of_test_cases=1)
    row = TestCaseDetail(test_case_id='row', request_id='request', status='DRAFT', test_case_details={'Test Case ID': 'TC-001', 'Test Steps': 'Open catalog'})
    case = AutomationTestCase(id=1, display_id='TC-001', source='refined', origin='ai_checks', description='Open catalog', classification='undecided')
    check = AutomationAICheck(id=1, batch_id='batch', case_id=1, source_row=row.test_case_details, status='failed', error='Missing observed product control',
        steps={'_mode': 'agents', '_review_request_id': 'request', '_agent_setup': {'app_key': 'shop', 'environment': 'QA'},
               '_agents': {'requirements_guide': {'status': 'done'}, 'navigation_guide': {'status': 'failed', 'discovery_id': 11}}})
    db.add_all([request, row, case, check]); db.commit()
    yield db, request, row, case, check
    db.close(); engine.dispose()


def test_failed_work_is_handed_off_once_with_evidence_and_original(data):
    db, request, row, case, check = data
    assert handoff(db, check)
    assert row.status == 'PENDING' and request.overall_status == 'PENDING_REVIEW'
    assert row.test_case_details['Test Steps'] == 'Open catalog'
    assert row.test_case_details['_agent_resolution']['evidence']['navigation_guide']['discovery_id'] == 11
    assert '_ai' not in row.test_case_details
    assert linked_check(db, row) is check
    assert not handoff(db, check)
    assert db.query(TestCaseDetail).count() == 1


def test_batch_keeps_polling_until_worker_finalizes_handoff(data):
    from app.services.automation import ai_checks
    db, request, row, case, check = data
    with patch.object(ai_checks, '_is_active', return_value=True):
        view = ai_checks.batch_view(db, 'batch')
    assert view['status'] == 'running'
    assert view['finished_at'] is None
    assert view['items'][0]['evaluation_handoff'] is None
    with patch.object(ai_checks, '_is_active', return_value=False):
        view = ai_checks.batch_view(db, 'batch')
    assert view['status'] == 'complete'
    assert view['items'][0]['evaluation_handoff']['request_id'] == 'request'
    assert row.status == 'PENDING'


def test_browser_mode_is_persisted_and_locked_during_run(data):
    from app.services.automation import ai_checks
    db, request, row, case, check = data
    with patch.object(ai_checks, '_is_active', return_value=False):
        ai_checks.set_reuse_kb_evidence(db, 'batch', True, preference='headed')
    assert check.steps['_agent_setup']['headed'] is True
    assert check.steps['_agent_setup']['environment'] == 'QA'
    with patch.object(ai_checks, '_is_active', return_value=True), pytest.raises(ValueError):
        ai_checks.set_reuse_kb_evidence(db, 'batch', False, preference='headed')
    assert check.steps['_agent_setup']['headed'] is True


def test_approval_checks_live_state_even_with_stale_ready_snapshot(data):
    db, request, row, case, check = data
    handoff(db, check)
    row.test_case_details = {**row.test_case_details, '_agent_resolution': {**row.test_case_details['_agent_resolution'], 'state': 'ready'}}
    db.commit()
    with pytest.raises(HTTPException) as error:
        asyncio.run(update_review_detail_decision('request', {'decision': 'APPROVE'}, {'username': 'manager', 'roles': ['manager']}, db))
    assert error.value.status_code == 409
    assert row.status == 'PENDING'


def test_resume_refreshes_same_review_and_keeps_approved_rows_unchanged(data):
    db, request, row, case, check = data
    handoff(db, check)
    check.status = 'done'; case.classification = 'automation'
    check.steps = {**check.steps, '_agents': {'automation': {'status': 'done', 'crawl_id': 22}}}
    with patch('app.services.automation.ai_checks.attach_to_review', return_value={'check_id': 1, 'classification': 'automation'}):
        assert handoff(db, check)
    assert row.test_case_details['_agent_resolution']['state'] == 'ready'
    row.status = 'APPROVED'; db.commit()
    check.status = 'failed'
    assert not handoff(db, check)
    assert row.status == 'APPROVED'


def test_incomplete_browser_or_data_never_becomes_ready(data):
    db, request, row, case, check = data
    check.status = 'done'; case.classification = 'automation'
    assert packet(check, case)['state'] == 'needs_input'
    check.steps = {**check.steps, '_agents': {'automation': {'status': 'done', 'crawl_id': 22}}}
    case.test_data_status = 'pending'
    assert packet(check, case)['state'] == 'needs_input'


def test_recovery_summary_reaches_review_without_exposing_artifacts_or_granting_approval(data):
    db, request, row, case, check = data
    check.steps = {**check.steps,
        '_live_recoveries': [{'status': 'verified', 'change_set_id': 7, 'crawl_id': 3, 'internal': 'omit'}],
        '_live_navigation': {'source_actions': ['Open catalogue'], 'completed_steps': [1],
                             'script_verification': {'status': 'passed', 'script_path': 'private-path'}}}
    assert handoff(db, check)
    summary = row.test_case_details['_agent_resolution']
    assert summary['recovery'] == [{'status': 'verified', 'change_set_id': 7, 'crawl_id': 3}]
    assert summary['browser_summary'] == {'observed_instructions': 1, 'total_instructions': 1, 'replay_status': 'passed'}
    assert summary['state'] == 'needs_input'
    assert row.test_case_details['Test Steps'] == 'Open catalog'


def test_other_request_and_ambiguous_saved_case_are_not_used(data):
    db, request, row, case, check = data
    check.steps = {**check.steps, '_review_request_id': 'other'}
    assert not handoff(db, check)
    check.steps = {**check.steps, '_review_request_id': 'request'}
    db.add(TestCaseDetail(test_case_id='duplicate', request_id='request', status='DRAFT', test_case_details={'Test Case ID': 'TC-001'})); db.commit()
    with pytest.raises(ValueError, match='uniquely'):
        handoff(db, check)
    assert row.status == 'DRAFT'


def test_promotion_cannot_bypass_unresolved_handoff(data):
    from app.services.automation.ai_checks import promote_approved
    db, request, row, case, check = data
    handoff(db, check)
    assert not promote_approved(db, case, approved_by='manager', approved_at=None)
    assert case.origin == 'ai_checks'


def test_reset_retains_review_link_and_generated_original(data):
    from app.services.automation.ai_checks import _reset
    db, request, row, case, check = data
    handoff(db, check)
    check.steps = {**check.steps, '_original_source': {'Test Steps': 'Generated original'}}
    _reset(check)
    assert check.steps['_review_request_id'] == 'request'
    assert check.steps['_evaluation_handoff']['test_case_id'] == 'row'
    assert check.steps['_original_source']['Test Steps'] == 'Generated original'


def test_inline_steps_resume_rechecks_and_preserves_original(data):
    from app.routers.test_case_reviews import resume_review_agents
    db, request, row, case, check = data
    handoff(db, check)
    with patch('app.services.authz.user_has_permission', return_value=True), patch('app.services.automation.ai_checks._is_active', return_value=False), patch('app.services.automation.ai_checks._launch') as launch:
        result = resume_review_agents('request', 'row', {'steps': 'Open the catalogue then select a visible product'}, {'username': 'manager', 'roles': ['manager']}, db)
    assert result['status'] == 'queued'
    assert check.source_row['Test Steps'] == 'Open the catalogue then select a visible product'
    assert check.steps['_original_source']['Test Steps'] == 'Open catalog'
    assert check.steps['_agents']['requirements_guide']['status'] == 'waiting'
    launch.assert_called_once_with('batch', [1])


def test_inline_data_accepts_pending_handoff_not_approved_or_active(data):
    from app.services.automation.agent_test_data import _check
    db, request, row, case, check = data
    handoff(db, check)
    assert _check(db, 'batch', 1) is check
    check.status = 'running'
    with pytest.raises(ValueError):
        _check(db, 'batch', 1)
    check.status = 'failed'; row.status = 'APPROVED'; db.commit()
    with pytest.raises(ValueError):
        _check(db, 'batch', 1)
