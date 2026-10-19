"""The guide stage prepares a draft; it never presents source text as browser proof."""
from unittest.mock import Mock, patch
import json
from types import SimpleNamespace

from app.services.automation.agent_journey import _action_control_score, draft_from_case, observed_mapping, source_steps
from app.services.automation.expert_editor import EditorAnswer, EditorChoice, EditorReport, inspect_journey, requirements_note, review as editor_review
from app.services.automation.expert_editor import ExpertEditorReviewError
from app.services.journeys import changesets
from app.services.automation.discovery import parse_discovery_output
from app.services.journeys.journey_crawl import _profile_variable_for_input, entry_address


def test_source_steps_are_taken_from_saved_case():
    assert source_steps({"Steps": "1. Click Register\n2. Enter username"}) == ["Click Register", "Enter username"]


def test_entry_url_keeps_exact_registered_page_or_directory():
    assert entry_address("https://the-internet.herokuapp.com/login") == "https://the-internet.herokuapp.com/login"
    assert entry_address("https://shop.example.test/login") == "https://shop.example.test/login"
    assert entry_address("https://bank.example.test/b2bportal/") == "https://bank.example.test/b2bportal/"
    assert entry_address("https://shop.example.test/login/") != "https://shop.example.test/login"


def test_directory_entry_can_use_observed_index_html_on_two_unrelated_apps():
    for host, directory in (("www.eand.ae", "/en"), ("bank.example.test", "/portal")):
        control = SimpleNamespace(
            page_url=f"https://{host}{directory}/index.html", page_title="Home",
            role="link", accessible_name="Devices", element_name="link_devices",
            confidence_score=90, href="#", recommended_locator="page.getByRole('link', { name: 'Devices' })",
            recommended_strategy="role",
        )
        db = Mock()
        db.query.return_value.filter.return_value.all.return_value = [control]
        run = SimpleNamespace(id=91, application_url=f"https://{host}{directory}", explored_pages=[
            {"url": control.page_url, "title": "Home", "status": 200},
        ])
        steps, _, missing = observed_mapping(db, run, [f"Open {control.page_url}", "Navigate to Devices"])
        assert missing == []
        assert steps[0]["screen_id"] and steps[0]["element_id"] is None
        assert steps[1]["screen_id"] == steps[0]["screen_id"]
        assert steps[1]["element_id"] == "link_devices"


def test_entry_url_does_not_use_a_wrong_host_or_unobserved_screen():
    db = Mock()
    db.query.return_value.filter.return_value.all.return_value = []
    run = SimpleNamespace(id=92, application_url="https://shop.example.test/en", explored_pages=[
        {"url": "https://other.example.test/en/index.html", "title": "Other", "status": 200},
        {"url": "https://shop.example.test/en/private.html", "title": "Private", "status": 200},
    ])
    steps, _, missing = observed_mapping(db, run, ["Open https://shop.example.test/en/index.html"])
    assert steps[0]["screen_id"] is None and missing


def test_combined_form_step_is_split_into_observable_fields():
    assert source_steps({"Steps": "1. Enter valid first name, last name and password\n2. Click Register"}) == [
        "Enter valid first name", "Enter valid last name", "Enter valid password", "Click Register",
    ]


def test_literal_or_followup_conjunction_is_not_split_as_two_fields():
    assert source_steps({"Steps": "1. Enter 'John and Jane' into Name field\n2. Enter a search term and press Enter"}) == [
        "Enter 'John and Jane' into Name field", "Enter a search term and press Enter",
    ]


def test_discovery_keeps_same_named_fields_on_different_pages():
    raw = json.dumps({"pages": [], "elements": [
        {"page_url": "https://example.test/login", "role": "textbox", "accessible_name": "Username", "recommended_locator": "page.locator('[name=\"login\"]')"},
        {"page_url": "https://example.test/register", "role": "textbox", "accessible_name": "Username", "recommended_locator": "page.locator('[name=\"register\"]')"},
    ]})
    assert len(parse_discovery_output(raw)["elements"]) == 2


