"""Evidence gate for journeys that require a signed-in browser session.

Stored credentials are inputs, not proof that login succeeded. Anonymous
discovery must never be used to approve protected-page mappings.
"""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import urljoin, urlparse

from sqlalchemy.orm import Session

from . import test_data, workbench as wb


_SIGNED_IN = re.compile(r"\b(?:signed[ -]?in|logged[ -]?in|authenticated|active\s+session|valid\s+session|existing\s+session)\b", re.I)
_LOGIN_ACTION = re.compile(r"^\s*(?:sign[ -]?in|log[ -]?in|login|authenticate)\b", re.I)
_LOGIN_TITLE = re.compile(r"\b(?:sign[ -]?in|log[ -]?in|login)\b", re.I)


def trusted_auth_origins(kb: Any, environment: str | None) -> set[str]:
    """Credential destinations explicitly approved for this KB and environment."""
    if not kb or not environment:
        return set()
    from ..journeys import store
    configured = store.automation_profile(kb).get("trusted_auth_origins") or {}
    if not isinstance(configured, dict):
        return set()
    result = set()
    for raw in configured.get(environment.upper(), []):
        parsed = urlparse(str(raw))
        if parsed.scheme == "https" and parsed.netloc and not parsed.path.strip("/") and not parsed.query:
            result.add(f"{parsed.scheme}://{parsed.netloc}")
    return result


def requires_signed_in_browser(row: dict[str, Any], actions: list[str]) -> bool:
    """Require proof when the case explicitly starts in or enters an account."""
    preconditions = wb.detail_value(row, "preconditions")
    return bool(_SIGNED_IN.search(preconditions) or any(_LOGIN_ACTION.search(action) for action in actions))


def is_login_shorthand(action: str) -> bool:
    """Only a bare sign-in action is replaced by the approved prerequisite."""
    return bool(re.fullmatch(r"\s*(?:sign[ -]?in|log[ -]?in|login|authenticate)(?:\s+(?:to|into)\s+(?:the\s+)?(?:app|application|account|site))?[.!]?\s*", action, re.I))


def credential_names_present(db: Session, app_key: str, environment: str) -> set[str]:
    """Report names only; never return stored values or assume they work."""
    return {name.removeprefix("TESTDATA_").lower() for name in ("TESTDATA_USERNAME", "TESTDATA_PASSWORD")
            if login_variables_ready(db, app_key, environment, [name])}


def _stored_key(variable: str) -> str:
    parts = variable.removeprefix("TESTDATA_").lower().split("_")
    return ".".join(("_".join(parts[:-1]), parts[-1])) if len(parts) > 1 else parts[0]


def login_variables_ready(db: Session, app_key: str, environment: str,
                          variables: list[str]) -> bool:
    """Require exact stored keys; fuzzy vault lookup could mix identities."""
    if not variables or any(not re.fullmatch(r"TESTDATA_[A-Z0-9_]+", item) for item in variables):
        return False
    app = test_data.find_app(db, kb_app_id=app_key)
    if not app:
        return False
    resolved = test_data.resolve(app.entries, environment, variables)
    return not resolved["missing"] and all(
        str(resolved["matches"].get(variable) or "").split(" (")[0] == _stored_key(variable)
        for variable in variables)


def ready_login_profile(db: Session, kb: Any, environment: str,
                        selected_id: str | None = None) -> str | None:
    """Reuse one exact, ready login identity; never mix fields from profiles."""
    app = test_data.find_app(db, kb_app_id=kb.automation_app_id)
    if not app:
        return None
    candidates = []
    for profile_id, profile in ((kb.roles or {}).get("test_data_profiles") or {}).items():
        if selected_id and profile_id != selected_id:
            continue
        if not isinstance(profile, dict) or profile.get("kind") != "vault":
            continue
        fields = [field for field in profile.get("fields") or [] if isinstance(field, dict)]
        username = [field for field in fields if re.fullmatch(r"\s*(username|user name|email|email address)\s*", str(field.get("name") or ""), re.I)]
        password = [field for field in fields if re.fullmatch(r"\s*password\s*", str(field.get("name") or ""), re.I)]
        if len(username) != 1 or len(password) != 1:
            continue
        variables = [str(username[0].get("variable") or ""), str(password[0].get("variable") or "")]
        if len(set(variables)) != 2 or not all(re.fullmatch(r"TESTDATA_[A-Z0-9_]+", item) for item in variables):
            continue
        resolved = test_data.resolve(app.entries, environment, variables)
        if resolved["missing"]:
            continue
        # A fuzzy match to a similarly named identity must not send that
        # identity's credentials. Setup profiles use exact stored keys.
        exact_keys = [_stored_key(variable) for variable in variables]
        if any(str(resolved["matches"].get(variable) or "").split(" (")[0] != key
               for variable, key in zip(variables, exact_keys)):
            continue
        candidates.append(profile_id)
    return candidates[0] if len(candidates) == 1 else None


