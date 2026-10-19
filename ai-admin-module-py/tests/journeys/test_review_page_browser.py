"""Opt-in Chromium coverage of human-supplied page evidence, not model output."""
import json
import os
from pathlib import Path
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from app.services.automation.discovery import build_discovery_spec, validated_capture_urls


def test_review_page_rejects_other_host():
    with pytest.raises(ValueError):
        validated_capture_urls('https://shop.example/', ['https://other.example/login'])


@pytest.mark.skipif(os.environ.get('RUN_BROWSER_RECOVERY_TESTS') != '1', reason='opt-in Chromium')
@pytest.mark.parametrize('label', ['Device options', 'Travel dates'])
def test_review_page_is_observed_without_an_existing_link(tmp_path, label):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_GET(self):
            html = f'<h1>Additional page</h1><label>{label}<input></label>' if self.path == '/missing' else '<h1>Home without links</h1>'
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            self.wfile.write(html.encode())
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}'
    runtime = Path(__file__).resolve().parents[3]
    runtime = Path(os.environ.get('AUTOMATION_PLAYWRIGHT_PROJECT', str(runtime)))
    (tmp_path / 'discovery.spec.js').write_text(build_discovery_spec(base + '/', max_pages=2, additional_urls=[base + '/missing']), encoding='utf-8')
    (tmp_path / 'playwright.config.js').write_text("module.exports={testDir:'.',timeout:60000,use:{headless:true},workers:1};", encoding='utf-8')
    try:
        result = subprocess.run(['node', str(runtime / 'node_modules/@playwright/test/cli.js'), 'test', '--config=playwright.config.js'], cwd=tmp_path,
            env={**os.environ, 'NODE_PATH': str(runtime / 'node_modules')}, text=True, capture_output=True, timeout=90)
        assert result.returncode == 0, result.stdout + result.stderr
        evidence = json.loads((tmp_path / 'discovery.json').read_text())
        assert any(item.get('accessible_name') == label for item in evidence['elements'])
    finally:
        server.shutdown()
        server.server_close()