def test_navigation_guide_uses_entry_route_and_verified_form_selector():
    def control(page, role, label, name, confidence=80, href=None, locator="", strategy="role"):
        return SimpleNamespace(page_url=f"https://example.test/app/{page}", page_title=page,
                               role=role, accessible_name=label, element_name=name,
                               confidence_score=confidence, href=href,
                               recommended_locator=locator, recommended_strategy=strategy)
    controls = [
        control("admin.htm", "link", "Register", "link_register", href="register.htm"),
        control("index.htm", "link", "Register", "link_register", href="register.htm"),
        control("register.htm", "textbox", "Username", "textbox_username", 88,
                locator="page.locator('[name=\"username\"]')", strategy="css"),
        control("register.htm", "textbox", "Username:", "textbox_customer_username", 92,
                locator="page.locator('[id=\"customer.username\"]')", strategy="css"),
        control("register.htm", "button", "Register", "button_register"),
    ]
    db = Mock()
    db.query.return_value.filter.return_value.all.return_value = controls
    discovery = SimpleNamespace(id=3, application_url="https://example.test/app")
    steps, screens, unresolved = observed_mapping(db, discovery, [
        "Open the registration page", "Enter valid username", "Click the registration submit button",
    ])
    assert unresolved == []
    assert [step["element_id"] for step in steps] == ["link_register", "textbox_customer_username", "button_register"]
    assert any(element.get("observed_selector") == '[id="customer.username"]'
               for screen in screens.values() for element in screen["elements"])


def test_registration_fields_use_their_own_test_data_variables():
    profile = {"fields": [
        {"name": "First Name", "variable": "FIRST_NAME"},
        {"name": "Last Name", "variable": "LAST_NAME"},
        {"name": "Password", "variable": "PASSWORD"},
    ]}
    assert _profile_variable_for_input(profile, {"label": "First Name:"}) == "FIRST_NAME"
    assert _profile_variable_for_input(profile, {"label": "Last Name:"}) == "LAST_NAME"
    assert _profile_variable_for_input(profile, {"label": "Confirm:"}) == "PASSWORD"


def test_registration_navigation_and_submit_are_distinct_observed_controls():
    register_link = Mock(role="link", accessible_name="Register")
    register_button = Mock(role="button", accessible_name="Register")
    assert _action_control_score("Open the ParaBank registration page", register_link) > 0
    assert _action_control_score("Open the ParaBank registration page", register_button) == 0
    assert _action_control_score("Click the registration submit button", register_button) > _action_control_score(
        "Click the registration submit button", register_link)
    # One combined instruction must not falsely claim that one input covers all fields.
    assert _action_control_score("Enter first name, last name and password", Mock(role="textbox", accessible_name="First Name")) == 0


def test_sign_in_uses_all_scanned_pages_and_splits_credentials():
    def control(route, role, label, locator, host="shop.example.test"):
        return SimpleNamespace(page_url=f"https://{host}/{route}", page_title=route,
                               role=role, accessible_name=label, element_name=f"{role}_{label.lower().replace(' ', '_')}",
                               confidence_score=88, href=None, recommended_locator=locator,
                               recommended_strategy="css")
    controls = [
        control("home", "textbox", "Username", "page.locator('[name=\"username\"]')"),
        control("home", "textbox", "Password", "page.locator('[name=\"password\"]')"),
        control("home", "button", "Log In", "page.locator('[id=\"login\"]')"),
        control("catalog", "button", "Add to Cart", "page.locator('[id=\"cart\"]')"),
    ]
    db = Mock()
    db.query.return_value.filter.return_value.all.return_value = controls
    run = SimpleNamespace(id=7, application_url="https://shop.example.test/home", explored_pages=[
        {"url": "https://shop.example.test/home", "title": "Home", "status": 200},
        {"url": "https://shop.example.test/catalog", "title": "Catalog", "status": 200},
    ])
    actions = source_steps({"Test Steps": "1. Open the login page. 2. Enter the registered username and correct password. 3. Click the Sign In button."})
    steps, screens, missing = observed_mapping(db, run, actions)
    assert len(actions) == 4 and not missing
    assert [step["element_id"] for step in steps] == [None, "textbox_username", "textbox_password", "button_log_in"]
    assert any(item["label"] == "Add to Cart" for screen in screens.values() for item in screen["elements"])


def test_recovery_navigation_follows_link_before_mapping_existing_fields():
    def control(page, role, label, name, href=None):
        return SimpleNamespace(page_url=f"https://bank.test/app/{page}", page_title=page,
                               role=role, accessible_name=label, element_name=name,
                               confidence_score=92, href=href,
                               recommended_locator=f"page.getByRole('{role}', {{ name: '{label}' }})",
                               recommended_strategy="role")
    controls = [
        control("index.htm", "link", "Forgot login info?", "forgot_login", "lookup.htm"),
        control("lookup.htm", "textbox", "Address:", "address"),
        control("lookup.htm", "textbox", "City:", "city"),
    ]
    db = Mock()
    db.query.return_value.filter.return_value.all.return_value = controls
    run = SimpleNamespace(id=12, application_url="https://bank.test/app", explored_pages=[
        {"url": "https://bank.test/app/index.htm", "title": "Home", "status": 200},
        {"url": "https://bank.test/app/lookup.htm", "title": "Recovery", "status": 200},
    ])
    steps, _, missing = observed_mapping(db, run, [
        'Open the "Forgot login info" page', "Enter address", "Enter city",
    ])
    assert [step["element_id"] for step in steps] == ["forgot_login", "address", "city"]
    assert missing == []