def discovery_context(db: Session, setup: dict, row: dict, actions: list[str]) -> dict:
    """The same environment and sign-in prerequisite follow every repair scan."""
    from ...models.automation import AutomationApplication
    from ..journeys import store
    from .registry import address_for_crawl
    app = db.get(AutomationApplication, int(setup["application_id"]))
    address = address_for_crawl(db, setup["app_key"], setup["environment"])
    if not address and app and str(app.environment or "").upper() == str(setup["environment"]).upper():
        address = app.base_url
    if not address:
        raise ValueError("Configure the application address for the selected environment before browser discovery.")
    login = None
    if requires_signed_in_browser(row, actions):
        kb = store.load(setup["app_key"])
        login = observed_login_plan(kb, base_url=address, profile_id=setup.get("profile_id"),
                                    environment=setup.get("environment")) if kb else None
    return {"address": address, "login_journey_id": login["journey_id"] if login else None,
            "profile_id": setup.get("profile_id")}


def observed_login_plan(kb: Any, *, base_url: str, profile_id: str | None,
                        requested_journey: str | None = None,
                        environment: str | None = None) -> dict[str, Any] | None:
    """Select one approved login journey with observed controls on one host/screen.

    The returned structure contains locator evidence, never credential values.
    An ambiguous or incomplete candidate is unresolved rather than guessed.
    """
    from ..journeys import crawl_runs

    candidates: list[dict[str, Any]] = []
    for journey_id, journey in kb.journeys.items():
        if requested_journey and journey_id != requested_journey:
            continue
        if not journey.get("authentication_profile_id") and not _LOGIN_TITLE.search(str(journey.get("name") or "")):
            continue
        if (journey.get('source') or {}).get('kind') == 'human_recorded':
            recorded = _recorded_login(kb, journey, base_url, journey.get('authentication_profile_id') or profile_id, environment)
            if recorded:
                candidates.append({'journey_id': journey_id, **recorded})
            continue
        try:
            plan = crawl_runs._plan(kb, journey_id, base_url=base_url,
                                    profile_id=journey.get("authentication_profile_id") or profile_id,
                                    stop_before=None, allow_risky=False, environment=environment)
        except (ValueError, KeyError):
            continue
        items = plan.get("items") or []
        flexible = _observed_auth_commands(kb, journey, items, base_url,
                                           allowed_origins=trusted_auth_origins(kb, environment))
        if flexible:
            candidates.append({"journey_id": journey_id, **flexible})
    return candidates[0] if len(candidates) == 1 else None


def _recorded_login(kb, journey, base_url, profile_id, environment):
    """Approved first-time recording; OTP remains a fresh human challenge."""
    if (journey.get('source') or {}).get('environment') != environment:
        return None
    success = journey.get('recorded_auth_success')
    if not success:
        return None  # A changed URL alone is not proof of authentication.
    origin = urlparse(base_url)
    allowed = {f'{origin.scheme}://{origin.netloc}'} | trusted_auth_origins(kb, environment)
    profile = ((kb.roles or {}).get('test_data_profiles') or {}).get(profile_id) or {}
    aliases = {'username': {'username', 'user name', 'email', 'email address'}, 'email': {'email', 'email address', 'username'},
               'mobile': {'mobile', 'mobile number', 'phone', 'phone number'}, 'password': {'password'}}
    commands, variables = [], []
    interactive = False
    for step in journey.get('steps') or []:
        rec = step.get('recorded') or {}
        url = rec.get('url') or rec.get('route') or ''
        parsed = urlparse(url)
        if f'{parsed.scheme}://{parsed.netloc}' not in allowed:
            return None
        kind = rec.get('kind')
        if kind == 'verify':
            continue
        if kind == 'goto':
            commands.append({'kind': 'goto', 'url': url}); continue
        if rec.get('unique') is not True or not rec.get('target'):
            return None
        command = {'kind': kind, 'url': url, 'locator': {'strategy': 'css', 'selector': 'xpath=' + rec['target']}}
        if kind in {'fill', 'otp'}:
            field = rec.get('field')
            if field == 'otp' or kind == 'otp':
                command.update(kind='manual_otp', boxes=rec.get('boxes') or 1)
                interactive = True
            else:
                fields = [entry for entry in profile.get('fields') or [] if str(entry.get('name', '')).lower() in aliases.get(field, set())]
                if len(fields) != 1 or not re.fullmatch(r'TESTDATA_[A-Z0-9_]+', str(fields[0].get('variable') or '')):
                    return None
                variable = fields[0]['variable']
                command['variable'] = variable
                if variable not in variables:
                    variables.append(variable)
        elif kind not in {'click'}:
            return None
        commands.append(command)
    parsed = urlparse(success.get('url') or '')
    if (f'{parsed.scheme}://{parsed.netloc}' not in allowed or not variables or not commands
            or commands[0]['kind'] != 'goto' or not any(command['kind'] == 'click' for command in commands)):
        return None
    return {'commands': commands, 'success': success, 'login_url': commands[0]['url'], 'credential_variables': variables,
            'interactive': interactive, 'allowed_origins': sorted(allowed)}


