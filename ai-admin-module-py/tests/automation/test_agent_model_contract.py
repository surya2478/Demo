"""Agent model responses must be real, complete, and fail closed."""
from types import SimpleNamespace
from unittest.mock import patch

from app.services.automation import agent_reviews, expert_editor, llm


def test_openrouter_retries_only_mandatory_reasoning_400():
    failed = SimpleNamespace(status_code=400, text='{"error":{"message":"Reasoning is mandatory for this endpoint and cannot be disabled."}}')
    good = SimpleNamespace(status_code=200, text="", json=lambda: {"choices": [{"message": {"content": '{"verdict":"pass","reason":"Actions are atomic."}'}, "finish_reason": "stop"}]})
    with patch.object(type(llm.settings), "openrouter_missing_keys", return_value=[]), \
         patch.object(llm.requests, "post", side_effect=[failed, good]) as request:
        answer = llm._call_openrouter(system_prompt="Check actions", user_input="data",
                                      timeout=10, max_tokens=500, temperature=0)
    assert '"pass"' in answer
    assert request.call_count == 2
    first, second = [call.kwargs["json"] for call in request.call_args_list]
    assert first["reasoning"] == {"enabled": False}
    assert second["reasoning"] == {"enabled": True}
    assert second["max_tokens"] >= 3200


def test_expert_editor_rejects_partial_model_review():
    controls = [{"candidate_id": 0, "page_url": "https://shop.example.test/login", "role": "button",
                 "accessible_name": "Sign In", "confidence_score": 90}]
    answer = expert_editor.EditorAnswer(choices=[])
    with patch.object(expert_editor, "complete_json", return_value=answer):
        try:
            expert_editor.review(["Click Sign In"], controls, "https://shop.example.test/login")
        except expert_editor.ExpertEditorReviewError:
            pass
        else:
            assert False, "A partial model response must not be a successful review"


def test_expert_editor_repairs_incomplete_answer_without_new_browser_capture():
    controls = [{"candidate_id": 0, "page_url": "https://shop.example.test/login", "role": "button",
                 "accessible_name": "Sign In", "confidence_score": 90}]
    partial = expert_editor.EditorAnswer(choices=[])
    complete = expert_editor.EditorAnswer(choices=[expert_editor.EditorChoice(
        step_number=1, candidate_id=0, equivalent=True, reason="Observed Sign In button on the login page.")])
    with patch.object(expert_editor, "complete_json", side_effect=[partial, complete]) as model:
        report = expert_editor.review(["Click Sign In"], controls, "https://shop.example.test/login")
    assert model.call_count == 2
    assert report.choices[1].candidate_id == 0
    assert '"missing_steps": [1]' in model.call_args.kwargs["user_input"]


def test_expert_editor_correction_still_rejects_wrong_host_candidate():
    controls = [{"candidate_id": 4, "page_url": "https://other.example.test/login", "role": "button",
                 "accessible_name": "Sign In", "confidence_score": 90}]
    partial = expert_editor.EditorAnswer(choices=[])
    invalid = expert_editor.EditorAnswer(choices=[expert_editor.EditorChoice(
        step_number=1, candidate_id=4, equivalent=True, reason="Wrong-host control.")])
    with patch.object(expert_editor, "complete_json", side_effect=[partial, invalid]):
        report = expert_editor.review(["Click Sign In"], controls, "https://shop.example.test/login")
    assert report.choices == {}


def test_editor_keeps_page_label_and_limits_candidates_to_current_screen():
    controls = [
        {"candidate_id": 0, "page_url": "https://bank.example.test/index.htm", "role": "link",
         "accessible_name": "Forgot login info?", "confidence_score": 90},
        {"candidate_id": 1, "page_url": "https://bank.example.test/admin.htm", "role": "link",
         "accessible_name": "Forgot login info?", "confidence_score": 90},
    ]
    answer = expert_editor.EditorAnswer(choices=[expert_editor.EditorChoice(
        step_number=1, candidate_id=0, equivalent=True, reason="The observed home-page link opens recovery.")])
    with patch.object(expert_editor, "complete_json", return_value=answer) as model:
        result = expert_editor.review(['Open the "Forgot login info" page'], controls,
                                      "https://bank.example.test/index.htm", [None])
    prompt = model.call_args.kwargs["user_input"]
    assert "Forgot login info" in prompt and "<typed value>" not in prompt
    assert '"candidate_id": 1' not in prompt
    assert result.choices[1].candidate_id == 0


