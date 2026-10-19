import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from app.services.automation.live_navigation import BrowserSession


@pytest.mark.skipif(os.getenv('RUN_BROWSER_RECOVERY_TESTS') != '1', reason='real browser opt-in')
@pytest.mark.parametrize('title,choice', [('Catalogue', 'Brand A'), ('Flight search', 'Nonstop')])
def test_observed_icon_control_is_replayable_and_scoped(title, choice, tmp_path, monkeypatch):
    posts = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self):
            html = (f'<title>{title}</title><p id="result">Filtered results</p>'
                    f'<button onclick="document.querySelector(\'#result\').textContent=\'All results\'">{choice} <img alt="close icon"></button>'
                    '<button>Duplicate<img alt="icon"></button><button>Duplicate<img alt="icon"></button>'
                    '<button>Delete account</button><form><button>Continue</button></form>'
                    f'<div><span>{choice}</span><span><input type="checkbox" aria-label="checkbox" onchange="fetch(\'/data\',{{method:\'POST\'}}).then(r=>r.text()).then(t=>document.querySelector(\'#result\').textContent=t);fetch(\'/never-seen\',{{method:\'POST\'}}).catch(()=>{{}})"></span></div>'
                    '<div>Same<input type="checkbox" aria-label="checkbox"></div><div>Same<input type="checkbox" aria-label="checkbox"></div>'
                    '<a href="http://example.invalid/">Other host</a><a href="/next">Next screen</a>'
                    '<script>fetch("/data",{method:"POST"})</script>')
            self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers()
            self.wfile.write(html.encode())
        def do_POST(self):
            posts.append(self.path)
            self.send_response(200); self.end_headers(); self.wfile.write(b'Choice updated')
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with BrowserSession() as browser:
            state = browser.call(command='start', url=f'http://127.0.0.1:{server.server_port}/', authoring=True)
            controls = state['controls']
            assert not any(c['label'] in ('Duplicate icon', 'Delete account', 'Continue', 'Other host') for c in controls)
            assert not any(c['label'].startswith('Same') for c in controls)
            scoped = next(c for c in controls if c['label'] == f'{choice} (checkbox)')
            assert scoped['descriptor']['by'] == 'context'
            target = next(c for c in controls if c['label'] == f'{choice} close icon')
            after = browser.call(command='click', snapshot=state['snapshot'], candidate_id=target['id'])
            assert 'All results' in after['evidence']
            next_page = next(c for c in after['controls'] if c['label'] == 'Next screen')
            browser.call(command='click', snapshot=after['snapshot'], candidate_id=next_page['id'])
            with pytest.raises(RuntimeError, match='Stale or unobserved'):
                browser.call(command='click', snapshot=state['snapshot'], candidate_id=target['id'])
        from app.services.automation import live_authoring, workspace
        monkeypatch.setattr(workspace, 'storage_root', lambda: tmp_path)
        def planner(goal, state, history, fields):
            if not history:
                candidate = next(c for c in state['controls'] if c['label'] == f'{choice} (checkbox)')
                return live_authoring.Decision(action='click',candidate_id=candidate['id'],reason='Observed row choice')
            return live_authoring.Decision(action='complete_step',evidence='Choice updated',reason='Observed updated result')
        capture = live_authoring.author(f'http://127.0.0.1:{server.server_port}/', ['Toggle choice'], planner=planner)
        assert capture['status'] == 'authored', capture['issue']
        assert live_authoring.replay(capture)['status'] == 'passed'
        assert '/never-seen' not in posts
        assert posts.count('/data') >= 5  # initial loads plus observed view refresh and clean replay
    finally:
        server.shutdown(); server.server_close()
