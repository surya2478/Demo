"""
--- Test data vault ------------------------------------------------------------

The values generated scripts read from `process.env.TESTDATA_*` -- usernames,
passwords, OTPs, record names -- kept per application and environment in
Automation Studio's Test data screen, and handed to each run.

Three things this has to get right:

  * Names. The generator names a variable after the test case's own wording,
    so one application's scripts ask for TESTDATA_ADMIN_USERNAME,
    TESTDATA_USERNAME and TESTDATA_LOGIN_EMAIL for what is the same login.
    `resolve` matches each name to a stored value by meaning -- field
    (username, password, OTP), then role (admin, customer) -- so values are
    entered once per application, and scripts already generated work without
    being regenerated.

  * Secrets. Stored encrypted (Fernet: AES plus an HMAC) with a key that is not
    in the database, never returned by the API, and blanked out of the runner
    log and results before they are saved.

  * The runner's environment filter. Values are passed as the runner's own
    overrides, so env_policy's allowlist stays exactly as strict as it is: a
    script still sees nothing of the backend's environment.
"""
from __future__ import annotations

import base64
import hashlib
import logging
import re
from typing import Any, Iterable, Optional

from sqlalchemy.orm import Session

from ...config import settings
from ...models.automation import AutomationDataApp, AutomationTestData

logger = logging.getLogger(__name__)

ALL_ENVIRONMENTS = "*"
DEFAULT_ENVIRONMENTS = ("SIT", "UAT")
PREFIX = "TESTDATA_"

# --- Encryption ---------------------------------------------------------------

_ENC = "enc:v1:"


def _fernet():
    from cryptography.fernet import Fernet

    configured = (getattr(settings, "AUTOMATION_SECRETS_KEY", "") or "").strip()
    if configured:
        return Fernet(configured.encode())
    secret = (getattr(settings, "SECRET_KEY", "") or "").strip()
    if not secret:
        raise RuntimeError(
            "No key to encrypt test data with: set AUTOMATION_SECRETS_KEY (or SECRET_KEY) in the backend .env."
        )
    derived = base64.urlsafe_b64encode(hashlib.sha256(("test-data:" + secret).encode()).digest())
    return Fernet(derived)


def encrypt(value: str) -> str:
    return _ENC + _fernet().encrypt(value.encode("utf-8")).decode("ascii")


def decrypt(stored: Optional[str]) -> Optional[str]:
    if stored is None:
        return None
    if not stored.startswith(_ENC):
        return stored
    from cryptography.fernet import InvalidToken

    try:
        return _fernet().decrypt(stored[len(_ENC):].encode("ascii")).decode("utf-8")
    except InvalidToken:
        logger.error("A stored test data value could not be decrypted -- has the key changed?")
        return None


def value_of(entry: AutomationTestData) -> Optional[str]:
    return decrypt(entry.value) if entry.is_secret else entry.value


# --- Which names a script reads ---------------------------------------------------

_ENV_NAME = re.compile(r"process\.env\.(TESTDATA_[A-Z0-9_]+)")


def required_names(code: str) -> list[str]:
    """Every TESTDATA_* variable the script reads, in first-use order."""
    seen: list[str] = []
    for name in _ENV_NAME.findall(code or ""):
        if name not in seen:
            seen.append(name)
    return seen


# --- Matching a name to a stored value ----------------------------------------------

# Checked in this order, so LOGIN_PASSWORD is a password, not a login.
_FIELDS: tuple[tuple[str, frozenset[str]], ...] = (
    ("password", frozenset({"password", "pwd", "pass", "passcode", "passwd", "passphrase"})),
    ("otp", frozenset({"otp", "onetime", "verification", "code", "pin", "mfa", "totp"})),
    ("username", frozenset({"username", "user", "userid", "uid", "login", "loginid", "email", "mail", "emailid"})),
)
_ALL_FIELD_WORDS = frozenset().union(*(words for _, words in _FIELDS))
_STOP = frozenset({"valid", "registered", "test", "existing", "the", "a", "an", "of", "for", "and", "name", "address", "id", "value", "data"})


def _tokens(text: str) -> list[str]:
    text = re.sub(r"^TESTDATA_", "", str(text or ""), flags=re.I)
    # "userName" -> "user name"; then split on anything that is not a letter or digit.
    text = re.sub(r"([a-z])([A-Z])", r"\1 \2", text)
    return [t for t in re.split(r"[^A-Za-z0-9]+", text.lower()) if t]


