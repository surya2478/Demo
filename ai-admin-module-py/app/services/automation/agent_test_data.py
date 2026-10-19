"""Prepare case-scoped test values and a reviewable profile from observed fields."""
from __future__ import annotations

import re
from urllib.parse import urlparse

from sqlalchemy.orm import Session

from ...models.automation import AutomationAICheck, AutomationDiscoveredElement, AutomationDiscoveryRun, AutomationTestCase, AutomationTestData
from ...models.kb_changes import KbChangeSet
from ..journeys import changesets, store
from . import agent_journey, test_data, workbench


def _check(db: Session, batch_id: str, check_id: int) -> AutomationAICheck:
    check = db.get(AutomationAICheck, check_id)
    if not check or check.batch_id != batch_id:
        raise ValueError("This case has no saved agent work.")
    if check.status != 'awaiting_approval':
        from ...models.database import TestCaseDetail
        from .evaluation_handoff import linked_check
        ref = (check.steps or {}).get('_evaluation_handoff') or {}
        row = db.query(TestCaseDetail).filter(TestCaseDetail.request_id == ref.get('request_id'),
            TestCaseDetail.test_case_id == ref.get('test_case_id')).first() if ref else None
        if check.status not in {'failed', 'done'} or not row or row.status != 'PENDING' or linked_check(db, row) is not check:
            raise ValueError('Only paused agent work or a pending Human Evaluation case can change test data.')
    return check


def _required_fields(case: AutomationTestCase | None) -> list[str]:
    """Use requirement keys, never example values, to find compatible stored data."""
    if not case:
        return []
    required = []
    for item in case.test_data_requirements or []:
        if not isinstance(item, dict):
            continue
        value = re.sub(r'[^a-z0-9]+', ' ', str(item.get('key') or item.get('description') or '').lower())
        value = re.sub(r'\b(valid|registered|correct|customer|account|for|the|login|test)\b', ' ', value)
        value = re.sub(r'[^a-z0-9]+', '_', value).strip('_')
        if value and value not in required:
            required.append(value)
    return required


def _ready_profiles(profiles: list[dict], environment: str, requirements: list[str]) -> list[dict]:
    if not requirements:
        return []
    result = []
    for profile in profiles:
        cell = (profile.get('cells') or {}).get(environment) or {}
        if profile.get('kind') != 'vault' or cell.get('status') != 'ready':
            continue
        fields = [re.sub(r'[^a-z0-9]+', '_', str(field.get('variable') or field.get('name') or '').lower()).strip('_')
                  for field in profile.get('fields') or []]
        if all(any(field == f'testdata_{needed}' or field.endswith(f'_{needed}') or field == needed
                   for field in fields) for needed in requirements):
            result.append(profile)
    return result


def _explicit_field_values(actions: list[str], field_names: list[str]) -> dict[str, str]:
    """Extract only literal values unambiguously named in an action and input."""
    values: dict[str, str] = {}
    for name in field_names:
        key = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
        if not key:
            continue
        label = re.escape(name).replace(r"\ ", r"\s+")
        pattern = re.compile(
            rf"^\s*(?:enter|fill|type)\s+(?:the\s+)?{label}\s+(.+?)\s+"
            rf"(?:into|in)\s+(?:the\s+)?{label}\s+(?:field|box|input)\b", re.I)
        for action in actions:
            match = pattern.search(action)
            if match:
                value = match.group(1).strip().strip("'\"")
                if value:
                    values[key] = value
    return values


