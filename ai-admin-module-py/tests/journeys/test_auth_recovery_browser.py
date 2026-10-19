"""Opt-in REAL Chromium checks of generated discovery against two fresh apps.

RUN_BROWSER_RECOVERY_TESTS=1 enables local synthetic fixtures only. No real
credentials, project KB mutations, external submissions or model calls.
"""
import json
import os
from pathlib import Path
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from app.services.automation.discovery import build_discovery_spec

pytestmark = pytest.mark.skipif(os.environ.get("RUN_BROWSER_RECOVERY_TESTS") != "1", reason="opt-in real browser integration")


@pytest.mark.parametrize("application,invalid,wrong_screen", [("retail", False, False), ("portal", False, False), ("retail", True, False), ("portal", False, True)])
def test_generated_authenticated_discovery(tmp_path, application, invalid, wrong_screen):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            if self.path.startswith("/signed-in"):
                html = '<h1>My workspace</h1><button id="identity">Active identity</button><a href="/logout">Log Out</a><p>Delivery method</p><select id="delivery"><option>PRIVATE-OPTION-123</option></select>'
            elif application == "portal" and self.path.startswith("/password"):
                html = '<label>Password<input id="secret" type="password"></label><button onclick="finish()">Continue</button>' + script
            else:
                html = '<label>Email<input id="identity"></label>'
                if application == "retail":
                    html += '<label>Password<input id="secret" type="password"></label><button onclick="finish()">Sign In</button>' + script
                else:
                    html += '<button onclick="location.href=\'/password\'">Next</button>'
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(html.encode())

    script = '<script>function finish(){if(document.querySelector("#secret").value==="synthetic-valid"){location.href="/signed-in"}else{document.body.innerHTML="Invalid credentials"}}</script>'
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    def fill(url, selector, variable):
        return {"kind": "fill", "url": url, "locator": {"strategy": "css", "selector": selector}, "variable": variable}
    def click(url, name):
        return {"kind": "click", "url": url, "locator": {"strategy": "role", "role": "button", "name": name}}
    commands = [{"kind": "goto", "url": base + "/login"}, fill(base + "/login", "#identity", "TESTDATA_USERNAME")]
    password_url = base + ("/password" if application == "portal" else "/login")
    if application == "portal":
        commands.append(click(base + "/login", "Next"))
    commands += [fill(base + "/wrong" if wrong_screen else password_url, "#secret", "TESTDATA_PASSWORD"), click(password_url, "Continue" if application == "portal" else "Sign In")]
    auth = {"login_url": base + "/login", "commands": commands,
            "success": {"url": base + "/signed-in", "locator": {"strategy": "css", "selector": "#identity"}}}
    (tmp_path / "discovery.spec.js").write_text(build_discovery_spec(base + "/login", max_pages=1, auth=auth), encoding="utf-8")
    (tmp_path / "playwright.config.js").write_text("module.exports={testDir:'.',timeout:60000,use:{headless:true},workers:1};", encoding="utf-8")
    root = Path(__file__).resolve().parents[3]
    runtime = Path(os.environ.get("AUTOMATION_PLAYWRIGHT_PROJECT", str(root)))
    env = {**os.environ, "NODE_PATH": str(runtime / "node_modules"), "TESTDATA_USERNAME": "synthetic-user",
           "TESTDATA_PASSWORD": "invalid" if invalid else "synthetic-valid"}
    try:
        result = subprocess.run(["node", str(runtime / "node_modules/@playwright/test/cli.js"), "test", "--config=playwright.config.js"], cwd=tmp_path, env=env, text=True, capture_output=True, timeout=90)
        evidence = json.loads((tmp_path / "discovery.json").read_text())
        assert evidence["auth"]["verified"] is (not invalid and not wrong_screen), result.stdout + result.stderr
        if invalid:
            assert "rejected" in evidence["auth"]["detail"]
        elif wrong_screen:
            assert "different screen" in evidence["auth"]["detail"]
        else:
            assert result.returncode == 0, result.stdout + result.stderr
            assert evidence["elements"]
            selected = next(item for item in evidence["elements"] if item["role"] == "combobox")
            assert selected["accessible_name"] == "Delivery method"
            assert "PRIVATE-OPTION" not in selected["accessible_name"]
    finally:
        server.shutdown()
        server.server_close()


