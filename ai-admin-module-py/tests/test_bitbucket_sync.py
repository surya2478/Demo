import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database.connection import Base
from app.models.automation import AutomationScript, AutomationTestCase
from app.models.database import Project
from app.services.bitbucket_sync import (
    BitbucketClient,
    BitbucketConfig,
    export_payload,
    automation_script_files,
    project_repository_slug,
    repository_slug,
    request_file_path,
    sync_automation_scripts,
)
from app.services import bitbucket_sync


def config(**overrides):
    values = dict(
        enabled=True, provider="cloud", base_url="https://api.bitbucket.org/2.0",
        web_url="https://bitbucket.org", workspace="quality", project_key="",
        fixed_repository_slug="",
        default_branch="main", repository_prefix="", repository_private=True,
        file_directory="test-cases", verify=True, timeout=30.0,
        auth_mode="basic", username="api-user", password="api-token", access_token="",
        proxy_mode="none", proxy_url="", proxy_username="", proxy_password="",
    )
    values.update(overrides)
    return BitbucketConfig(**values)


class Response:
    def __init__(self, status, body=None, text=""):
        self.status_code = status
        self._body = body or {}
        self.text = text
        self.headers = {}
        self.content = json.dumps(self._body).encode() if self._body else b""

    def json(self):
        return self._body


class Session:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
        self.headers = {}
        self.proxies = {}
        self.auth = None
        self.trust_env = True

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        return self.responses.pop(0)


