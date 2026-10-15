"""Publish approved test cases to a PPM-scoped Bitbucket repository.

Supports Bitbucket Cloud and Bitbucket Data Center. Configuration is read for
every operation so an operator can correct credentials or proxy settings and
press Resync without restarting the API. Secrets may be supplied through
environment placeholders in the JSON config and are never returned by status
endpoints or written to logs.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote, urlsplit, urlunsplit

import requests
from sqlalchemy.orm import Session

from ..models.automation import AutomationScript, AutomationTestCase
from ..models.database import BitbucketSync, Project, TestCaseDetail, TestCaseReviewDetail


# The deployed backend lives under /app, so its operational configuration is
# /app/bitbucket_config.json. Keep the package-local path as a compatibility
# fallback for source checkouts that still store it under app/.
CONFIG_PATH = Path(__file__).resolve().parents[2] / "bitbucket_config.json"
PACKAGE_CONFIG_PATH = Path(__file__).resolve().parents[1] / "bitbucket_config.json"
ENV_TOKEN = re.compile(r"\$\{([A-Z][A-Z0-9_]*)\}")


class BitbucketSyncError(RuntimeError):
    pass


def _expand(value: Any) -> Any:
    if isinstance(value, str):
        return ENV_TOKEN.sub(lambda match: os.getenv(match.group(1), ""), value)
    if isinstance(value, dict):
        return {key: _expand(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_expand(item) for item in value]
    return value


def _resolve_config_path() -> Path:
    """Find the Bitbucket config in packaged and deployment-root layouts.

    A source checkout normally stores the file in ``app/bitbucket_config.json``.
    Some server deployments copy the backend into ``/app`` and keep operational
    configuration at ``/app/bitbucket_config.json``.  Support both without
    requiring a container-specific path.  An explicit environment override
    remains authoritative.
    """
    configured = os.getenv("BITBUCKET_CONFIG_PATH", "").strip()
    if configured:
        explicit = Path(configured).expanduser()
        if explicit.is_dir():
            explicit = explicit / "bitbucket_config.json"
        return explicit

    candidates = (
        CONFIG_PATH,
        PACKAGE_CONFIG_PATH,
        Path.cwd() / "bitbucket_config.json",
        Path.cwd() / "app" / "bitbucket_config.json",
    )
    unique: list[Path] = []
    for candidate in candidates:
        if candidate not in unique:
            unique.append(candidate)
        if candidate.is_file():
            return candidate

    searched = ", ".join(str(candidate) for candidate in unique)
    raise BitbucketSyncError(
        f"Bitbucket configuration was not found. Checked: {searched}. "
        "Set BITBUCKET_CONFIG_PATH to override the location."
    )


@dataclass(frozen=True)
class BitbucketConfig:
    enabled: bool
    provider: str
    base_url: str
    web_url: str
    workspace: str
    project_key: str
    fixed_repository_slug: str
    default_branch: str
    repository_prefix: str
    repository_private: bool
    file_directory: str
    verify: bool | str
    timeout: float
    auth_mode: str
    username: str
    password: str
    access_token: str
    proxy_mode: str
    proxy_url: str
    proxy_username: str
    proxy_password: str

    @classmethod
    def load(cls) -> "BitbucketConfig":
        path = _resolve_config_path()
        if not path.is_file():
            raise BitbucketSyncError(f"Bitbucket configuration was not found at {path}.")
        try:
            raw = _expand(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError) as exc:
            raise BitbucketSyncError(f"Bitbucket configuration is invalid: {exc}") from exc

        provider = str(raw.get("provider") or "cloud").strip().lower()
        if provider not in {"cloud", "data_center"}:
            raise BitbucketSyncError("Bitbucket provider must be 'cloud' or 'data_center'.")
        auth = raw.get("auth") if isinstance(raw.get("auth"), dict) else {}
        proxy = raw.get("proxy") if isinstance(raw.get("proxy"), dict) else {}
        # The small config does not need mode switches: credentials imply the
        # authentication kind and a URL implies an explicit proxy.  Keep the
        # old mode keys working so existing server configs do not break.
        auth_mode = str(auth.get("mode") or (
            "bearer" if auth.get("access_token") else
            "basic" if auth.get("username") or auth.get("password") else
            "none"
        )).strip().lower()
        proxy_mode = str(proxy.get("mode") or ("url" if proxy.get("url") else "none")).strip().lower()
        if auth_mode not in {"none", "basic", "bearer"}:
            raise BitbucketSyncError("Bitbucket auth.mode must be none, basic, or bearer.")
        if proxy_mode not in {"none", "environment", "url"}:
            raise BitbucketSyncError("Bitbucket proxy.mode must be none, environment, or url.")
        ca_bundle = str(raw.get("ca_bundle") or "").strip()
        return cls(
            enabled=bool(raw.get("enabled", False)), provider=provider,
            base_url=str(raw.get("base_url") or "").strip().rstrip("/"),
            web_url=str(raw.get("web_url") or raw.get("base_url") or "").strip().rstrip("/"),
            workspace=str(raw.get("workspace") or "").strip(),
            project_key=str(raw.get("project_key") or "").strip(),
            fixed_repository_slug=str(raw.get("repository_slug") or "").strip(),
            default_branch=str(raw.get("default_branch") or ("main" if provider == "cloud" else "master")).strip(),
            repository_prefix=str(raw.get("repository_prefix") or "").strip(),
            repository_private=bool(raw.get("repository_private", True)),
            file_directory=str(raw.get("file_directory") or "test-cases").strip().strip("/"),
            verify=ca_bundle or bool(raw.get("verify_ssl", True)),
            timeout=max(1.0, min(float(raw.get("timeout_seconds") or 30), 300.0)),
            auth_mode=auth_mode, username=str(auth.get("username") or "").strip(),
            password=str(auth.get("password") or ""), access_token=str(auth.get("access_token") or ""),
            proxy_mode=proxy_mode, proxy_url=str(proxy.get("url") or "").strip(),
            proxy_username=str(proxy.get("username") or ""), proxy_password=str(proxy.get("password") or ""),
        )

    def validate_for_sync(self) -> None:
        if not self.enabled:
            raise BitbucketSyncError("Bitbucket sync is disabled in app/bitbucket_config.json.")
        if not self.base_url:
            raise BitbucketSyncError("Bitbucket base_url is required.")
        if self.provider == "cloud" and not self.workspace:
            raise BitbucketSyncError("Bitbucket Cloud workspace is required.")
        if self.provider == "data_center" and not self.project_key:
            raise BitbucketSyncError("Bitbucket Data Center project_key is required.")
        if self.auth_mode == "basic" and (not self.username or not self.password):
            raise BitbucketSyncError("Basic authentication requires username and password.")
        if self.auth_mode == "bearer" and not self.access_token:
            raise BitbucketSyncError("Bearer authentication requires access_token.")
        if self.proxy_mode == "url" and not self.proxy_url:
            raise BitbucketSyncError("proxy.url is required when proxy.mode is url.")

    def public_status(self) -> dict[str, Any]:
        configured = self.enabled and bool(self.base_url)
        configured = configured and bool(self.workspace if self.provider == "cloud" else self.project_key)
        configured = configured and (
            self.auth_mode == "none"
            or (self.auth_mode == "basic" and bool(self.username and self.password))
            or (self.auth_mode == "bearer" and bool(self.access_token))
        )
        configured = configured and (self.proxy_mode != "url" or bool(self.proxy_url))
        return {
            "enabled": self.enabled, "configured": configured, "provider": self.provider,
            "base_url": self.base_url, "workspace": self.workspace or None,
            "project_key": self.project_key or None, "default_branch": self.default_branch,
            "repository_slug": self.fixed_repository_slug or None,
            "auth_mode": self.auth_mode, "proxy_mode": self.proxy_mode,
        }


def _proxy_with_credentials(url: str, username: str, password: str) -> str:
    if not username:
        return url
    parts = urlsplit(url)
    if not parts.scheme or not parts.hostname:
        raise BitbucketSyncError("proxy.url must be an absolute HTTP or HTTPS URL.")
    host = parts.hostname
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    if parts.port:
        host += f":{parts.port}"
    credentials = quote(username, safe="")
    if password:
        credentials += ":" + quote(password, safe="")
    return urlunsplit((parts.scheme, f"{credentials}@{host}", parts.path, parts.query, parts.fragment))


class BitbucketClient:
    def __init__(self, config: BitbucketConfig, session: Optional[requests.Session] = None):
        self.config = config
        self.session = session or requests.Session()
        self.session.headers.update({"Accept": "application/json"})
        self.session.trust_env = config.proxy_mode == "environment"
        if config.auth_mode == "basic":
            self.session.auth = (config.username, config.password)
        elif config.auth_mode == "bearer":
            self.session.headers["Authorization"] = f"Bearer {config.access_token}"
        if config.proxy_mode == "url":
            proxy = _proxy_with_credentials(config.proxy_url, config.proxy_username, config.proxy_password)
            self.session.proxies.update({"http": proxy, "https": proxy})

    def _request(self, method: str, url: str, **kwargs) -> requests.Response:
        try:
            response = self.session.request(
                method, url, timeout=self.config.timeout, verify=self.config.verify, **kwargs
            )
        except requests.RequestException as exc:
            raise BitbucketSyncError(f"Bitbucket request failed: {exc}") from exc
        return response

    @staticmethod
    def _error(response: requests.Response, action: str) -> BitbucketSyncError:
        detail = ""
        try:
            body = response.json()
            detail = str(body.get("error", {}).get("message") or body.get("message") or "")
        except (ValueError, AttributeError):
            detail = (response.text or "").strip()
        detail = re.sub(r"\s+", " ", detail)[:500]
        if detail.lower() in {"null", "none", "{}", "[]"}:
            detail = ""
        return BitbucketSyncError(f"Bitbucket could not {action} (HTTP {response.status_code})" + (f": {detail}" if detail else "."))

    def ensure_repository(self, slug: str, name: str, description: str) -> tuple[bool, str]:
        if self.config.provider == "cloud":
            return self._ensure_cloud_repository(slug, name, description)
        return self._ensure_dc_repository(slug, name, description)

    def _ensure_cloud_repository(self, slug: str, name: str, description: str) -> tuple[bool, str]:
        url = f"{self.config.base_url}/repositories/{quote(self.config.workspace, safe='')}/{quote(slug, safe='')}"
        response = self._request("GET", url)
        created = False
        if response.status_code == 404:
            response = self._request("POST", url, json={
                "scm": "git", "name": name, "description": description,
                "is_private": self.config.repository_private,
            })
            created = True
        if response.status_code not in {200, 201}:
            raise self._error(response, "find or create the repository")
        body = response.json()
        html = ((body.get("links") or {}).get("html") or {}).get("href")
        return created, str(html or f"{self.config.web_url}/{self.config.workspace}/{slug}")

    def _ensure_dc_repository(self, slug: str, name: str, description: str) -> tuple[bool, str]:
        key = quote(self.config.project_key, safe="")
        repo = quote(slug, safe="")
        url = f"{self.config.base_url}/rest/api/latest/projects/{key}/repos/{repo}"
        response = self._request("GET", url)
        created = False
        if response.status_code == 404:
            response = self._request("POST", f"{self.config.base_url}/rest/api/latest/projects/{key}/repos", json={
                "name": name, "slug": slug, "scmId": "git", "description": description,
            })
            created = True
        if response.status_code not in {200, 201}:
            raise self._error(response, "find or create the repository")
        body = response.json()
        links = body.get("links") or {}
        clone = links.get("clone") or []
        href = next((item.get("href") for item in clone if item.get("name") == "http"), None)
        return created, str(href or f"{self.config.web_url}/projects/{self.config.project_key}/repos/{slug}/browse")

    def commit_file(self, slug: str, path: str, content: bytes, message: str) -> str:
        if self.config.provider == "cloud":
            return self._commit_cloud(slug, path, content, message)
        return self._commit_dc(slug, path, content, message)

    def _commit_cloud(self, slug: str, path: str, content: bytes, message: str) -> str:
        url = f"{self.config.base_url}/repositories/{quote(self.config.workspace, safe='')}/{quote(slug, safe='')}/src"
        response = self._request(
            "POST", url, data={"message": message, "branch": self.config.default_branch},
            files={path: (Path(path).name, content, "application/json")},
        )
        if response.status_code not in {200, 201}:
            raise self._error(response, "commit the test cases")
        try:
            return str(response.json().get("hash") or response.headers.get("Location") or "")
        except ValueError:
            return str(response.headers.get("Location") or "")

    def _commit_dc(self, slug: str, path: str, content: bytes, message: str) -> str:
        key = quote(self.config.project_key, safe="")
        repo = quote(slug, safe="")
        commits_url = f"{self.config.base_url}/rest/api/latest/projects/{key}/repos/{repo}/commits"
        commits = self._request("GET", commits_url, params={"limit": 1})
        if commits.status_code != 200:
            raise self._error(commits, "read the repository head")
        values = (commits.json() or {}).get("values") or []
        head = str(values[0].get("id") or "") if values else ""
        data = {"message": message, "branch": self.config.default_branch}
        if head:
            data["sourceCommitId"] = head
        url = f"{self.config.base_url}/rest/api/latest/projects/{key}/repos/{repo}/browse/{quote(path, safe='/')}"
        response = self._request("PUT", url, data=data, files={"content": (Path(path).name, content, "application/json")})
        if response.status_code not in {200, 201}:
            raise self._error(response, "commit the test cases")
        body = response.json() if response.content else {}
        return str(body.get("latestCommit") or body.get("id") or "")


def repository_slug(ppm_id: str, prefix: str = "") -> str:
    raw = f"{prefix}{ppm_id}".strip().lower()
    slug = re.sub(r"[^a-z0-9._-]+", "-", raw).strip("-._")
    if not slug:
        raise BitbucketSyncError("The PPM ID cannot be converted to a repository name.")
    return slug[:255]


def project_repository_slug(config: BitbucketConfig, project: Project) -> str:
    """Resolve one stable repository for a local PPM project.

    ``repository_slug`` is a template. ``{ppm_id}``, ``{project_name}``, and
    ``{project_id}`` are supported; a literal value deliberately keeps the
    legacy single-repository deployment behaviour.
    """
    template = config.fixed_repository_slug
    if not template:
        return repository_slug(project.ppm_id, config.repository_prefix)
    try:
        value = template.format(
            ppm_id=project.ppm_id,
            project_name=project.name,
            project_id=project.id,
        )
    except (KeyError, ValueError) as exc:
        raise BitbucketSyncError(
            "repository_slug may use only {ppm_id}, {project_name}, or {project_id}."
        ) from exc
    return repository_slug(value, config.repository_prefix)


def request_file_path(request_id: str, directory: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", request_id).strip("-.")
    if not safe:
        raise BitbucketSyncError("The request ID cannot be converted to a file name.")
    return f"{directory}/{safe}.json" if directory else f"{safe}.json"


def _safe_path_part(value: Any, fallback: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value or "")).strip("-.")
    return safe or fallback


def automation_script_files(
    case: AutomationTestCase,
    script: AutomationScript,
    directory: str,
) -> dict[str, bytes]:
    """Map a generated script to collision-free repository paths."""
    root = "/".join(part for part in (
        directory.strip("/"),
        _safe_path_part(script.framework, "script"),
        _safe_path_part(case.display_id, f"case-{case.id}"),
    ) if part)
    source = script.files if isinstance(script.files, dict) and script.files else {
        script.entry_path or script.file_name or f"script-{script.id}.txt": script.code or ""
    }
    files: dict[str, bytes] = {}
    for original, content in source.items():
        # Preserve useful compiler subfolders but never allow an asset to walk
        # outside this test case's directory.
        clean_parts = [
            _safe_path_part(part, "file")
            for part in str(original or "").replace("\\", "/").split("/")
            if part not in {"", ".", ".."}
        ]
        relative = "/".join(clean_parts) or _safe_path_part(script.file_name, f"script-{script.id}.txt")
        path = f"{root}/{relative}" if root else relative
        files[path] = str(content or "").encode("utf-8")
    return files


def export_payload(project: Project, detail: TestCaseReviewDetail, cases: list[TestCaseDetail]) -> bytes:
    records = []
    for case in sorted(cases, key=lambda item: item.test_case_id):
        details = case.test_case_details if isinstance(case.test_case_details, dict) else {}
        public_fields = {key: value for key, value in details.items() if not str(key).startswith("_")}
        ai = details.get("_ai") if isinstance(details.get("_ai"), dict) else {}
        records.append({
            "test_case_id": case.test_case_id, "document_id": case.document_id,
            "status": case.status, "reviewed_by": case.reviewed_by,
            "reviewed_at": case.reviewed_datetime.isoformat() if case.reviewed_datetime else None,
            "fields": public_fields,
            "ai_review": {
                key: ai.get(key) for key in (
                    "classification", "score_before", "score_after", "review_verdict",
                    "test_type", "test_data_pending", "test_data_notes",
                ) if key in ai
            },
        })
    payload = {
        "schema_version": 1,
        "project": {"ppm_id": project.ppm_id, "name": project.name},
        "request": {
            "request_id": detail.request_id, "source": detail.source,
            "requested_by": detail.request_by,
            "requested_at": detail.request_date_time.isoformat() if detail.request_date_time else None,
            "reviewed_by": detail.reviewed_by,
            "reviewed_at": detail.reviewed_date_time.isoformat() if detail.reviewed_date_time else None,
        },
        "approved_test_cases": records,
    }
    return (json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def serialize_sync(record: Optional[BitbucketSync]) -> Optional[dict[str, Any]]:
    if not record:
        return None
    return {
        "status": record.status, "provider": record.provider,
        "repository_slug": record.repository_slug, "repository_url": record.repository_url,
        "branch": record.branch, "file_path": record.file_path,
        "repository_created": bool(record.repository_created), "commit_hash": record.commit_hash,
        "content_hash": record.content_hash, "approved_cases": record.approved_cases,
        "attempt_count": record.attempt_count, "last_error": record.last_error,
        "synced_by": record.synced_by,
        "synced_at": record.synced_at.isoformat() if record.synced_at else None,
    }


def configuration_status() -> dict[str, Any]:
    try:
        return BitbucketConfig.load().public_status()
    except BitbucketSyncError as exc:
        return {"enabled": False, "configured": False, "error": str(exc)}


def sync_automation_scripts(
    db: Session,
    case_ids: list[int],
    framework: str,
    actor: str,
) -> dict[str, Any]:
    """Publish selected current scripts, isolated one PPM project at a time.

    A repository failure marks only that project's scripts as failed. Other
    projects continue, which makes a mixed selection safe and retryable.
    """
    config = BitbucketConfig.load()
    config.validate_for_sync()
    requested = list(dict.fromkeys(case_ids))
    cases = db.query(AutomationTestCase).filter(AutomationTestCase.id.in_(requested)).all()
    by_id = {case.id: case for case in cases}
    scripts = db.query(AutomationScript).filter(
        AutomationScript.test_case_id.in_(requested),
        AutomationScript.framework == framework,
        AutomationScript.is_current.is_(True),
    ).all()
    script_by_case = {script.test_case_id: script for script in scripts}
    projects = {
        project.id: project
        for project in db.query(Project).filter(
            Project.id.in_({case.project_id for case in cases if case.project_id})
        ).all()
    }

    results: list[dict[str, Any]] = []
    grouped: dict[int, list[tuple[AutomationTestCase, AutomationScript]]] = {}
    for case_id in requested:
        case = by_id.get(case_id)
        if not case:
            results.append({"case_id": case_id, "status": "failed", "error": "Test case not found."})
            continue
        script = script_by_case.get(case_id)
        base = {"case_id": case.id, "display_id": case.display_id, "project_id": case.project_id}
        if not script:
            results.append({**base, "status": "failed", "error": f"No current {framework} script exists."})
            continue
        if not case.project_id or case.project_id not in projects:
            results.append({**base, "script_id": script.id, "status": "failed", "error": "The test case has no PPM project."})
            continue
        grouped.setdefault(case.project_id, []).append((case, script))

    client = BitbucketClient(config)
    project_results: list[dict[str, Any]] = []
    for project_id, items in grouped.items():
        project = projects[project_id]
        slug = project_repository_slug(config, project)
        project_result: dict[str, Any] = {
            "project_id": project.id,
            "ppm_id": project.ppm_id,
            "project_name": project.name,
            "repository_slug": slug,
            "repository_url": None,
            "repository_created": False,
            "status": "synced",
            "synced": 0,
            "failed": 0,
        }
        try:
            created, repository_url = client.ensure_repository(
                slug,
                f"{project.ppm_id} - {project.name}",
                f"Automation scripts for {project.ppm_id} - {project.name}",
            )
            project_result["repository_created"] = created
            project_result["repository_url"] = repository_url
        except Exception as exc:
            message = str(exc)[:2000]
            project_result.update(status="failed", failed=len(items), error=message)
            for case, script in items:
                results.append({
                    "case_id": case.id, "display_id": case.display_id,
                    "project_id": project.id, "script_id": script.id,
                    "status": "failed", "repository_slug": slug, "error": message,
                })
            project_results.append(project_result)
            continue

        for case, script in items:
            committed: list[dict[str, str]] = []
            try:
                for path, content in automation_script_files(case, script, config.file_directory).items():
                    commit = client.commit_file(
                        slug, path, content,
                        f"Sync {case.display_id} {script.framework} script by {actor}",
                    )
                    committed.append({"path": path, "commit": commit})
                project_result["synced"] += 1
                results.append({
                    "case_id": case.id, "display_id": case.display_id,
                    "project_id": project.id, "script_id": script.id,
                    "status": "synced", "repository_slug": slug,
                    "repository_url": project_result["repository_url"], "files": committed,
                })
            except Exception as exc:
                project_result["failed"] += 1
                results.append({
                    "case_id": case.id, "display_id": case.display_id,
                    "project_id": project.id, "script_id": script.id,
                    "status": "failed", "repository_slug": slug,
                    "repository_url": project_result["repository_url"], "files": committed,
                    "error": str(exc)[:2000],
                })
        if project_result["failed"]:
            project_result["status"] = "partial" if project_result["synced"] else "failed"
        project_results.append(project_result)

    synced = sum(1 for item in results if item["status"] == "synced")
    failed = len(results) - synced
    return {
        "status": "synced" if not failed else "partial" if synced else "failed",
        "requested": len(requested), "synced": synced, "failed": failed,
        "framework": framework, "projects": project_results, "results": results,
    }


def sync_review_request(db: Session, request_id: str, actor: str) -> BitbucketSync:
    config = BitbucketConfig.load()
    config.validate_for_sync()
    detail = db.get(TestCaseReviewDetail, request_id)
    if not detail:
        raise BitbucketSyncError("Review request not found.")
    if not detail.project_id:
        raise BitbucketSyncError("This review request has no PPM project.")
    project = db.get(Project, detail.project_id)
    if not project:
        raise BitbucketSyncError("The PPM project for this request no longer exists.")
    cases = db.query(TestCaseDetail).filter(
        TestCaseDetail.request_id == request_id,
        TestCaseDetail.status == "APPROVED",
    ).all()
    if not cases:
        raise BitbucketSyncError("Approve at least one test case before syncing to Bitbucket.")

    # A deployment can publish every PPM into one governed repository. When
    # omitted, preserve the original one-repository-per-PPM behaviour.
    slug = project_repository_slug(config, project)
    file_path = request_file_path(request_id, config.file_directory)
    content = export_payload(project, detail, cases)
    content_hash = hashlib.sha256(content).hexdigest()
    record = db.query(BitbucketSync).filter(BitbucketSync.request_id == request_id).first()
    if not record:
        record = BitbucketSync(request_id=request_id, project_id=project.id, ppm_id=project.ppm_id)
        db.add(record)
    if record.status == "syncing" and record.updated_at and record.updated_at > datetime.utcnow() - timedelta(minutes=10):
        raise BitbucketSyncError("This request is already being synced.")
    record.provider = config.provider
    record.repository_slug = slug
    record.branch = config.default_branch
    record.file_path = file_path
    record.status = "syncing"
    record.approved_cases = len(cases)
    record.attempt_count = int(record.attempt_count or 0) + 1
    record.last_error = None
    record.updated_at = datetime.utcnow()
    db.commit()

    try:
        client = BitbucketClient(config)
        created, repository_url = client.ensure_repository(
            slug, project.ppm_id, f"Approved test cases for {project.ppm_id} - {project.name}",
        )
        commit = client.commit_file(
            slug, file_path, content,
            f"Sync {len(cases)} approved test case(s) for {request_id}",
        )
        record.repository_url = repository_url
        record.repository_created = created or bool(record.repository_created)
        record.commit_hash = commit or None
        record.content_hash = content_hash
        record.status = "synced"
        record.last_error = None
        record.synced_by = actor
        record.synced_at = datetime.utcnow()
        record.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(record)
        return record
    except Exception as exc:
        db.rollback()
        record = db.query(BitbucketSync).filter(BitbucketSync.request_id == request_id).first()
        if record:
            record.status = "failed"
            record.last_error = str(exc)[:2000]
            record.updated_at = datetime.utcnow()
            db.commit()
        if isinstance(exc, BitbucketSyncError):
            raise
        raise BitbucketSyncError(f"Bitbucket sync failed: {exc}") from exc