def test_public_scan_prefers_real_login_over_authorised_pdf(tmp_path):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            if self.path.startswith('/ecare/d/auth'):
                body = '<h1>Sign in</h1><label>Username<input name="username"></label><label>Password<input name="password" type="password"></label>'
            elif self.path.endswith('.pdf'):
                self.send_response(500)
                self.end_headers()
                return
            else:
                body = '<a href="/docs/authorised-channel-partners.pdf">Authorised Channel Partners</a><a href="/ecare/d/auth?locale=en">sign in</a>'
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            self.wfile.write(body.encode())

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}'
    (tmp_path / 'discovery.spec.js').write_text(build_discovery_spec(base + '/', max_pages=2), encoding='utf-8')
    (tmp_path / 'playwright.config.js').write_text("module.exports={testDir:'.',timeout:90000,use:{headless:true},workers:1};", encoding='utf-8')
    root = Path(__file__).resolve().parents[3]
    runtime = Path(os.environ.get('AUTOMATION_PLAYWRIGHT_PROJECT', str(root)))
    try:
        result = subprocess.run(['node', str(runtime / 'node_modules/@playwright/test/cli.js'), 'test', '--config=playwright.config.js'],
                                cwd=tmp_path, env={**os.environ, 'NODE_PATH': str(runtime / 'node_modules')},
                                text=True, capture_output=True, timeout=90)
        assert result.returncode == 0, result.stdout + result.stderr
        evidence = json.loads((tmp_path / 'discovery.json').read_text())
        assert any('/ecare/d/auth' in page['url'] for page in evidence['pages'])
        assert any(element['accessible_name'] == 'Username' for element in evidence['elements'])
        assert not any('authorised-channel-partners.pdf' in str(blocker) for blocker in evidence['blockers'])
    finally:
        server.shutdown()
        server.server_close()


@pytest.mark.parametrize("target", ["smartphones", "appointments"])
def test_case_focused_public_crawl_uses_observed_same_host_link(tmp_path, target):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            if self.path == "/":
                body = (f'<a href="/irrelevant">Unrelated</a>'
                        f'<a href="http://other.example.test/{target}">{target} external</a>'
                        f'<a href="/{target}">{target.title()}</a>')
            else:
                body = f'<button>{self.path.strip("/").title()} action</button>'
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(body.encode())

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    (tmp_path / "discovery.spec.js").write_text(
        build_discovery_spec(base + "/", max_pages=2, focus_terms=[target]), encoding="utf-8")
    (tmp_path / "playwright.config.js").write_text(
        "module.exports={testDir:'.',timeout:90000,use:{headless:true},workers:1};", encoding="utf-8")
    root = Path(__file__).resolve().parents[3]
    runtime = Path(os.environ.get("AUTOMATION_PLAYWRIGHT_PROJECT", str(root)))
    try:
        result = subprocess.run(
            ["node", str(runtime / "node_modules/@playwright/test/cli.js"), "test", "--config=playwright.config.js"],
            cwd=tmp_path, env={**os.environ, "NODE_PATH": str(runtime / "node_modules")},
            text=True, capture_output=True, timeout=90)
        assert result.returncode == 0, result.stdout + result.stderr
        evidence = json.loads((tmp_path / "discovery.json").read_text())
        assert any(page["url"] == base + "/" + target for page in evidence["pages"])
        assert not any("other.example.test" in page["url"] for page in evidence["pages"])
    finally:
        server.shutdown()
        server.server_close()


@pytest.mark.parametrize("application,ambiguous", [("storefront", False), ("travel", False), ("storefront", True)])
def test_case_focused_tab_reveals_only_unique_same_host_links(tmp_path, application, ambiguous):
    product = "Handset" if application == "storefront" else "Flight"
    focus = "smartphones" if application == "storefront" else "flights"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            if self.path == "/":
                duplicate = f'<a href="/otheritem">{product}</a>' if ambiguous else ""
                body = (f'<button role="tab" aria-selected="false" onclick="document.querySelector(\'#results\').hidden=false">{focus.title()}</button>'
                        f'<section id="results" hidden><a href="/item">{product}</a>{duplicate}'
                        f'<a href="http://other.example.test/item">External {product}</a></section>')
            else:
                body = f'<h1>{product} details</h1>'
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(body.encode())

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    (tmp_path / "discovery.spec.js").write_text(
        build_discovery_spec(base + "/", max_pages=2, focus_terms=[focus]), encoding="utf-8")
    (tmp_path / "playwright.config.js").write_text(
        "module.exports={testDir:'.',timeout:90000,use:{headless:true},workers:1};", encoding="utf-8")
    root = Path(__file__).resolve().parents[3]
    runtime = Path(os.environ.get("AUTOMATION_PLAYWRIGHT_PROJECT", str(root)))
    try:
        result = subprocess.run(
            ["node", str(runtime / "node_modules/@playwright/test/cli.js"), "test", "--config=playwright.config.js"],
            cwd=tmp_path, env={**os.environ, "NODE_PATH": str(runtime / "node_modules")},
            text=True, capture_output=True, timeout=90)
        assert result.returncode == 0, result.stdout + result.stderr
        evidence = json.loads((tmp_path / "discovery.json").read_text())
        product_links = [item for item in evidence["elements"] if item["accessible_name"] == product]
        assert len(product_links) == (0 if ambiguous else 1)
        if product_links:
            assert product_links[0]["revealed_by"].lower() == focus
            assert product_links[0]["page_url"] == base + "/"
        assert not any("other.example.test" in item["page_url"] for item in evidence["elements"])
    finally:
        server.shutdown()
        server.server_close()