def _observed_auth_commands(kb, journey: dict, items: list, base_url: str,
                            *, allowed_origins: set[str] | None = None) -> dict | None:
    """Compile multi-screen login from approved observed controls and data keys."""
    origin = urlparse(base_url)
    approved = {f"{origin.scheme}://{origin.netloc}"} | (allowed_origins or set())
    commands, fields = [], {}
    clicks = 0
    last_url = None
    last_kind = None
    for item in items:
        if item.get("risky"):
            return None
        screen = kb.screens.get(item.get("screen_id")) or {}
        route = screen.get("route") or ""
        if (not route.startswith("/") or route.startswith("//")) and not route.startswith("https://"):
            return None
        address = urljoin(base_url, route)
        parsed_address = urlparse(address)
        if f"{parsed_address.scheme}://{parsed_address.netloc}" not in approved:
            return None
        kind = item.get("kind")
        if last_url and address != last_url and kind != "goto" and last_kind != "click":
            return None
        last_url, last_kind = address, kind
        if kind == "goto":
            commands.append({"kind": "goto", "url": address})
            continue
        element = next((element for element in screen.get("elements") or []
                        if element.get("element_id") == (item.get("element") or {}).get("element_id")), None)
        if not element:
            return None
        locator = _auth_locator(element)
        if not locator:
            return None
        command = {"kind": kind, "url": address, "locator": locator}
        if kind == "fill":
            variable = item.get("variable") or ""
            if not re.fullmatch(r"TESTDATA_[A-Z0-9_]+", variable):
                return None
            command["variable"] = variable
            label = str(element.get("label") or "").lower()
            field_type = "password" if element.get("type") == "password_input" or "password" in label else (
                "username" if re.search(r"user.?name|e.?mail", label) else None)
            if not field_type or field_type in fields:
                return None
            fields[field_type] = command
        elif kind == "click":
            clicks += 1
        else:
            return None
        commands.append(command)
    if not clicks or set(fields) != {"username", "password"} or fields["username"]["variable"] == fields["password"]["variable"]:
        return None
    # An optional success marker is itself a previously observed control.
    success = None
    marker = journey.get("authentication_success") or {}
    if marker:
        screen = kb.screens.get(marker.get("screen_id")) or {}
        element = next((x for x in screen.get("elements") or [] if x.get("element_id") == marker.get("element_id")), None)
        success = _auth_locator(element or {})
        route = str(screen.get("route") or "")
        if not success or ((not route.startswith("/") or route.startswith("//")) and not route.startswith("https://")):
            return None
        if f"{urlparse(urljoin(base_url, route)).scheme}://{urlparse(urljoin(base_url, route)).netloc}" not in approved:
            return None
        success = {"locator": success, "url": urljoin(base_url, screen["route"])}
    first_url = commands[0]["url"]
    if commands[0]["kind"] != "goto":
        commands.insert(0, {"kind": "goto", "url": first_url})
    return {"commands": commands, "success": success, "login_url": first_url,
            "credential_variables": [fields["username"]["variable"], fields["password"]["variable"]],
            "login_origin": f"{urlparse(first_url).scheme}://{urlparse(first_url).netloc}",
            "screen_route": urlparse(first_url).path,
            "username_selector": fields["username"]["locator"].get("selector"),
            "password_selector": fields["password"]["locator"].get("selector"),
            "submit_name": next((c["locator"].get("name") for c in reversed(commands) if c["kind"] == "click"), None)}


def _auth_locator(element: dict) -> dict | None:
    strategy, selector = element.get("observed_strategy"), element.get("observed_selector")
    if strategy == "css" and isinstance(selector, str) and selector:
        return {"strategy": "css", "selector": selector}
    if strategy == "role" and element.get("type") and element.get("label"):
        role = {"text_input": "textbox", "password_input": "textbox"}.get(element["type"], element["type"])
        return {"strategy": "role", "role": role, "name": element["label"]}
    return None


def gap_message(*, row: dict[str, Any], actions: list[str], discovery: Any,
                credential_names: set[str], environment: str) -> str | None:
    """Describe the unmet prerequisite before an anonymous mapping is drafted."""
    if not requires_signed_in_browser(row, actions):
        return None
    if discovery is not None and getattr(discovery, "auth_status", None) == "verified":
        return None
    missing = {"username", "password"} - credential_names
    data_note = (f"{environment} Test Data has username and password, but login is unverified."
                 if not missing else
                 f"{environment} Test Data is missing {', '.join(sorted(missing))} for this sign-in.")
    blockers = getattr(discovery, "blockers", None) or []
    protected = any(isinstance(item, dict) and re.search(r"account|overview|profile", str(item.get("url") or ""), re.I)
                    for item in blockers)
    blocked_note = " Protected account routes were blocked." if protected else ""
    status = getattr(discovery, "auth_status", None)
    guidance = ("The authenticated scan did not verify sign-in. Check the saved Test Data and retry this agent."
                if status == "failed" else
                "Add or repair one approved login journey with observed controls, then retry this agent.")
    return (f"Signed-in browser evidence is required. {data_note}"
            f" The anonymous scan cannot verify the account journey.{blocked_note}"
            f" {guidance} Protected-page mapping stays unresolved until browser sign-in succeeds.")
