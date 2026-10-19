import json
import os
from pathlib import Path
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest
from app.services.journeys import journey_record
from app.services.automation.agent_auth import _recorded_login


@pytest.mark.skipif(os.environ.get('RUN_BROWSER_RECOVERY_TESTS') != '1', reason='opt-in Chromium')
@pytest.mark.parametrize('mode', ['phone_otp', 'password'])
def test_first_login_records_real_controls_without_values(tmp_path, mode):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self):
            if self.path == '/account':
                body = '<h1>Account</h1><button>Log out</button>'
            elif self.path == '/code':
                body = '<label>OTP<input id="otp" autocomplete="one-time-code"></label><button onclick="location.href=\'/account\'">Verify</button>'
            elif mode == 'phone_otp':
                body = '<label>Mobile number<input id="mobile" type="tel"></label><button onclick="location.href=\'/code\'">Continue</button>'
            else:
                body = '<label>Username<input id="username"></label><label>Password<input id="password" type="password"></label><button onclick="location.href=\'/account\'">Sign in</button>'
            self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(body.encode())
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}'
    code = journey_record.build_spec({'entry': base, 'max_minutes': 1, 'allowed_origins': [base]})
    actions = "await page.locator('#mobile').fill('5550001234'); await page.getByRole('button',{name:'Continue',exact:true}).click(); await page.waitForURL('**/code'); await page.locator('#otp').fill('731294'); await page.getByRole('button',{name:'Verify',exact:true}).click();" if mode == 'phone_otp' else "await page.locator('#username').fill('synthetic-person'); await page.locator('#password').fill('SecretNeverPersist99'); await page.getByRole('button',{name:'Sign in',exact:true}).click();"
    code = code.replace('  const until = Date.now()', actions + " await page.waitForURL('**/account'); await page.waitForTimeout(1000); fs.writeFileSync(STOP,'finish');\n  const until = Date.now()")
    (tmp_path / 'capture.spec.js').write_text(code, encoding='utf-8')
    (tmp_path / 'playwright.config.js').write_text("module.exports={testDir:'.',timeout:60000,use:{headless:true},workers:1};", encoding='utf-8')
    runtime = Path(os.environ.get('AUTOMATION_PLAYWRIGHT_PROJECT', str(Path(__file__).resolve().parents[3])))
    try:
        run = subprocess.run(['node', str(runtime / 'node_modules/@playwright/test/cli.js'), 'test', '--config=playwright.config.js'], cwd=tmp_path,
            env={**os.environ, 'NODE_PATH': str(runtime / 'node_modules')}, capture_output=True, text=True, timeout=90)
        assert run.returncode == 0, run.stdout + run.stderr
        raw = (tmp_path / journey_record.OUTPUT_FILE).read_text()
        assert all(value not in raw for value in ['5550001234', '731294', 'synthetic-person', 'SecretNeverPersist99'])
        result = json.loads(raw)
        assert result['auth_success']['locator']['name'] == 'Log out'
        assert all(event['unique'] for event in result['events'])
        fields = {event.get('field') for event in result['events']}
        assert ('otp' in fields and 'mobile' in fields) if mode == 'phone_otp' else ('password' in fields and 'username' in fields)
        # Replay from the actual recorded controls in a new browser context.
        from app.services.automation.discovery import build_discovery_spec
        from unittest.mock import patch
        captured = journey_record.recording_steps(result)
        captured[0]['recorded'].update(url=base, route=base)
        for step, event in zip(captured[1:], result['events']):
            step['recorded']['url'] = event['url']
            step['recorded']['led_to'] = event.get('led_to')
        captured[-1]['recorded']['url'] = result['final_url']
        kb = SimpleNamespace(roles={'test_data_profiles': {'P': {'fields': [
            {'name': field, 'variable': 'TESTDATA_' + field.upper()} for field in ['mobile', 'username', 'password']]}}})
        journey = {'source': {'environment': 'QA'}, 'recorded_auth_success': result['auth_success'], 'steps': captured}
        with patch('app.services.automation.agent_auth.trusted_auth_origins', return_value=set()):
            auth = _recorded_login(kb, journey, base, 'P', 'QA')
        assert auth
        replay = build_discovery_spec(base, max_pages=1, auth=auth)
        # Simulates a person supplying a fresh OTP, never a reusable vault value.
        replay = replay.replace("phase = 'Signing in with Test Data';", "await page.addInitScript(() => { setTimeout(() => { const box=document.getElementById('otp'); if(box) { box.value='920173'; document.querySelector('button').click(); } },1500); });\nphase = 'Signing in with Test Data';")
        (tmp_path / 'replay.spec.js').write_text(replay, encoding='utf-8')
        run = subprocess.run(['node', str(runtime / 'node_modules/@playwright/test/cli.js'), 'test', 'replay.spec.js', '--config=playwright.config.js'], cwd=tmp_path,
            env={**os.environ, 'NODE_PATH': str(runtime / 'node_modules'), 'TESTDATA_MOBILE': '5550001234', 'TESTDATA_USERNAME': 'synthetic-person', 'TESTDATA_PASSWORD': 'SecretNeverPersist99'}, capture_output=True, text=True, timeout=90)
        assert run.returncode == 0, run.stdout + run.stderr
        assert json.loads((tmp_path / 'discovery.json').read_text())['auth']['verified'] is True
        from app.services.journeys import journey_crawl
        items = []
        for i, step in enumerate(captured):
            step['step_number'] = i + 1
            step['recorded']['fresh_otp'] = step['recorded'].get('field') == 'otp'
            items.append({'journey_id': 'TEST.LOGIN', 'step_number': i + 1, 'text': step['action'], 'auth_success': result['auth_success'],
                **journey_crawl._recorded_item(step, kb.roles['test_data_profiles']['P'])})
        plan = {'base_url': base, 'entry': base, 'items': items, 'screens': {}, 'signatures': {},
            'variables': sorted({item['variable'] for item in items if item.get('variable')})}
        walk = journey_crawl.build_spec(plan)
        walk = walk.replace('  const entry = { address:', "  await page.addInitScript(() => { setTimeout(() => { const box=document.getElementById('otp'); if(box) {box.value='920173'; document.querySelector('button').click();} },5000); });\n  const entry = { address:")
        (tmp_path / 'walk.spec.js').write_text(walk, encoding='utf-8')
        run = subprocess.run(['node', str(runtime / 'node_modules/@playwright/test/cli.js'), 'test', 'walk.spec.js', '--config=playwright.config.js'], cwd=tmp_path,
            env={**os.environ, 'NODE_PATH': str(runtime / 'node_modules'), 'TESTDATA_MOBILE': '5550001234', 'TESTDATA_USERNAME': 'synthetic-person', 'TESTDATA_PASSWORD': 'SecretNeverPersist99'}, capture_output=True, text=True, timeout=90)
        assert run.returncode == 0, run.stdout + run.stderr
        walked = json.loads((tmp_path / journey_crawl.OUTPUT_FILE).read_text())
        assert all(step['status'] in {'done', 'auto'} for step in walked['steps']), walked['steps']
        assert walked['final_url'].endswith('/account')
    finally:
        server.shutdown(); server.server_close()


