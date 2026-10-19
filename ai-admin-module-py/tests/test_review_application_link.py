"""Regression tests for applications on cases sent from saved AI-check drafts."""

import asyncio
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database.connection import Base
from app.models.automation import AutomationApplication, AutomationDeletedOrigin
from app.models.database import TestCaseDetail, TestCaseReviewDetail
from app.routers.test_case_reviews import (
    _request_summary,
    _send_saved_request,
    update_review_detail_decision,
)


class ReviewApplicationLinkTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            'sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool
        )
        Base.metadata.create_all(
            self.engine,
            tables=[
                AutomationApplication.__table__,
                AutomationDeletedOrigin.__table__,
                TestCaseReviewDetail.__table__,
                TestCaseDetail.__table__,
            ],
        )
        self.db = sessionmaker(bind=self.engine)()
        app = AutomationApplication(
            id=2, name='BANK TEST', app_key='bank_test', base_url='https://example.test',
            environment='PREPRODUCTION', is_active=True,
        )
        detail = TestCaseReviewDetail(
            request_id='REQ-test', request_by='admin', overall_status='PARTIALLY_APPROVED',
            no_of_test_cases=2, approved_count=1, rejected_count=0,
        )
        self.db.add_all([app, detail])
        self.db.flush()
        self.application = {
            'id': 2, 'name': 'BANK TEST', 'app_key': 'bank_test',
            'base_url': 'https://example.test', 'environment': 'PREPRODUCTION',
        }
        self.db.add_all([
            TestCaseDetail(
                test_case_id='TC-1', request_id='REQ-test', status='APPROVED',
                test_case_details={'_automation_application': self.application},
            ),
            TestCaseDetail(
                test_case_id='TC-2', request_id='REQ-test', status='DRAFT',
                test_case_details={'_automation_application': self.application},
            ),
        ])
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def test_sending_saved_case_preserves_application(self):
        detail = self.db.get(TestCaseReviewDetail, 'REQ-test')
        _send_saved_request(
            detail,
            {'rows': [{'test_case_id': 'TC-2', 'test_case_details': {'Title': 'Edited'}}]},
            'admin', self.db,
        )
        case = self.db.get(TestCaseDetail, 'TC-2')
        self.assertEqual(case.test_case_details['_automation_application']['id'], 2)
        self.assertEqual(case.test_case_details['Title'], 'Edited')
        self.assertTrue(_request_summary(detail, [case])['application_complete'])

    def test_sending_new_case_inherits_request_application(self):
        detail = self.db.get(TestCaseReviewDetail, 'REQ-test')
        _send_saved_request(
            detail,
            {'rows': [{'test_case_id': 'TC-3', 'test_case_details': {'Title': 'New'}}]},
            'admin', self.db,
        )
        case = self.db.get(TestCaseDetail, 'TC-3')
        self.assertEqual(case.test_case_details['_automation_application']['id'], 2)

    def test_approval_repairs_legacy_missing_link_on_same_request(self):
        case = self.db.get(TestCaseDetail, 'TC-2')
        case.status = 'PENDING'
        case.test_case_details = {'Title': 'Edited'}
        self.db.commit()
        detail = self.db.get(TestCaseReviewDetail, 'REQ-test')
        self.assertFalse(_request_summary(detail, [self.db.get(TestCaseDetail, 'TC-1'), case])['application_complete'])

        with patch('app.services.automation.workbench.sync_approved_test_cases'):
            asyncio.run(update_review_detail_decision(
                'REQ-test', {'decision': 'APPROVE', 'rows': [{'test_case_id': 'TC-2'}]},
                {'username': 'manager', 'roles': ['manager']}, self.db,
            ))

        self.db.refresh(case)
        self.assertEqual(case.status, 'APPROVED')
        self.assertEqual(case.test_case_details['_automation_application']['id'], 2)

    def test_approval_still_requires_explicit_choice_without_link(self):
        for case in self.db.query(TestCaseDetail).all():
            case.test_case_details = {}
        self.db.commit()
        with self.assertRaises(HTTPException) as error:
            asyncio.run(update_review_detail_decision(
                'REQ-test', {'decision': 'APPROVE', 'rows': [{'test_case_id': 'TC-1'}]},
                {'username': 'manager', 'roles': ['manager']}, self.db,
            ))
        self.assertEqual(error.exception.status_code, 409)

    def test_approval_rejects_unsent_draft(self):
        with self.assertRaises(HTTPException) as error:
            asyncio.run(update_review_detail_decision(
                'REQ-test', {'decision': 'APPROVE', 'rows': [{'test_case_id': 'TC-2'}]},
                {'username': 'manager', 'roles': ['manager']}, self.db,
            ))
        self.assertEqual(error.exception.status_code, 400)


if __name__ == '__main__':
    unittest.main()
