import unittest
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database.connection import Base
from app.models.automation import AutomationAICheck, AutomationTestCase
from app.services.automation.agent_test_data import _observed_requirement_fields, _ready_profiles, _required_fields, assign_existing


class ApprovalManagerDataTests(unittest.TestCase):
    def test_unmapped_case_fields_recovered_from_observed_entry_page(self):
        def control(route, label, locator):
            return type('Control', (), {'page_url': f'https://example.test/app/{route}', 'role': 'textbox',
                                        'accessible_name': label, 'recommended_locator': locator,
                                        'confidence_score': 88})()
        controls = [control('register.htm', 'username', 'page.locator("#registration")'),
                    control('index.htm', 'username', 'page.locator("[name=username]")'),
                    control('index.htm', 'password', 'page.locator("[name=password]")')]
        fields = _observed_requirement_fields(controls, 'https://example.test/app', ['username', 'password'])
        self.assertEqual([field['variable'] for field in fields], ['TESTDATA_USERNAME', 'TESTDATA_PASSWORD'])
        self.assertTrue(fields[1]['is_secret'])

    def test_requirement_aliases_match_ready_profile_in_same_environment(self):
        case = type('Case', (), {'test_data_requirements': [
            {'key': 'valid_username'}, {'key': 'valid_password'},
        ]})()
        requirements = _required_fields(case)
        self.assertEqual(requirements, ['username', 'password'])
        profiles = [{
            'kind': 'vault', 'profile_id': 'login',
            'fields': [{'variable': 'TESTDATA_USERNAME'}, {'variable': 'TESTDATA_PASSWORD'}],
            'cells': {'PREPRODUCTION': {'status': 'ready'}, 'SIT': {'status': 'missing'}},
        }]
        self.assertEqual([p['profile_id'] for p in _ready_profiles(profiles, 'PREPRODUCTION', requirements)], ['login'])
        self.assertEqual(_ready_profiles(profiles, 'SIT', requirements), [])

    def test_unrelated_ready_profile_is_not_selected(self):
        profiles = [{
            'kind': 'vault', 'profile_id': 'registration',
            'fields': [{'variable': 'TESTDATA_FIRST_NAME'}, {'variable': 'TESTDATA_PASSWORD'}],
            'cells': {'QA': {'status': 'ready'}},
        }]
        self.assertEqual(_ready_profiles(profiles, 'QA', ['username', 'password']), [])
        self.assertEqual(_ready_profiles(profiles, 'QA', []), [])

    def test_assigning_stored_profile_replaces_only_missing_references(self):
        engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
        Base.metadata.create_all(engine, tables=[AutomationTestCase.__table__, AutomationAICheck.__table__])
        db = sessionmaker(bind=engine)()
        try:
            case = AutomationTestCase(
                source='refined', display_id='TC-006', test_data_status='pending',
                steps_structured=[
                    {'action': 'Enter username', 'test_data_ref': '<<TODO: valid username>>'},
                    {'action': 'Enter password', 'test_data_ref': '<<TODO: valid password>>'},
                    {'action': 'Click Log In', 'test_data_ref': None},
                ],
            )
            db.add(case)
            db.flush()
            check = AutomationAICheck(
                batch_id='batch', case_id=case.id, source_row={}, status='awaiting_approval',
                steps={'_mode': 'agents', '_agent_setup': {'app_key': 'bank_test', 'environment': 'PREPRODUCTION'}},
            )
            db.add(check)
            db.commit()
            with patch('app.services.automation.agent_test_data.suggestion', return_value={
                'ready_profile_ids': ['login'], 'requirements': ['username', 'password'],
                'environment': 'PREPRODUCTION',
            }):
                assign_existing(db, 'batch', check.id, profile_id='login', actor='manager')
            db.refresh(case)
            self.assertEqual(case.test_data_status, 'kb_provided')
            self.assertEqual([step['test_data_ref'] for step in case.steps_structured], ['username', 'password', None])
            self.assertEqual((check.steps or {})['_agent_setup']['profile_id'], 'login')
        finally:
            db.close()
            engine.dispose()


if __name__ == '__main__':
    unittest.main()
