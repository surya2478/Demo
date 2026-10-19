from unittest.mock import Mock, patch

from app.services.automation import agent_journey, live_authoring
from app.routers import automation


def test_fresh_crawl_follows_observed_routes_before_cataloguing():
    db = Mock()
    captured = {'pages': [{'url': 'https://shop.test/products', 'status': 200}],
                'trace': [], 'issue': None}
    on_capture = Mock()
    with patch.object(live_authoring, 'author', return_value=captured) as browser, \
         patch.object(automation, 'start_discovery', side_effect=ValueError('fixture stop')) as scan:
        run, issue = agent_journey.discover(db, application_id=7, address='https://shop.test/',
            environment='RC', actor='test', force=True, headed=True,
            goal_actions=['Open products'], on_navigation=on_capture)
    browser.assert_called_once()
    assert browser.call_args.kwargs['headed'] is True
    on_capture.assert_called_once_with(captured)
    assert scan.call_args.args[0].additional_urls == ['https://shop.test/products']
    assert run is None and issue == 'fixture stop'


def test_live_route_on_wrong_host_cannot_enter_crawl():
    with patch.object(live_authoring, 'author', return_value={
            'pages': [{'url': 'https://wrong.test/secret', 'status': 200}] }), \
         patch.object(automation, 'start_discovery') as scan:
        run, issue = agent_journey.discover(Mock(), application_id=7, address='https://shop.test/',
            environment='RC', actor='test', force=True, goal_actions=['Open products'])
    scan.assert_not_called()
    assert run is None and issue


def test_authenticated_crawl_keeps_existing_login_executor():
    db = Mock()
    with patch.object(live_authoring, 'author') as browser, \
         patch.object(automation, 'start_discovery', side_effect=ValueError('fixture stop')):
        agent_journey.discover(db, application_id=7, address='https://shop.test/',
            environment='RC', actor='test', force=True, login_journey_id='approved-login',
            goal_actions=['Open account'])
    browser.assert_not_called()