def test_published_browser_controls_remain_reusable_after_later_thin_scan():
    db = Mock()
    db.query.return_value.filter.return_value.all.return_value = []
    run = SimpleNamespace(id=13, application_url="https://bank.test/app", explored_pages=[])
    screens = {"LOOKUP": {"screen_id": "LOOKUP", "name": "Recovery", "route": "/app/lookup.htm", "elements": [
        {"element_id": "address", "label": "Address:", "type": "text_input",
         "observed_locator": "page.locator('[name=address]')", "observed_strategy": "css"},
    ]}}
    steps, _, missing = observed_mapping(db, run, ["Enter address"], existing_screens=screens)
    assert steps[0]["screen_id"] == "LOOKUP"
    assert steps[0]["element_id"] == "address"
    assert missing == []


def test_discovery_cannot_map_wrong_host_or_ambiguous_control():
    def control(host, name, locator):
        return SimpleNamespace(page_url=f"https://{host}/entry", page_title="Entry", role="button",
                               accessible_name=name, element_name="button_continue", confidence_score=80,
                               href=None, recommended_locator=locator, recommended_strategy="role")
    db = Mock()
    db.query.return_value.filter.return_value.all.return_value = [
        control("foreign.test", "Continue", "page.getByRole('button', { name: 'Continue' })"),
        control("local.test", "Continue", "page.getByRole('button', { name: 'Continue' })"),
        control("local.test", "Continue", "page.getByRole('button', { name: 'Continue' }).nth(1)"),
    ]
    run = SimpleNamespace(id=8, application_url="https://local.test/entry", explored_pages=[
        {"url": "https://local.test/entry", "title": "Entry", "status": 200},
        {"url": "https://foreign.test/entry", "title": "Foreign", "status": 200},
    ])
    steps, screens, missing = observed_mapping(db, run, ["Click Continue"])
    assert steps[0]["element_id"] is None and missing
    assert all("foreign" not in screen["screen_id"].lower() for screen in screens.values())


def test_expert_editor_can_resolve_equivalent_wording_only_on_observed_screen():
    control = SimpleNamespace(page_url="https://shop.example.test/login", page_title="Login",
                              role="button", accessible_name="Continue", element_name="button_continue",
                              confidence_score=80, href=None,
                              recommended_locator="page.getByRole('button', { name: 'Continue' })",
                              recommended_strategy="role")
    db = Mock()
    db.query.return_value.filter.return_value.all.return_value = [control]
    run = SimpleNamespace(id=9, application_url="https://shop.example.test/login", explored_pages=[
        {"url": "https://shop.example.test/login", "title": "Login", "status": 200},
    ])
    report = EditorReport({1: EditorChoice(step_number=1, candidate_id=0, equivalent=True,
                                           reason="Continue advances this sign-in form.")}, "Reviewed one action.")
    notes = []
    with patch("app.services.automation.expert_editor.review", return_value=report):
        steps, _, missing = observed_mapping(db, run, ["Click the Sign In control"], editor_notes=notes)
    assert not missing and steps[0]["element_id"] == "button_continue"
    assert any("mapped equivalent wording" in note for note in notes)


def test_editor_cannot_replace_observed_entry_navigation_with_unrelated_link():
    for host, route in (("the-internet.herokuapp.com", "login"), ("shop.example.test", "signin")):
        link = SimpleNamespace(page_url=f"https://{host}/{route}", page_title="Sign in",
                               role="link", accessible_name="Elemental Selenium", element_name="unrelated_link",
                               confidence_score=90, href="https://elsewhere.test/", recommended_locator="page.getByRole('link', { name: 'Elemental Selenium' })",
                               recommended_strategy="role")
        db = Mock()
        db.query.return_value.filter.return_value.all.return_value = [link]
        run = SimpleNamespace(id=22, application_url=f"https://{host}/{route}", explored_pages=[
            {"url": f"https://{host}/{route}", "title": "Sign in", "status": 200},
        ])
        report = EditorReport({1: EditorChoice(step_number=1, candidate_id=0, equivalent=True,
                                               reason="This link sounds like navigation.")}, "Reviewed entry.")
        notes = []
        with patch("app.services.automation.expert_editor.review", return_value=report):
            steps, _, missing = observed_mapping(db, run, [f"Navigate to the {route} page"], editor_notes=notes)
        assert steps[0]["screen_id"] and steps[0]["element_id"] is None and missing == []
        assert any("ignored a link suggestion" in note for note in notes)


