from types import SimpleNamespace as NS
import pytest
from app.services.automation.agent_approval import _scoped_crawl_changes


@pytest.mark.parametrize('host', ['shop.example', 'portal.example'])
def test_publish_only_observed_proposal_despite_optional_inventory_gap(host):
    row = {'screen_id': 'SCREEN', 'element_id': 'login', 'outcome': 'new',
           'selector': '#login', 'url': f'https://{host}/login', 'tried': [{'count': 1}]}
    crawl = NS(base_url=f'https://{host}', plan={'items': [{'kind': 'goto'}]},
               result={'steps': [{'order': 1, 'status': 'done'}], 'rows': [row], 'summary': {'not_found': 4}})
    item = NS(file='app_profile.json', path='selectors.screen', op='set', before={},
              after={'value': {'login': '#login'}})
    change = NS(changes=[item])
    assert not _scoped_crawl_changes(change, crawl)
    row['url'] = 'https://unrelated.example/login'
    assert _scoped_crawl_changes(change, crawl)
    row['url'] = f'https://{host}/login'
    row['ambiguous'] = True
    assert _scoped_crawl_changes(change, crawl)
    row['ambiguous'] = False
    row['screen_id'] = 'OTHER'
    assert _scoped_crawl_changes(change, crawl)