class BitbucketSyncTests(unittest.TestCase):
    def test_ppm_slug_and_request_path_are_stable_and_safe(self):
        self.assertEqual(repository_slug("PPM 123 / Mobile"), "ppm-123-mobile")
        self.assertEqual(repository_slug("PPM-123", "qa-"), "qa-ppm-123")
        self.assertEqual(request_file_path("REQ/1001", "test-cases"), "test-cases/REQ-1001.json")

    def test_repository_template_routes_each_ppm_to_its_own_repository(self):
        project = SimpleNamespace(id=7, ppm_id="PPM 1001", name="Customer Portal")
        self.assertEqual(
            project_repository_slug(config(fixed_repository_slug="{ppm_id}"), project),
            "ppm-1001",
        )
        self.assertEqual(
            project_repository_slug(config(fixed_repository_slug="qa-{project_name}"), project),
            "qa-customer-portal",
        )

    def test_script_files_are_scoped_to_framework_and_case(self):
        case = SimpleNamespace(id=4, display_id="TC/004")
        script = SimpleNamespace(
            id=8, framework="playwright", files={"specs/login.spec.ts": "test('login', () => {})"},
            entry_path=None, file_name="login.spec.ts", code="",
        )
        files = automation_script_files(case, script, "test-cases")
        self.assertEqual(
            list(files),
            ["test-cases/playwright/TC-004/specs/login.spec.ts"],
        )

    def test_bulk_sync_continues_when_one_project_repository_fails(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        first = Project(ppm_id="PPM-ONE", name="One")
        second = Project(ppm_id="PPM-TWO", name="Two")
        db.add_all([first, second])
        db.flush()
        case_one = AutomationTestCase(source="manual", project_id=first.id, display_id="TC-1")
        case_two = AutomationTestCase(source="manual", project_id=second.id, display_id="TC-2")
        db.add_all([case_one, case_two])
        db.flush()
        db.add_all([
            AutomationScript(test_case_id=case_one.id, framework="playwright", language="typescript", file_name="one.spec.ts", code="one", is_current=True),
            AutomationScript(test_case_id=case_two.id, framework="playwright", language="typescript", file_name="two.spec.ts", code="two", is_current=True),
        ])
        db.commit()

        class Client:
            def __init__(self, _config):
                pass

            def ensure_repository(self, slug, _name, _description):
                if slug == "ppm-one":
                    raise RuntimeError("repository denied")
                return True, f"https://bb/projects/AIT/repos/{slug}/browse"

            def commit_file(self, _slug, _path, _content, _message):
                return "commit-2"

        cfg = config(
            provider="data_center", base_url="https://bb", web_url="https://bb",
            workspace="", project_key="AIT", fixed_repository_slug="{ppm_id}",
        )
        with patch("app.services.bitbucket_sync.BitbucketConfig.load", return_value=cfg), patch(
            "app.services.bitbucket_sync.BitbucketClient", Client
        ):
            result = sync_automation_scripts(db, [case_one.id, case_two.id], "playwright", "qa")
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["synced"], 1)
        self.assertEqual(result["failed"], 1)
        self.assertEqual({item["repository_slug"] for item in result["projects"]}, {"ppm-one", "ppm-two"})
        db.close()

    def test_cloud_creates_missing_repository_then_commits_request_file(self):
        fake = Session([
            Response(404),
            Response(200, {"links": {"html": {"href": "https://bitbucket.org/quality/ppm-1"}}}),
            Response(201, {"hash": "abc123"}),
        ])
        client = BitbucketClient(config(), fake)
        created, url = client.ensure_repository("ppm-1", "PPM-1", "Approved tests")
        commit = client.commit_file("ppm-1", "test-cases/REQ-1.json", b"{}\n", "Sync tests")
        self.assertTrue(created)
        self.assertEqual(url, "https://bitbucket.org/quality/ppm-1")
        self.assertEqual(commit, "abc123")
        self.assertEqual([call[0] for call in fake.calls], ["GET", "POST", "POST"])
        self.assertIn("test-cases/REQ-1.json", fake.calls[2][2]["files"])
        self.assertEqual(fake.auth, ("api-user", "api-token"))
        self.assertFalse(fake.trust_env)

    def test_data_center_reuses_repository_and_updates_from_current_head(self):
        fake = Session([
            Response(200, {"links": {"clone": [{"name": "http", "href": "https://bb/scm/qa/ppm-1.git"}]}}),
            Response(200, {"values": [{"id": "head123"}]}),
            Response(200, {"latestCommit": "next456"}),
        ])
        client = BitbucketClient(config(
            provider="data_center", base_url="https://bb.example", web_url="https://bb.example",
            workspace="", project_key="QA", default_branch="master",
        ), fake)
        created, url = client.ensure_repository("ppm-1", "PPM-1", "Approved tests")
        commit = client.commit_file("ppm-1", "test-cases/REQ-1.json", b"{}\n", "Sync tests")
        self.assertFalse(created)
        self.assertEqual(url, "https://bb/scm/qa/ppm-1.git")
        self.assertEqual(commit, "next456")
        self.assertEqual(fake.calls[2][2]["data"]["sourceCommitId"], "head123")

    def test_proxy_url_supports_authenticated_and_anonymous_modes(self):
        anonymous = Session([])
        BitbucketClient(config(proxy_mode="url", proxy_url="http://proxy.local:8080"), anonymous)
        self.assertEqual(anonymous.proxies["https"], "http://proxy.local:8080")

        authenticated = Session([])
        BitbucketClient(config(
            proxy_mode="url", proxy_url="http://proxy.local:8080",
            proxy_username="proxy user", proxy_password="p@ss",
        ), authenticated)
        self.assertEqual(authenticated.proxies["https"], "http://proxy%20user:p%40ss@proxy.local:8080")

    def test_config_expands_environment_secrets_without_exposing_them_in_status(self):
        raw = {
            "enabled": True, "provider": "cloud", "base_url": "https://api.bitbucket.org/2.0",
            "workspace": "${BITBUCKET_WORKSPACE}", "auth": {
                "mode": "basic", "username": "${BITBUCKET_USERNAME}",
                "password": "${BITBUCKET_PASSWORD}",
            }, "proxy": {"mode": "none"},
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bitbucket.json"
            path.write_text(json.dumps(raw), encoding="utf-8")
            with patch.dict(os.environ, {
                "BITBUCKET_CONFIG_PATH": str(path), "BITBUCKET_WORKSPACE": "quality",
                "BITBUCKET_USERNAME": "user", "BITBUCKET_PASSWORD": "secret-value",
            }, clear=False):
                loaded = BitbucketConfig.load()
        self.assertEqual(loaded.password, "secret-value")
        self.assertTrue(loaded.public_status()["configured"])
        self.assertNotIn("secret-value", json.dumps(loaded.public_status()))

    def test_config_uses_deployment_root_by_default(self):
        raw = {
            "enabled": True,
            "provider": "data_center",
            "base_url": "https://bitbucket.example.com",
            "project_key": "AIT",
            "auth": {},
            "proxy": {},
        }
        with tempfile.TemporaryDirectory() as directory:
            deployment_root = Path(directory)
            package_directory = deployment_root / "app"
            package_directory.mkdir()
            root_config = deployment_root / "bitbucket_config.json"
            root_config.write_text(json.dumps(raw), encoding="utf-8")
            with patch.object(
                bitbucket_sync,
                "CONFIG_PATH",
                root_config,
            ), patch.object(
                bitbucket_sync,
                "PACKAGE_CONFIG_PATH",
                package_directory / "bitbucket_config.json",
            ), patch.dict(os.environ, {"BITBUCKET_CONFIG_PATH": ""}, clear=False):
                loaded = BitbucketConfig.load()

        self.assertEqual(loaded.project_key, "AIT")
        self.assertEqual(loaded.base_url, "https://bitbucket.example.com")

    def test_config_reads_the_application_file_directly(self):
        raw = {
            "enabled": True,
            "provider": "data_center",
            "base_url": "https://bitbucket.example.com",
            "project_key": "AIT",
            "auth": {},
            "proxy": {},
        }
        with tempfile.TemporaryDirectory() as directory:
            package_config = Path(directory) / "app" / "bitbucket_config.json"
            package_config.parent.mkdir()
            package_config.write_text(json.dumps(raw), encoding="utf-8")
            with patch.object(bitbucket_sync, "PACKAGE_CONFIG_PATH", package_config), patch.object(
                bitbucket_sync, "CONFIG_PATH", Path(directory) / "missing.json"
            ), patch.dict(os.environ, {"BITBUCKET_CONFIG_PATH": ""}, clear=False):
                loaded = BitbucketConfig.load()

        self.assertEqual(loaded.project_key, "AIT")

    def test_export_is_deterministic_and_excludes_internal_ai_payload(self):
        project = SimpleNamespace(ppm_id="PPM-1", name="Checkout")
        detail = SimpleNamespace(
            request_id="REQ-1", source="BRD", request_by="qa", request_date_time=None,
            reviewed_by="manager", reviewed_date_time=None,
        )
        case = SimpleNamespace(
            test_case_id="TC-1", document_id="BRD.pdf", status="APPROVED",
            reviewed_by="manager", reviewed_datetime=None,
            test_case_details={
                "Test Case ID": "TC-1", "Test Steps": "1. Log in",
                "_ai": {"classification": "automation", "private_trace": "do-not-export"},
            },
        )
        first = export_payload(project, detail, [case])
        second = export_payload(project, detail, [case])
        self.assertEqual(first, second)
        body = json.loads(first)
        self.assertEqual(body["approved_test_cases"][0]["ai_review"]["classification"], "automation")
        self.assertNotIn("private_trace", first.decode())


if __name__ == "__main__":
    unittest.main()