def profile_for_explicit_values(db: Session, *, app_key: str, environment: str,
                                actions: list[str], selected_id: str | None) -> tuple[str | None, str | None]:
    """Keep a batch profile only if it agrees with literals in this case.

    A unique ready profile may replace it. Ambiguity or missing values are
    reported before browser replay; credentials are never synthesized or logged.
    """
    kb = store.load(app_key)
    app = test_data.find_app(db, kb_app_id=app_key) if kb else None
    if not kb or not app:
        return selected_id, None
    profiles = (kb.roles or {}).get("test_data_profiles") or {}
    names = [str(field.get("name") or "") for profile in profiles.values() if isinstance(profile, dict)
             for field in profile.get("fields") or [] if isinstance(field, dict)]
    explicit = _explicit_field_values(actions, list(dict.fromkeys(names)))
    if not explicit:
        return selected_id, None
    matching: list[str] = []
    for profile_id, profile in profiles.items():
        if not isinstance(profile, dict) or profile.get("kind") != "vault":
            continue
        fields = [field for field in profile.get("fields") or [] if isinstance(field, dict)]
        variables = tuple(str(field.get("variable") or "") for field in fields)
        if not variables or any(not variable for variable in variables):
            continue
        resolved = test_data.resolve(app.entries, environment, variables)["values"]
        if len(resolved) != len(variables):
            continue
        by_name = {re.sub(r"[^a-z0-9]+", "_", str(field.get("name") or "").lower()).strip("_"): resolved.get(field["variable"])
                   for field in fields}
        if all(by_name.get(name) == value for name, value in explicit.items()):
            matching.append(profile_id)
    if selected_id in matching:
        return selected_id, None
    if len(matching) == 1:
        return matching[0], None
    field_list = ", ".join(sorted(explicit))
    if matching:
        return selected_id, f"Several ready Test Data profiles match the case's explicit {field_list} values. Choose one for this case before browser replay."
    return selected_id, f"The selected Test Data profile conflicts with the case's explicit {field_list} values, and no ready matching profile exists. Add this case's values before browser replay."


def _observed_requirement_fields(controls: list[AutomationDiscoveredElement], application_url: str,
                                 requirements: list[str]) -> list[dict]:
    """Recover case-relevant inputs from the scan when journey wording did not map them."""
    host = urlparse(application_url).hostname
    entry = agent_journey._route(application_url).rstrip("/")
    fields = []
    for requirement in requirements:
        matches = []
        for control in controls:
            if (urlparse(control.page_url or "").hostname != host
                    or int(control.confidence_score or 0) < 70
                    or (control.role or "").lower() not in {"textbox", "searchbox", "spinbutton"}
                    or not control.recommended_locator):
                continue
            name = re.sub(r"[^a-z0-9]+", "_", (control.accessible_name or "").lower()).strip("_")
            if name != requirement:
                continue
            route = agent_journey._route(control.page_url).rstrip("/")
            on_entry = route in {entry, entry + "/index.htm", entry + "/index.html"}
            matches.append((1 if on_entry else 0, int(control.confidence_score or 0), control))
        if not matches:
            continue
        matches.sort(key=lambda item: (item[0], item[1]), reverse=True)
        best = matches[0]
        # Two equally strong selectors on the same page are not a verified field.
        if any(item[:2] == best[:2] and item[2].recommended_locator != best[2].recommended_locator
               and agent_journey._route(item[2].page_url) == agent_journey._route(best[2].page_url)
               for item in matches[1:]):
            continue
        name = best[2].accessible_name.strip()
        fields.append({"name": name, "variable": "TESTDATA_" + requirement.upper(),
                       "is_secret": bool(re.search(r"password|secret|token|pin|ssn", requirement, re.I))})
    return fields


def assign_existing(db: Session, batch_id: str, check_id: int, *, profile_id: str, actor: str) -> dict:
    check = _check(db, batch_id, check_id)
    info = suggestion(db, batch_id, check_id)
    if profile_id not in info['ready_profile_ids']:
        raise ValueError('Choose a ready KB profile that covers this case in the selected environment.')
    state = dict(check.steps or {})
    setup = dict(state.get('_agent_setup') or {})
    setup['profile_id'] = profile_id
    state['_agent_setup'] = setup
    check.steps = state
    case = db.get(AutomationTestCase, check.case_id) if check.case_id else None
    if case:
        # Replace only explicit missing-data placeholders with profile keys,
        # never with secret values. Ambiguous steps remain visibly pending.
        steps = [dict(step) for step in (case.steps_structured or [])]
        for step in steps:
            ref = str(step.get('test_data_ref') or '')
            if not re.fullmatch(r'<<TODO:[^>]*>>', ref):
                continue
            action = str(step.get('action') or '').lower()
            matches = [requirement for requirement in info['requirements']
                       if requirement.replace('_', ' ') in action or requirement in action]
            if len(matches) == 1:
                step['test_data_ref'] = matches[0]
        case.steps_structured = steps
        remaining = ' '.join(str(step.get('test_data_ref') or '') for step in steps)
        if not re.search(r'<<TODO:[^>]*>>', remaining):
            case.test_data_status = workbench.TEST_DATA_KB_PROVIDED
            case.test_data_notes = (f'Approval Manager linked stored KB profile {profile_id} for {info["environment"]}. '
                                    'Browser execution must still confirm the account works.')
    db.commit()
    return {'profile_id': profile_id, 'message': f'Approval Manager selected ready KB profile {profile_id} for {info["environment"]}. A browser run must still confirm the account works.', 'assigned_by': actor}