def test_generic_submit_can_consider_observed_buttons_on_active_page():
    controls = [
        {"candidate_id": 0, "page_url": "https://bank.example.test/lookup.htm", "role": "button",
         "accessible_name": "Find My Login Info", "confidence_score": 90},
        {"candidate_id": 1, "page_url": "https://bank.example.test/index.htm", "role": "button",
         "accessible_name": "Log In", "confidence_score": 90},
    ]
    answer = expert_editor.EditorAnswer(choices=[expert_editor.EditorChoice(
        step_number=1, candidate_id=0, equivalent=True, reason="This is the lookup form's submit button.")])
    with patch.object(expert_editor, "complete_json", return_value=answer) as model:
        report = expert_editor.review(["Submit the form"], controls,
                                      "https://bank.example.test/index.htm", ["/lookup.htm"])
    prompt = model.call_args.kwargs["user_input"]
    assert "Find My Login Info" in prompt and '"candidate_id": 1' not in prompt
    assert report.choices[1].candidate_id == 0


def test_agent_review_errors_are_not_silent():
    with patch.object(agent_reviews, "complete_json", side_effect=llm.LLMInvalidResponse("bad JSON")) as model, patch.object(agent_reviews.time, "sleep"):
        try:
            agent_reviews.review("requirements_guide", {"actions": ["Click Login"]})
        except agent_reviews.AgentReviewError as exc:
            assert "after 3 attempt(s)" in str(exc)
            assert "No decision was made" in str(exc)
            assert model.call_count == 3
        else:
            assert False, "An unusable model answer must be visible"


def test_agent_retry_wait_and_queue_are_visible_for_temporary_failure():
    progress = []
    answer = agent_reviews.AgentDecision(verdict="pass", reason="Observed controls match the journey.")
    with patch.object(agent_reviews, "complete_json", side_effect=[llm.LLMUnavailable("OpenRouter returned 429"), answer]) as model, patch.object(agent_reviews.time, "sleep") as sleep:
        result = agent_reviews.review("navigation_guide", {"steps": []},
                                      on_progress=lambda *event: progress.append(event))
    assert result.verdict == "pass"
    assert model.call_count == 2
    assert sleep.call_count == 1
    assert [event[0] for event in progress] == ["queued", "working", "retry_wait", "queued", "working"]


def test_evidence_hold_is_a_decision_not_a_transient_retry():
    answer = agent_reviews.AgentDecision(verdict="hold", reason="The final outcome has no observed evidence.")
    with patch.object(agent_reviews, "complete_json", return_value=answer) as model:
        result = agent_reviews.review("requirements_guide", {"actions": []})
    assert result.verdict == "hold"
    assert model.call_count == 1


def test_configuration_error_does_not_keep_retrying():
    with patch.object(agent_reviews, "complete_json", side_effect=llm.LLMUnavailable("OpenRouter returned 401")) as model:
        try:
            agent_reviews.review("automation", {})
        except agent_reviews.AgentReviewError as exc:
            assert "after 1 attempt(s)" in str(exc)
        else:
            assert False
        assert model.call_count == 1


def test_waiting_agent_can_be_stopped_before_model_call():
    with patch.object(agent_reviews, "complete_json") as model:
        try:
            agent_reviews.review("navigation_guide", {}, should_stop=lambda: True)
        except agent_reviews.AgentReviewError as exc:
            assert "stopped while waiting" in str(exc)
        else:
            assert False
        model.assert_not_called()