@pytest.mark.skipif(os.environ.get('RUN_EAND_LIVE_DISCOVERY') != '1', reason='opt-in external site diagnostic')
def test_live_eand_public_login_diagnostic(tmp_path):
    address = 'https://www.eand.ae/en'
    (tmp_path / 'discovery.spec.js').write_text(
        build_discovery_spec(address, max_pages=5, focus_terms=['devices', 'smartphones']), encoding='utf-8')
    (tmp_path / 'playwright.config.js').write_text("module.exports={testDir:'.',timeout:210000,use:{headless:true},workers:1};", encoding='utf-8')
    root = Path(__file__).resolve().parents[3]
    runtime = Path(os.environ.get('AUTOMATION_PLAYWRIGHT_PROJECT', str(root)))
    result = subprocess.run(['node', str(runtime / 'node_modules/@playwright/test/cli.js'), 'test', '--config=playwright.config.js'],
                            cwd=tmp_path, env={**os.environ, 'NODE_PATH': str(runtime / 'node_modules')},
                            text=True, capture_output=True, timeout=220)
    assert (tmp_path / 'discovery.json').exists(), result.stdout + result.stderr
    evidence = json.loads((tmp_path / 'discovery.json').read_text())
    pages = [{'url': page['url'], 'status': page['status'], 'title': page['title']} for page in evidence['pages']]
    blockers = evidence['blockers']
    print(json.dumps({'pages': pages, 'blockers': blockers}, ensure_ascii=False))
    assert not any('authorised-channel-partners.pdf' in str(blocker) for blocker in blockers)


@pytest.mark.skipif(os.environ.get('RUN_EAND_LIVE_DISCOVERY') != '1', reason='opt-in external site diagnostic')
def test_live_eand_smartphones_tab_diagnostic(tmp_path):
    address = 'https://www.eand.ae/en/c/devices/devices.html'
    (tmp_path / 'discovery.spec.js').write_text(
        build_discovery_spec(address, max_pages=2, focus_terms=['smartphones']), encoding='utf-8')
    (tmp_path / 'playwright.config.js').write_text(
        "module.exports={testDir:'.',timeout:150000,use:{headless:true},workers:1};", encoding='utf-8')
    root = Path(__file__).resolve().parents[3]
    runtime = Path(os.environ.get('AUTOMATION_PLAYWRIGHT_PROJECT', str(root)))
    result = subprocess.run(
        ['node', str(runtime / 'node_modules/@playwright/test/cli.js'), 'test', '--config=playwright.config.js'],
        cwd=tmp_path, env={**os.environ, 'NODE_PATH': str(runtime / 'node_modules')},
        text=True, capture_output=True, timeout=160)
    assert (tmp_path / 'discovery.json').exists(), result.stdout + result.stderr
    evidence = json.loads((tmp_path / 'discovery.json').read_text())
    revealed = [item for item in evidence['elements'] if item.get('revealed_by')]
    summary = {'pages': [item['url'] for item in evidence['pages']],
               'revealed': [{'name': item['accessible_name'], 'href': item['href'],
                             'revealed_by': item['revealed_by']} for item in revealed[:20]],
               'blockers': evidence['blockers'][:5]}
    print(json.dumps(summary, ensure_ascii=False))
    if any('Request Rejected' in blocker.get('reason', '') for blocker in evidence['blockers']):
        pytest.skip('The live e& site rejected this browser session; no product controls were verified.')
    assert result.returncode == 0, result.stdout + result.stderr