def test_recorded_login_rejects_wrong_host_and_ambiguous_control(monkeypatch):
    monkeypatch.setattr('app.services.automation.agent_auth.trusted_auth_origins', lambda *args: set())
    kb = SimpleNamespace(roles={'test_data_profiles': {'P': {'fields': [{'name': 'mobile', 'variable': 'TESTDATA_MOBILE'}]}}})
    rec = {'kind': 'fill', 'field': 'mobile', 'url': 'https://app.test/login', 'unique': True, 'target': '//input[@id="mobile"]'}
    journey = {'source': {'environment': 'QA'}, 'recorded_auth_success': {'url': 'https://app.test/account', 'locator': {'strategy': 'role', 'role': 'button', 'name': 'Log out'}}, 'steps': [
        {'recorded': {'kind': 'goto', 'url': 'https://app.test/login'}}, {'recorded': rec},
        {'recorded': {'kind': 'click', 'url': 'https://app.test/login', 'unique': True, 'target': '//button'}}]}
    assert _recorded_login(kb, journey, 'https://app.test', 'P', 'QA')
    rec['url'] = 'https://wrong.test/login'
    assert _recorded_login(kb, journey, 'https://app.test', 'P', 'QA') is None
    rec['url'] = 'https://app.test/login'; rec['unique'] = False
    assert _recorded_login(kb, journey, 'https://app.test', 'P', 'QA') is None


def test_new_recording_drafts_without_existing_journey(tmp_path, monkeypatch):
    import shutil
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    from app.database.connection import Base
    from app.models.kb_changes import KbCrawlRun, KbChangeSet, KbChange, KbVersion
    from app.services.journeys import store
    from app.services.automation import knowledge_base
    root = Path(__file__).resolve().parents[2] / 'knowledge_base'
    shutil.copytree(root / 'journeys/saucedemo', tmp_path / 'journeys/saucedemo')
    shutil.copytree(root / 'applications/saucedemo', tmp_path / 'applications/saucedemo')
    monkeypatch.setenv('JOURNEY_KB_PATH', str(tmp_path / 'journeys'))
    monkeypatch.setattr(knowledge_base, 'KB_ROOT_DIR', tmp_path / 'applications')
    monkeypatch.setattr(knowledge_base, 'get_kb_root', lambda: tmp_path / 'applications')
    kb = store.load('saucedemo')
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine, tables=[model.__table__ for model in [KbCrawlRun, KbChangeSet, KbChange, KbVersion]])
    with Session(engine) as db:
        steps = [{'action': 'Open login', 'recorded': {'kind': 'goto', 'url': 'https://app.test/login', 'route': 'https://app.test/login'}},
                 {'action': 'Enter mobile number', 'recorded': {'kind': 'fill', 'field': 'mobile', 'url': 'https://app.test/login', 'target': '//input[@id="mobile"]', 'unique': True}}]
        crawl = KbCrawlRun(app_id='saucedemo', journey_id='NEW.LOGIN', status='completed', environment='QA',
            plan={'source': 'record', 'new_journey': True, 'journey_name': 'New login', 'allowed_origins': ['https://app.test']}, result={'recording': steps})
        db.add(crawl); db.commit()
        assert 'NEW.LOGIN' not in kb.journeys
        from copy import deepcopy
        tampered = deepcopy(steps)
        tampered[1]['recorded']['target'] = '//input'
        with pytest.raises(journey_record.RecordError, match='not captured'):
            journey_record.save(db, crawl.id, tampered, link_flow='new', actor='test')
        untrusted = deepcopy(steps)
        untrusted[1]['recorded']['url'] = 'https://unapproved.test/login'
        crawl.result = {'recording': untrusted}
        with pytest.raises(journey_record.RecordError, match='unapproved host'):
            journey_record.save(db, crawl.id, untrusted, link_flow='new', actor='test')
        crawl.result = {'recording': steps}
        result = journey_record.save(db, crawl.id, steps, link_flow='new', actor='test')
        assert result['journey'].status == result['automation'].status == 'draft'
        assert journey_record.save(db, crawl.id, steps, link_flow='new', actor='test')['journey'].id == result['journey'].id
        from app.services.journeys import changesets
        changesets.publish_with_pair(db, result['journey'].id, actor='test')
        assert 'NEW.LOGIN' in store.load('saucedemo').journeys
