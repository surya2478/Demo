"""Real browser capture and replay; deterministic planner isolates transport."""
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import pytest
from app.services.automation.live_navigation import BrowserSession, NavigationDecision, capture
from app.config import settings


@pytest.fixture
def site():
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Type','text/html')
            self.end_headers()
            if self.path.split('?')[0] == '/':
                body = '''<title>Public catalogue</title>
                  <button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.querySelector('nav').hidden=false">Explore</button>
                  <nav hidden><a href="/devices">Devices</a><a href="/flights">Flights</a></nav>
                  <a href="https://outside.invalid/">External</a>
                  <a href="/one">Duplicate</a><a href="/one">Duplicate</a>
                  <a href="/checkout">Checkout</a><button>Submit</button>'''
                if '?consent' in self.path:
                    body += '''<aside id="privacy"></aside><script>
                      const host=document.getElementById('privacy');
                      const root=host.attachShadow({mode:'open'});
                      root.innerHTML='<section style="position:fixed;inset:0;background:white;z-index:9999"><p>Optional cookies</p><button>Deny</button></section>';
                      root.querySelector('button').onclick=()=>host.remove();
                    </script>'''
                if '?preferences' in self.path:
                    body += '''<aside id="privacy"></aside><script>
                      const host=document.getElementById('privacy');
                      const root=host.attachShadow({mode:'open'});
                      root.innerHTML='<section style="position:fixed;inset:0;background:white;z-index:9999"><p>Cookies</p><button>Manage my preferences</button></section>';
                      root.querySelector('button').onclick=()=>setTimeout(()=>{
                        root.querySelector('section').innerHTML='<p>Technologies</p><button>Save Settings</button>';
                        root.querySelector('button').onclick=()=>host.remove();
                      },250);
                    </script>'''
            else:
                body = '<title>Observed destination</title><h1>Details</h1>'
            self.wfile.write(body.encode())
    server = ThreadingHTTPServer(('127.0.0.1',0),Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    yield f'http://127.0.0.1:{server.server_port}/'
    server.shutdown()
    server.server_close()


pytestmark = pytest.mark.skipif(os.getenv('RUN_BROWSER_RECOVERY_TESTS') != '1',reason='opt-in real browsers')


@pytest.mark.parametrize('destination,headed',[('Devices',True),('Flights',False)])
def test_live_menu_capture_and_recorded_replay(site,destination,headed):
    def plan(actions,snapshot,history):
        if snapshot['url'].rstrip('/').endswith(destination.lower()):
            return NavigationDecision(action='stop',reason='Requested destination observed')
        target = 'Explore' if not history else destination
        candidate = next(c for c in snapshot['controls'] if c['label']==target)
        return NavigationDecision(action='click',candidate_id=candidate['id'],reason='Observed target')
    result = capture(site,[f'Open {destination}'],headed=headed,planner=plan)
    assert [t['label'] for t in result['trace']] == ['Explore',destination], result
    assert result['pages'][-1]['url'] == site + destination.lower()
    # Replay the captured controls, with no planner and a fresh browser session.
    with BrowserSession() as browser:
        state = browser.call(command='start',url=site,headed=headed,channel=settings.AUTOMATION_HEADED_BROWSER_CHANNEL)
        for transition in result['trace']:
            matches = [c for c in state['controls'] if c['label']==transition['label'] and c['role']==transition['role']]
            assert len(matches)==1
            state = browser.call(command='click',snapshot=state['snapshot'],candidate_id=matches[0]['id'])
            assert state['url']==transition['to_url']


def test_wrong_host_ambiguous_and_mutating_controls_excluded(site):
    with BrowserSession() as browser:
        state = browser.call(command='start',url=site,headed=False)
        assert [c['label'] for c in state['controls']] == ['Explore']
        with pytest.raises(RuntimeError,match='Stale or unobserved'):
            browser.call(command='click',snapshot=state['snapshot']-1,candidate_id=0)


def test_model_cannot_invent_candidate(site):
    result = capture(site,['Open Devices'],planner=lambda *_: NavigationDecision(action='click',candidate_id=999,reason='Invented'))
    assert result['trace'] == []
    assert 'unobserved control' in result['issue']


def test_cookie_consent_in_shadow_root_is_resolved_without_force_click(site):
    with BrowserSession() as browser:
        state = browser.call(command='start',url=site+'?consent',headed=False)
        selected = next(c for c in state['controls'] if c['label']=='Explore')
        state = browser.call(command='click',snapshot=state['snapshot'],candidate_id=selected['id'])
        assert 'Devices' in [c['label'] for c in state['controls']]


def test_consent_preferences_keep_verified_shadow_scope(site):
    with BrowserSession() as browser:
        state = browser.call(command='start',url=site+'?preferences',headed=False)
        selected = next(c for c in state['controls'] if c['label']=='Explore')
        state = browser.call(command='click',snapshot=state['snapshot'],candidate_id=selected['id'])
        assert 'Devices' in [c['label'] for c in state['controls']]