def suggestion(db: Session, batch_id: str, check_id: int) -> dict:
    check = _check(db, batch_id, check_id)
    setup = (check.steps or {}).get("_agent_setup") or {}
    kb = store.load(setup.get("app_key") or "")
    if not kb:
        raise ValueError("The selected application has no Journey KB.")
    app = test_data.find_app(db, kb_app_id=setup["app_key"])
    if not app:
        raise ValueError("Register this application in Test Data first.")
    from ..journeys import workspace
    coverage = workspace.test_data_coverage(kb, db)
    case = db.get(AutomationTestCase, check.case_id) if check.case_id else None
    requirements = _required_fields(case)
    ready = _ready_profiles(coverage['profiles'], str(setup['environment']).upper(), requirements)
    source_text = ' '.join(str(value or '') for key, value in (check.source_row or {}).items()
                           if isinstance(value, (str, int, float)))
    # Generated cases can omit test_data_requirements. That must not make a
    # login case eligible for silently prepared synthetic credentials.
    requires_existing_account = bool(re.search(r'\b(sign[ -]?in|log[ -]?in|login|authenticate)\b', source_text, re.I))
    external_requirement = any(
        re.search(r'\b(existing|externally|actual|registered|prior|credential|real)\b',
                  str(item.get('resolution') or '') + ' ' + str(item.get('description') or ''), re.I)
        for item in (case.test_data_requirements or []) if isinstance(item, dict)
    ) if case else False
    discovery = (db.query(AutomationDiscoveryRun)
                 .filter(AutomationDiscoveryRun.application_id == setup.get("application_id"),
                         AutomationDiscoveryRun.application_environment == setup.get('environment'),
                         AutomationDiscoveryRun.status == "completed")
                 .order_by(AutomationDiscoveryRun.id.desc()).first())
    actions = agent_journey.source_steps(check.source_row or {})
    steps, screens, _ = agent_journey.observed_mapping(db, discovery, actions)
    fields = []
    seen = set()
    for step in steps:
        if not re.match(r"\s*(enter|fill|type)", step["action"], re.I):
            continue
        screen = screens.get(step.get("screen_id")) or {}
        control = next((item for item in screen.get("elements") or []
                        if item.get("element_id") == step.get("element_id")), None)
        if not control:
            continue
        label = re.sub(r"\s+", " ", (control.get("label") or "").strip(" *:"))
        if not label:
            continue
        name = "Password" if re.search(r"confirm.*password|password.*confirm|^confirm$", label, re.I) else label
        variable = "TESTDATA_" + re.sub(r"[^A-Z0-9]+", "_", name.upper()).strip("_")
        if variable in seen:
            continue
        seen.add(variable)
        fields.append({"name": name, "variable": variable,
                       "is_secret": bool(re.search(r"password|secret|token|pin|ssn", name, re.I))})
    if discovery and requirements:
        controls = (db.query(AutomationDiscoveredElement)
                    .filter(AutomationDiscoveredElement.discovery_run_id == discovery.id).all())
        recovered = _observed_requirement_fields(controls, discovery.application_url or "", requirements)
        by_variable = {field["variable"]: field for field in fields}
        for field in recovered:
            by_variable.setdefault(field["variable"], field)
        fields = [by_variable["TESTDATA_" + requirement.upper()]
                  for requirement in requirements if "TESTDATA_" + requirement.upper() in by_variable]
    profile_id = f"AGENT_CASE_{check.case_id}"
    # Different cases may deliberately use different identities (including
    # invalid credentials). Never overwrite application-wide username/password.
    existing_profile = next((p for p in coverage["profiles"] if p["profile_id"] == profile_id), None)
    if existing_profile:
        fields = existing_profile["fields"]
    else:
        fields = [{**field, "variable": f"TESTDATA_CASE_{check.case_id}_" + field["variable"].removeprefix("TESTDATA_")}
                  for field in fields]
    selected_id = setup.get("profile_id") or profile_id
    return {"app_key": setup["app_key"], "environment": setup["environment"],
            "profile_id": profile_id, "profile_exists": any(p["profile_id"] == profile_id for p in coverage["profiles"]),
            "fields": fields,
            "profiles": [{"profile_id": p["profile_id"], "name": p["name"],
                          "fields": p["fields"], "cells": p["cells"]}
                         for p in coverage["profiles"] if p["kind"] == "vault"],
            "requirements": requirements,
            "ready_profile_ids": [profile['profile_id'] for profile in ready],
            "recommended_profile_id": next((p['profile_id'] for p in ready if p['profile_id'] == selected_id), None),
            "requires_existing_account": requires_existing_account,
            "synthetic_safe": not (requires_existing_account or external_requirement),
            "observed_pages": len(discovery.explored_pages or []) if discovery else 0}