def _field(tokens: list[str]) -> Optional[str]:
    words = set(tokens)
    for field, synonyms in _FIELDS:
        if words & synonyms:
            return field
    # Glued spellings: ADMINPASSWORD, LOGINUSERNAME.
    joined = "".join(tokens)
    for glued, field in (("password", "password"), ("username", "username"), ("userid", "username"), ("otp", "otp")):
        if glued in joined:
            return field
    return None


def _role(tokens: list[str]) -> frozenset[str]:
    return frozenset(t for t in tokens if t not in _ALL_FIELD_WORDS and t not in _STOP and not t.isdigit())


def _names_of(entry: AutomationTestData) -> list[list[str]]:
    names = [_tokens(entry.key)]
    for alias in (entry.aliases or "").split(","):
        if alias.strip():
            names.append(_tokens(alias))
    return names


def _score(needed: list[str], entry: AutomationTestData) -> float:
    """How well a stored entry answers a variable; 0 is no match."""
    best = 0.0
    for tokens in _names_of(entry):
        if tokens == needed:
            return 10.0  # the same name, or a declared alias
        if set(tokens) == set(needed):
            best = max(best, 8.0)
        field_needed, field_entry = _field(needed), _field(tokens)
        if field_needed and field_needed == field_entry:
            role_needed, role_entry = _role(needed), _role(tokens)
            if role_needed == role_entry:
                best = max(best, 6.0)
            elif not role_entry:
                best = max(best, 4.0)  # the application's default login
            elif not role_needed:
                best = max(best, 2.0)  # a role-specific value for an unspecific name
    return best


def resolve(entries: Iterable[AutomationTestData], environment: str, names: Iterable[str]) -> dict[str, Any]:
    """Match each variable to the best entry for this environment.

    Returns {"values": {name: value}, "matches": {name: entry key},
    "missing": [names], "secrets": [values]}. An entry for the environment
    itself beats one for all environments; among equals, the higher score wins.
    """
    env = (environment or "").upper()
    usable = [e for e in entries if e.environment in (env, ALL_ENVIRONMENTS)]
    values: dict[str, str] = {}
    matches: dict[str, str] = {}
    secrets: list[str] = []
    missing: list[str] = []
    for name in names:
        needed = _tokens(name)
        scored = [
            (_score(needed, entry) + (0.5 if entry.environment == env else 0.0), entry)
            for entry in usable
        ]
        scored = [(score, entry) for score, entry in scored if score >= 2.0]
        if not scored:
            missing.append(name)
            continue
        entry = max(scored, key=lambda pair: pair[0])[1]
        value = value_of(entry)
        if value is None or value == "":
            missing.append(name)
            continue
        values[name] = value
        matches[name] = entry.key + ("" if entry.environment == env else " (all environments)")
        if entry.is_secret:
            secrets.append(value)
    return {"values": values, "matches": matches, "missing": missing, "secrets": secrets}


# --- Which application a run belongs to ----------------------------------------------

_BASE_URL = re.compile(r"""const\s+BASE_URL\s*=\s*process\.env\.BASE_URL\s*\?\?\s*["']([^"']+)["']""")


def spec_base_url(code: str) -> Optional[str]:
    match = _BASE_URL.search(code or "")
    return match.group(1) if match else None


_ABSOLUTE = re.compile(r"""["'`](https?://[^"'`\s]+)["'`]""")
_ROUTE = re.compile(r"""(?:navigateTo\(\s*page\s*,|page\.goto\()\s*["'`](/[^"'`\s]*)["'`]""")


def spec_urls(code: str) -> list[str]:
    """Where the script goes: its absolute URLs, and its routes on BASE_URL.

    BASE_URL is often only the host, while applications share a host and are
    told apart by path (/b2bportal/, /en/smb/), so the pages it visits say
    more about which application it is.
    """
    urls = [url.rstrip(".,)") for url in _ABSOLUTE.findall(code or "")]
    base = (spec_base_url(code) or "").rstrip("/")
    if base:
        urls += [base + route for route in _ROUTE.findall(code or "")]
    return urls


def url_prefix(url: Optional[str]) -> Optional[str]:
    """scheme://host/folders -- the part that names an application.

    Applications share a host and differ by folder (/en, /en/smb, /b2bportal),
    so the whole folder path is kept; a page (login.html) and the query are not.
    """
    match = re.match(r"(https?://[^/?#]+)([^?#]*)", (url or "").strip())
    if not match:
        return None
    folders = [part for part in match.group(2).split("/") if part]
    if folders and "." in folders[-1]:
        folders = folders[:-1]
    return (match.group(1) + "".join("/" + part for part in folders)).rstrip("/")


