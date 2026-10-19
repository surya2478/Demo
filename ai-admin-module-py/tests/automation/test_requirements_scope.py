from unittest.mock import patch

import pytest

from app.services.automation import agent_reviews


@pytest.mark.parametrize('actions', [
    ['Open catalogue', 'Apply an available filter', 'Clear the filter'],
    ['Open flight search', 'Choose departure date', 'Search available flights'],
])
def test_requirements_keeps_complete_intent_without_historical_execution(actions):
    evidence = {'case_title': 'Check available choices', 'actions': actions,
                'expected': 'Results update and restore', 'preconditions': 'Guest',
                'registered_entry_url': 'https://example.test',
                'entry_observation': {'controls': []},
                'knowledge_base_context': {'old_trace': ['unrelated'] * 20000}}
    with patch.object(agent_reviews, 'complete_json', return_value=agent_reviews.AgentDecision(
            verdict='pass', reason='Instructions describe the intended actions.')) as model:
        result = agent_reviews.review('requirements_guide', evidence)
    assert result.verdict == 'pass'
    assert model.call_count == 1
    payload = model.call_args.kwargs['user_input']
    assert 'old_trace' not in payload and 'entry_observation' not in payload
    assert all(action in payload for action in actions)
    assert 'BEFORE execution' in payload
    assert evidence['knowledge_base_context']  # caller state is untouched


def test_real_requirements_hold_is_not_silently_overridden():
    with patch.object(agent_reviews, 'complete_json', return_value=agent_reviews.AgentDecision(
            verdict='hold', reason='The title requests a search but no search instruction exists.')):
        result = agent_reviews.review('requirements_guide', {
            'case_title': 'Search flights', 'actions': ['Open home'], 'expected': 'Search results'})
    assert result.verdict == 'hold'


def test_execution_review_still_receives_observed_evidence():
    with patch.object(agent_reviews, 'complete_json', return_value=agent_reviews.AgentDecision(
            verdict='hold', reason='The expected result was not observed.')) as model:
        result = agent_reviews.review('automation', {'observations': ['Result not found']})
    assert 'Result not found' in model.call_args.kwargs['user_input']
    assert result.verdict == 'hold'
