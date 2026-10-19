import json
import os
import subprocess
import threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import pytest
from app.services.automation.agent_journey import crawl_focus_terms
from app.services.automation.discovery import build_discovery_spec
from app.services.automation.workspace import _render_playwright_config


@pytest.mark.skipif(os.getenv('RUN_BROWSER_RECOVERY_TESTS') != '1', reason='opt-in Chromium')
@pytest.mark.parametrize('target,branch,headed', [('Smart Living', 'postpaid', True), ('Travel Insurance', 'claims', False)])
def test_phrase_target_precedes_branch_noise(tmp_path, target, branch, headed):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self):
            body = ''.join(f'<a href="/{branch}/{i}">{branch} offers</a>' for i in range(15))
            body += f'<a href="/{target.lower().replace(" ", "")}">{target}</a>'
            body += f'<a href="http://localhost:1/wrong">{target} external</a>'
            self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers()
            self.wfile.write((body if self.path == '/' else '<h1>Target page</h1><button>Details</button>').encode())
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}'
    terms = crawl_focus_terms([f'Navigate to the {target} offer', f'Select {branch}'])
    spec = build_discovery_spec(base, max_pages=2, focus_terms=terms)
    (tmp_path / 'scan.spec.js').write_text(spec, encoding='utf-8')
    (tmp_path / 'playwright.config.ts').write_text(_render_playwright_config(base, '.', slow_mo_ms=0, headless=not headed), encoding='utf-8')
    runtime = Path(os.environ.get('AUTOMATION_PLAYWRIGHT_PROJECT', str(Path(__file__).resolve().parents[3])))
    try:
        run = subprocess.run(['node', str(runtime / 'node_modules/@playwright/test/cli.js'), 'test', '--config=playwright.config.ts'], cwd=tmp_path,
            env={**os.environ, 'NODE_PATH': str(runtime / 'node_modules')}, capture_output=True, text=True, timeout=110)
        assert run.returncode == 0, run.stdout + run.stderr
        data = json.loads((tmp_path / 'discovery.json').read_text())
        urls = [page['url'] for page in data['pages']]
        assert base + '/' + target.lower().replace(' ', '') in urls, urls
        assert all(url.startswith(base) for url in urls), urls
    finally:
        server.shutdown(); server.server_close()


@pytest.mark.skipif(os.getenv('RUN_EAND_PUBLIC_SCAN') != '1', reason='opt-in public regression')
def test_reported_public_offer_scan(tmp_path):
    terms = crawl_focus_terms(['Navigate to the Smart Home/Smart Living device offer', 'Select the I have a postpaid plan branch'])
    spec = build_discovery_spec('https://www.eand.ae/en/index.html', max_pages=4, focus_terms=terms)
    (tmp_path / 'scan.spec.js').write_text(spec, encoding='utf-8')
    (tmp_path / 'playwright.config.js').write_text("module.exports={testDir:'.',timeout:240000,use:{headless:true},workers:1};", encoding='utf-8')
    runtime = Path(os.environ.get('AUTOMATION_PLAYWRIGHT_PROJECT', str(Path(__file__).resolve().parents[3])))
    run = subprocess.run(['node', str(runtime / 'node_modules/@playwright/test/cli.js'), 'test', '--config=playwright.config.js'], cwd=tmp_path,
        env={**os.environ, 'NODE_PATH': str(runtime / 'node_modules')}, capture_output=True, text=True, timeout=260)
    assert run.returncode == 0, run.stdout + run.stderr
    data = json.loads((tmp_path / 'discovery.json').read_text())
    urls = [page['url'] for page in data['pages']]
    print('Observed public routes:', urls)
    print('Evidence file:', tmp_path / 'discovery.json')
    assert any('smart' in url.lower() for url in urls), urls