def test_expert_editor_cannot_override_current_screen():
    control = SimpleNamespace(page_url="https://shop.example.test/admin", page_title="Admin",
                              role="button", accessible_name="Continue", element_name="button_continue",
                              confidence_score=80, href=None,
                              recommended_locator="page.getByRole('button', { name: 'Continue' })",
                              recommended_strategy="role")
    db = Mock()
    db.query.return_value.filter.return_value.all.return_value = [control]
    run = SimpleNamespace(id=10, application_url="https://shop.example.test/home", explored_pages=[
        {"url": "https://shop.example.test/home", "title": "Home", "status": 200},
        {"url": "https://shop.example.test/admin", "title": "Admin", "status": 200},
    ])
    report = EditorReport({1: EditorChoice(step_number=1, candidate_id=0, equivalent=True,
                                           reason="It sounds similar.")}, "Reviewed one action.")
    with patch("app.services.automation.expert_editor.review", return_value=report):
        steps, _, missing = observed_mapping(db, run, ["Click the Sign In control"], editor_notes=[])
    assert steps[0]["element_id"] is None and missing


def test_editor_disagreement_holds_mapping_for_review():
    def control(label, name):
        return SimpleNamespace(page_url="https://shop.example.test/home", page_title="Home",
                               role="button", accessible_name=label, element_name=name,
                               confidence_score=80, href=None,
                               recommended_locator=f"page.getByRole('button', {{ name: '{label}' }})",
                               recommended_strategy="role")
    db = Mock()
    db.query.return_value.filter.return_value.all.return_value = [
        control("Submit", "button_submit"), control("Continue", "button_continue"),
    ]
    run = SimpleNamespace(id=11, application_url="https://shop.example.test/home", explored_pages=[
        {"url": "https://shop.example.test/home", "title": "Home", "status": 200},
    ])
    report = EditorReport({1: EditorChoice(step_number=1, candidate_id=1, equivalent=True,
                                           reason="Continue may mean submit here.")}, "Reviewed one action.")
    notes = []
    with patch("app.services.automation.expert_editor.review", return_value=report):
        steps, _, missing = observed_mapping(db, run, ["Click Submit"], editor_notes=notes)
    assert steps[0]["element_id"] is None and missing
    assert any("conflicting semantic match" in note for note in notes)


def test_keyword_match_needs_semantic_confirmation_on_unrelated_application():
    control = SimpleNamespace(page_url="https://shop.example.test/cart", page_title="Cart",
                              role="button", accessible_name="Continue", element_name="button_continue",
                              confidence_score=90, href=None,
                              recommended_locator="page.getByRole('button', { name: 'Continue' })",
                              recommended_strategy="role")
    db = Mock()
    db.query.return_value.filter.return_value.all.return_value = [control]
    run = SimpleNamespace(id=12, application_url="https://shop.example.test/cart",
                          explored_pages=[{"url": "https://shop.example.test/cart", "title": "Cart", "status": 200}])
    with patch("app.services.automation.expert_editor.review", return_value=EditorReport({}, "No semantic match.")):
        steps, _, missing = observed_mapping(db, run, ["Click Continue"], editor_notes=[])
    assert steps[0]["element_id"] is None and missing


def test_editor_failure_is_not_silent_on_reported_bank_case():
    control = SimpleNamespace(page_url="https://bank.example.test/forgot.htm", page_title="Recover",
                              role="textbox", accessible_name="First Name", element_name="first_name",
                              confidence_score=90, href=None,
                              recommended_locator="page.locator('[name=firstName]')", recommended_strategy="css")
    db = Mock()
    db.query.return_value.filter.return_value.all.return_value = [control]
    run = SimpleNamespace(id=13, application_url="https://bank.example.test/forgot.htm",
                          explored_pages=[{"url": "https://bank.example.test/forgot.htm", "title": "Recover", "status": 200}])
    with patch("app.services.automation.expert_editor.review", side_effect=ExpertEditorReviewError("Invalid OpenRouter response")):
        try:
            observed_mapping(db, run, ["Enter first name"], editor_notes=[])
        except ExpertEditorReviewError:
            pass
        else:
            assert False, "A failed semantic review must interrupt the mapping"