def find_app(db: Session, *, urls: Iterable[Optional[str]] = (), kb_app_id: Optional[str] = None) -> Optional[AutomationDataApp]:
    """The application a URL (longest prefix) or Knowledge Base id belongs to."""
    apps = db.query(AutomationDataApp).all()
    best: tuple[int, Optional[AutomationDataApp]] = (0, None)
    for url in urls:
        url = (url or "").strip().lower().rstrip("/")
        if not url:
            continue
        for app in apps:
            prefix = (app.url_prefix or "").strip().lower().rstrip("/")
            if prefix and (url == prefix or url.startswith(prefix + "/") or url.startswith(prefix + "?")) and len(prefix) > best[0]:
                best = (len(prefix), app)
    if best[1] is not None:
        return best[1]
    if not kb_app_id:
        # Ask the Knowledge Base which application the URL is.
        try:
            from . import knowledge_base as kb

            for url in urls:
                if url:
                    kb_app_id = kb.identify_app_id(url)
                    if kb_app_id:
                        break
        except Exception:  # noqa: BLE001 - an unreadable KB means "unknown"
            kb_app_id = None
    if kb_app_id:
        return next((app for app in apps if app.kb_app_id == kb_app_id), None)
    return None


def for_code(
    db: Session,
    code: str,
    *,
    environment: Optional[str],
    case_url: Optional[str] = None,
    base_url: Optional[str] = None,
) -> dict[str, Any]:
    """What a script needs, where it would come from, and what is missing."""
    names = required_names(code)
    environment = (environment or "SIT").upper()
    report: dict[str, Any] = {
        "environment": environment,
        "application": None,
        "needed": names,
        "matches": {},
        "missing": [],
        "values": {},
        "secrets": [],
    }
    if not names:
        return report
    app = find_app(db, urls=(base_url, case_url, *spec_urls(code), spec_base_url(code)))
    if app is None:
        report["missing"] = list(names)
        return report
    resolved = resolve(app.entries, environment, names)
    report.update(resolved)
    report["application"] = {"id": app.id, "name": app.name}
    return report


def public(report: dict[str, Any]) -> dict[str, Any]:
    """The report without values, for the API and run metadata."""
    return {key: value for key, value in report.items() if key not in ("values", "secrets")}


def missing_message(report: dict[str, Any]) -> Optional[str]:
    missing = report.get("missing") or []
    if not missing:
        return None
    readable = ", ".join(" ".join(_tokens(name)) for name in missing)
    where = report["application"]["name"] if report.get("application") else "this application"
    if not report.get("application"):
        return (
            f"No test data is set for this application ({report['environment']}). It needs: {readable}. "
            "Add the application and its values in Automation Studio > Test data."
        )
    return f"Test data missing for {where} ({report['environment']}): {readable}. Add it in Automation Studio > Test data."


# --- Keeping secrets out of what is saved ------------------------------------------------

def redact(text: Any, secrets: Iterable[str]) -> Any:
    if not isinstance(text, str) or not text:
        return text
    for secret in sorted({s for s in secrets if s and len(s) >= 3}, key=len, reverse=True):
        text = text.replace(secret, "••••••")
    return text


def redact_deep(value: Any, secrets: list[str]) -> Any:
    if not secrets:
        return value
    if isinstance(value, str):
        return redact(value, secrets)
    if isinstance(value, list):
        return [redact_deep(item, secrets) for item in value]
    if isinstance(value, dict):
        return {key: redact_deep(item, secrets) for key, item in value.items()}
    return value


# --- Starting points ---------------------------------------------------------------------

def suggested_keys(kb_app_id: Optional[str]) -> list[dict[str, Any]]:
    """The values a new application usually needs, from its Knowledge Base profile.

    A profile may declare `test_data`: {"key": {"secret": bool, "environment":
    "*" | "SIT", "aliases": [...]}}; without one, a login is assumed.
    """
    declared: dict[str, Any] = {}
    if kb_app_id:
        try:
            from . import knowledge_base as kb

            declared = (kb.load_app_profile(kb_app_id) or {}).get("test_data") or {}
        except Exception:  # noqa: BLE001
            declared = {}
    if isinstance(declared, dict) and declared:
        return [
            {
                "key": key,
                "is_secret": bool((spec or {}).get("secret")),
                "environment": (spec or {}).get("environment") or "SIT",
                "aliases": ", ".join((spec or {}).get("aliases") or []),
            }
            for key, spec in declared.items()
        ]
    return [
        {"key": "username", "is_secret": False, "environment": "SIT", "aliases": ""},
        {"key": "password", "is_secret": True, "environment": "SIT", "aliases": ""},
        {"key": "otp", "is_secret": False, "environment": ALL_ENVIRONMENTS, "aliases": ""},
    ]