def save(db: Session, batch_id: str, check_id: int, *, profile_id: str,
         values: dict[str, str], actor: str) -> dict:
    check = _check(db, batch_id, check_id)
    info = suggestion(db, batch_id, check_id)
    setup = dict((check.steps or {}).get("_agent_setup") or {})
    if re.match(r"^(production|prod|live)$", setup["environment"], re.I):
        raise ValueError("Synthetic or manually entered agent data must use a non-production environment.")
    selected = next((p for p in info["profiles"] if p["profile_id"] == profile_id), None)
    if not selected and profile_id != info["profile_id"]:
        raise ValueError("Choose the suggested profile or an existing profile for this application.")
    fields = selected["fields"] if selected else info["fields"]
    if not fields:
        raise ValueError("No verified input fields were captured. Check the journey evidence first.")
    variables = {field["variable"] for field in fields if field.get("variable")}
    if set(values) != variables or any(not isinstance(v, str) or not v.strip() or len(v) > 4000 for v in values.values()):
        raise ValueError("Provide a value for every captured field before saving.")
    kb = store.load(info["app_key"])
    app = test_data.find_app(db, kb_app_id=info["app_key"])
    if not app:
        raise ValueError("The application is missing from Test Data.")
    change_id = None
    if not selected:
        previous = (db.query(KbChangeSet).filter(KbChangeSet.app_id == info["app_key"],
                    KbChangeSet.source == "agent-test-data", KbChangeSet.status == "draft")
                    .order_by(KbChangeSet.id.desc()).all())
        existing_draft = next((item for item in previous
                               if (item.origin or {}).get("ai_check_case_id") == check.case_id), None)
        if existing_draft:
            change_id = existing_draft.id
        profiles = dict((kb.roles or {}).get("test_data_profiles") or {})
        if profile_id in profiles:
            raise ValueError("This profile already exists. Refresh the screen and select it.")
        if not change_id:
            profiles[profile_id] = {"name": f"Agent test data for case {check.case_id}",
                                    "description": "Fields verified during browser discovery; values are kept separately in Test Data.",
                                    "kind": "vault", "fields": [{"name": f["name"], "variable": f["variable"]} for f in fields],
                                    "state": "Synthetic or test-only values"}
            change = changesets.draft(db, app_id=info["app_key"], kb="journey", source="agent-test-data",
                                      title=f"Test Data profile for case {check.case_id}",
                                      description="Review captured field names. Values are encrypted in Test Data and not included in this proposal.",
                                      changes=[{"file": "roles.json", "op": "set", "path": "test_data_profiles", "value": profiles}],
                                      origin={"ai_check_case_id": check.case_id}, actor=actor)
            change_id = change.id
    for field in fields:
        variable = field["variable"]
        key = variable.removeprefix("TESTDATA_").lower().replace("_", ".")
        entry = next((item for item in app.entries
                      if item.environment == info["environment"] and item.key.lower() == key), None)
        if entry is None:
            entry = AutomationTestData(app_id=app.id, environment=info["environment"], key=key)
            db.add(entry)
        secret = bool(field.get("is_secret") or re.search(r"password|secret|token|pin|ssn", variable, re.I))
        entry.is_secret = secret
        entry.value = test_data.encrypt(values[variable]) if secret else values[variable]
        entry.updated_by = actor
    state = dict(check.steps or {})
    setup["profile_id"] = profile_id
    state["_agent_setup"] = setup
    check.steps = state
    db.commit()
    return {"profile_id": profile_id, "change_set_id": change_id,
            "message": "Test values saved. Approve the profile proposal before asking the agent to decide." if change_id
                       else "Test values saved. Ask the agent to check this change again."}