def test_editor_requirements_note_reports_action_review_without_claiming_atomicity():
    assert "2 source action" in requirements_note(["Enter username", "Enter password"])
    note = requirements_note(["Sign in", "Select account type and funding account"])
    assert "sign-in shorthand" in note
    assert "combine multiple controls" in note


def test_editor_prompt_excludes_other_application_and_unknown_choice():
    controls = [
        {"candidate_id": 0, "page_url": "https://foreign.test/home", "role": "button", "accessible_name": "Log In", "confidence_score": 80},
        {"candidate_id": 1, "page_url": "https://local.test/home", "role": "button", "accessible_name": "Log In", "confidence_score": 80},
    ]
    answer = EditorAnswer(choices=[EditorChoice(step_number=1, candidate_id=0, equivalent=True,
                                                reason="Wrong host should be ignored.")])
    with patch("app.services.automation.expert_editor.complete_json", return_value=answer) as call:
        report = editor_review(["Click Sign In"], controls, "https://local.test/home")
    assert not report.choices
    assert "foreign.test" not in call.call_args.kwargs["user_input"]


def test_editor_independent_journey_audit_detects_role_mismatch():
    journey = {"steps": [{"step_number": 1, "action": "Fill email", "screen_id": "LOGIN", "element_id": "submit"}]}
    screens = {"LOGIN": {"elements": [{"element_id": "submit", "type": "button"}]}}
    assert "fills a non-input" in inspect_journey(journey, screens)


def test_missing_journey_becomes_reviewable_draft():
    row = {"Test Case Description": "Register a visitor", "Steps": "1. Click Register\n2. Enter username"}
    db = Mock()
    with patch("app.services.automation.agent_journey.changesets.draft", return_value=Mock(id=91)) as create:
        change_id, journey_id, unresolved = draft_from_case(
            db, app_id="bank_test", case_id=123, row=row, actor="qa", discovery=None,
        )
    changes = create.call_args.kwargs["changes"]
    assert change_id == 91
    assert journey_id.startswith("BANK.AGENT_PREPARED.")
    assert len(unresolved) == 2
    assert create.call_args.kwargs["kb"] == "journey"
    assert any(c["file"].startswith("journeys/") and c["op"] == "create" for c in changes)
    assert not any(c["file"] == "screens.json" for c in changes)  # no invented browser evidence
    assert len(changesets.dry_run("bank_test", "journey", changes)) == len(changes)


def test_retry_repairs_same_case_file_instead_of_creating_it_again(tmp_path):
    (tmp_path / "sources").mkdir()
    (tmp_path / "journeys").mkdir()
    (tmp_path / "sources" / "taxonomy_overlay.json").write_text(json.dumps({"added_nodes": [
        {"id": "APP.AGENT_PREPARED", "title": "Agent-prepared journeys", "parent": None},
        {"id": "APP.AGENT_PREPARED.RETRY_LOGIN", "title": "Retry login", "parent": "APP.AGENT_PREPARED", "kind": "journey"},
    ]}), encoding="utf-8")
    (tmp_path / "screens.json").write_text('{"screens": []}', encoding="utf-8")
    saved = {"journey_id": "APP.AGENT_PREPARED.RETRY_LOGIN", "name": "Retry login",
             "source": {"kind": "agent_prepared", "case_id": 55}, "steps": [{"step_number": 1, "action": "Wrong old action"}]}
    (tmp_path / "journeys" / "retry_login_55.json").write_text(json.dumps(saved), encoding="utf-8")
    kb = SimpleNamespace(directory=tmp_path, manifest={"id_prefix": "APP"}, taxonomy={"nodes": []},
                         screens={}, journeys={saved["journey_id"]: saved})
    with patch("app.services.automation.agent_journey.store.load", return_value=kb), \
         patch("app.services.automation.agent_journey.changesets.draft", return_value=Mock(id=92)) as create:
        change_id, journey_id, unresolved = draft_from_case(
            Mock(), app_id="app", case_id=55, row={"Test Case Description": "Retry login", "Steps": "Navigate to the login page"},
            actor="qa", discovery=None)
    changes = create.call_args.kwargs["changes"]
    assert change_id == 92 and journey_id == saved["journey_id"] and unresolved
    assert not any(change["op"] == "create" for change in changes)
    assert any(change["file"] == "journeys/retry_login_55.json" and change["path"] == "steps"
               and change["op"] == "set" for change in changes)
    assert sum(node["id"] == journey_id for node in changes[0]["value"]) == 1
