"""An agent may not publish a journey whose browser evidence is incomplete."""
from types import SimpleNamespace
from unittest.mock import Mock, patch
import pytest

from app.services.automation.agent_approval import _crawl_is_grounded, _pending_ids, _review_summary, decide_pending


@pytest.mark.parametrize('mutation',[None,'wrong_host','changed_control','changed_steps','failed_replay'])
def test_expanded_live_journey_requires_exact_replayed_evidence(mutation):
    from app.services.automation.agent_approval import _journey_is_grounded
    capture={'entry_url':'https://shop.test/','source_actions':['Open devices'], 'expected_result':''}
    bindings=[{'action':'Open entry','screen_id':'ENTRY','element_id':None},
              {'action':'Click menu','screen_id':'ENTRY','element_id':'MENU','source_step':1}]
    observed={'ENTRY':{'screen_id':'ENTRY','route':'/','elements':[{'element_id':'MENU','observed_locator':'observed'}]}}
    import copy
    journey={'journey_id':'J','steps':copy.deepcopy(bindings),'source':{'live_authoring':capture}}
    screens=copy.deepcopy(list(observed.values()))
    if mutation=='wrong_host': capture['entry_url']='https://other.test/'
    if mutation=='changed_control': screens[0]['elements'][0]['observed_locator']='invented'
    if mutation=='changed_steps': journey['steps'][1]['action']='Click purchase'
    change=SimpleNamespace(app_id='shop',origin={'ai_check_case_id':1},changes=[SimpleNamespace(
        file='journeys/j.json',op='create',path='$',after={'value':journey})])
    check=SimpleNamespace(case_id=1,source_row={'Steps':'1. Open devices'},steps={'_agent_setup':{'app_key':'shop','environment':'RC'}})
    with patch('app.services.automation.ai_checks.proposed_review_documents',return_value=(journey,screens)), \
         patch('app.services.automation.registry.address_for_crawl',return_value='https://shop.test/'), \
         patch('app.services.automation.live_authoring.journey_bindings',return_value=(bindings,observed)), \
         patch('app.services.automation.live_authoring.verify_saved_replay',side_effect=ValueError('Replay failed') if mutation=='failed_replay' else None):
        issues=_journey_is_grounded(Mock(),change,check)
    assert bool(issues)==bool(mutation),issues


def test_automation_expert_repair_is_in_approval_queue():
    check = SimpleNamespace(steps={"_agents": {
        "navigation_guide": {"status": "done"},
        "automation": {"status": "needs_approval", "change_set_ids": [42]},
    }})
    assert _pending_ids(check) == [42]


def test_manager_sees_one_file_with_explicit_mapping_delta():
    old = [{"step_number": 1, "action": "Navigate to login", "screen_id": "LOGIN", "element_id": "wrong_link"}]
    new = [{"step_number": 1, "action": "Navigate to login", "screen_id": "LOGIN", "element_id": None}]
    change = SimpleNamespace(id=41, source="agent-review", origin={}, changes=[
        SimpleNamespace(file="journeys/login.json", op="set", path="steps", note="Repair page navigation",
                        before={"present": True, "value": old}, after={"present": True, "value": new}),
        SimpleNamespace(file="journeys/login.json", op="set", path="screens", note="Keep observed screen",
                        before={"present": True, "value": ["LOGIN"]}, after={"present": True, "value": ["LOGIN"]}),
    ])
    summary = _review_summary(change)
    assert len(summary["files"]) == 1
    updates = summary["files"][0]["field_updates"]
    assert [item["path"] for item in updates] == ["steps", "screens"]
    assert updates[0]["changed_steps"][0]["before_control"] == "wrong_link"
    assert updates[0]["changed_steps"][0]["after_control"] is None


def test_unmapped_draft_is_held_not_published():
    journey = {"steps": [{"step_number": 1, "action": "Click Register", "screen_id": None, "element_id": None}]}
    change = SimpleNamespace(
        id=15, status="draft", source="agent-review", app_id="bank_test",
        origin={"ai_check_case_id": 21, "discovery_id": None},
        changes=[SimpleNamespace(file="journeys/register_21.json", op="create", path="$",
                                 after={"present": True, "value": journey})],
    )
    check = SimpleNamespace(
        id=7, case_id=21, batch_id="batch", requested_by="qa",
        source_row={"Steps": "1. Click Register"},
        steps={"_agent_setup": {"app_key": "bank_test", "profile_id": None},
               "_agents": {"navigation_guide": {"status": "needs_approval", "change_set_ids": [15]}}},
    )
    db = Mock()
    db.get.side_effect = lambda model, key: change if key == 15 else None
    with patch("app.routers.knowledge_base_page._approve") as publish:
        result = decide_pending(db, check, actor="qa")
    assert result["approved"] == []
    assert any("no observed screen" in reason for reason in result["held"])
    assert change.status == "draft"
    publish.assert_not_called()


def test_editor_binding_concern_blocks_delegated_crawl_publication():
    check = SimpleNamespace(steps={"_agents": {"expert_editor": {"concerns": True}}})
    assert "Expert Editor" in _crawl_is_grounded(Mock(), SimpleNamespace(), check)[0]


def test_held_data_entry_proposal_finishes_case_without_publishing():
    change = SimpleNamespace(id=34, status="draft", source="crawl", changes=[SimpleNamespace(op="set")])
    check = SimpleNamespace(id=7, case_id=21, batch_id="batch", requested_by="qa",
                            status="awaiting_approval", source_row={"Steps": "1. Open account"},
                            steps={"_agents": {"data_entry": {"status": "needs_approval", "change_set_ids": [34]}}})
    db = Mock()
    db.get.return_value = change
    with patch("app.services.automation.agent_approval._reuse_ready_data", return_value=None), \
         patch("app.services.automation.agent_approval.audit", return_value=["Browser screen does not match the saved case."]), \
         patch("app.services.automation.ai_checks.finish_with_held_kb_update", return_value=True) as finish, \
         patch("app.routers.knowledge_base_page._approve") as publish:
        result = decide_pending(db, check, actor="qa")
    assert result["approved"] == []
    assert result["held"]
    finish.assert_called_once_with(db, check, result["held"])
    publish.assert_not_called()
    assert change.status == "draft"
