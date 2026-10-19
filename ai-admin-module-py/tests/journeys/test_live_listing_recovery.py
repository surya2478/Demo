import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from app.services.automation import live_authoring as live


def test_failed_recovery_preserves_capture_and_reserves_budget(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import Mock
    from app.services.automation import ai_checks, agent_auth, agent_journey
    old = {'status': 'authored', 'entry_url': 'https://shop.test/', 'trace': []}
    check = SimpleNamespace(id=1, case_id=2, batch_id='batch', steps={'_live_navigation': old}, requested_by='tester')
    monkeypatch.setattr(agent_journey, 'source_steps', lambda row: ['Open product'])
    monkeypatch.setattr(agent_journey, 'source_expected', lambda row: 'Details')
    monkeypatch.setattr(agent_auth, 'requires_signed_in_browser', lambda *a: False)
    monkeypatch.setattr(live, 'selected_fields', lambda *a: {})
    recover = Mock(return_value={'status': 'incomplete', 'issue': 'No unique observed product'})
    monkeypatch.setattr(live, 'recover_guest_capture', recover)
    args = dict(setup={}, journey_id='J', row={}, crawl_id=3, address='https://shop.test/', application_id=4)
    ok, reason = ai_checks._recover_automation_gap(Mock(), check, **args)
    assert not ok and 'No unique' in reason
    assert check.steps['_live_navigation'] is old
    assert check.steps['_live_recoveries'][0]['status'] == 'unresolved'
    ok, reason = ai_checks._recover_automation_gap(Mock(), check, **args)
    assert not ok and 'exhausted' in reason
    assert recover.call_count == 1


def test_verified_recovery_drafts_new_journey_and_invokes_assigned_policy(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import Mock
    from app.services.automation import ai_checks, agent_auth, agent_journey, agent_approval
    capture = {'status': 'authored', 'script_verification': {'status': 'passed'}, 'trace': []}
    check = SimpleNamespace(id=1, case_id=2, batch_id='batch', requested_by='tester',
                            steps={'_live_navigation': {'status': 'authored'}})
    monkeypatch.setattr(agent_journey, 'source_steps', lambda row: ['Open product'])
    monkeypatch.setattr(agent_journey, 'source_expected', lambda row: 'Details')
    monkeypatch.setattr(agent_auth, 'requires_signed_in_browser', lambda *a: False)
    monkeypatch.setattr(live, 'selected_fields', lambda *a: {})
    monkeypatch.setattr(live, 'recover_guest_capture', lambda *a, **k: capture)
    monkeypatch.setattr(live, 'journey_bindings', lambda *a: ([{'screen_id': 'S'}], {'S': {}}))
    draft = Mock(return_value=(7, 'J', []))
    monkeypatch.setattr(agent_journey, 'draft_from_case', draft)
    approve = Mock()
    monkeypatch.setattr(agent_approval, 'decide_if_delegated', approve)
    monkeypatch.setattr(ai_checks, '_set_agent', Mock())
    db = Mock()
    ok, reason = ai_checks._recover_automation_gap(db, check, setup={'app_key': 'shop'},
        journey_id='J', row={}, crawl_id=3, address='https://shop.test/', application_id=4)
    assert ok and reason is None
    assert draft.call_args.kwargs['authored_capture'] is capture
    assert check.steps['_agent_plan']['change_set_id'] == 7
    assert check.steps['_live_recoveries'][0]['status'] == 'verified'
    assert check.status == 'awaiting_approval'
    approve.assert_called_once_with(db, check)


@pytest.mark.parametrize('change', ['host', 'actions', 'expected', 'form'])
def test_recovery_rejects_changed_scope_before_browser(monkeypatch, change):
    previous = dict(entry_url='https://shop.test/', source_actions=['Open a product'], expected_result='Details', trace=[])
    if change == 'host': previous['entry_url'] = 'https://wrong.test/'
    if change == 'actions': previous['source_actions'] = ['Buy a product']
    if change == 'expected': previous['expected_result'] = 'Anything'
    if change == 'form': previous['trace'] = [{'operation': 'fill'}]
    monkeypatch.setattr(live, 'author', lambda *a, **k: pytest.fail('Browser must not open'))
    with pytest.raises(ValueError):
        live.recover_guest_capture(previous, 'https://shop.test/', ['Open a product'], 'Details')


@pytest.mark.skipif(os.getenv('RUN_BROWSER_RECOVERY_TESTS') != '1', reason='real browser opt-in')
@pytest.mark.parametrize('noun', ['Phone', 'Flight'])
def test_changed_listing_reauthors_and_replays_original_intent(noun, tmp_path, monkeypatch):
    version = ['old']
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            content = (f'<h1>{noun} details {version[0]}</h1>' if self.path == '/'+version[0]
                       else f'<h1>{noun} listing</h1><a href="/{version[0]}">View available {noun}</a>'
                       '<a href="https://wrong.invalid/product">Outside</a>')
            self.wfile.write(content.encode())
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    address = f'http://127.0.0.1:{server.server_port}/'
    actions = [f'Open an available {noun}']
    def planner(goal, state, *_):
        assert goal == actions[0]  # No stale expanded product name added.
        if state['url'].endswith('/'+version[0]):
            return live.Decision(action='complete_step', evidence_kind='text', evidence=f'{noun} details {version[0]}', reason='Observed details')
        candidates = [c for c in state['controls'] if c['label'] == f'View available {noun}']
        assert len(candidates) == 1
        assert not any(c.get('href', '').startswith('https://wrong.invalid') for c in state['controls'])
        return live.Decision(action='click', candidate_id=candidates[0]['id'], reason='Current listing evidence')
    from app.services.automation import workspace
    monkeypatch.setattr(workspace, 'storage_root', lambda: tmp_path)
    try:
        old = live.author(address, actions, planner=planner)
        assert old['status'] == 'authored', old['issue']
        version[0] = 'new'
        updated = live.recover_guest_capture(old, address, actions, '', planner=planner)
        assert updated['status'] == 'authored', updated['issue']
        assert updated['script_verification']['status'] == 'passed'
        assert old['trace'][0]['to_url'].endswith('/old')
        assert updated['trace'][0]['to_url'].endswith('/new')
        bindings, screens = live.journey_bindings(updated)
        assert live.verify_expanded_journey({'steps': bindings, 'source': {'live_authoring': updated}}, screens, actions, '', address)
    finally:
        server.shutdown()
