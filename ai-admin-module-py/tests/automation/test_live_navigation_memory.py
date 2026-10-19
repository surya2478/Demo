from types import SimpleNamespace
from unittest.mock import patch
from datetime import datetime, timedelta
from app.services.automation import agent_evidence as evidence


def test_route_memory_is_scoped_expiring_and_not_approved(tmp_path):
    kb = SimpleNamespace(directory=tmp_path,journeys={})
    trace = [{'from_url':'https://shop.test/','to_url':'https://shop.test/devices','role':'link','label':'Devices','outcome':'observed'},
             {'from_url':'https://shop.test/','to_url':'https://other.test/private','role':'link','label':'Other','outcome':'observed'}]
    with patch.object(evidence.store,'load',return_value=kb):
        evidence.record_navigation('shop',application_id=8,environment='QA',address='https://shop.test/',trace=trace)
        params = dict(application_id=8,environment='QA',address='https://shop.test/')
        assert evidence.navigation_routes('shop',**params) == ['https://shop.test/devices']
        for changed in ({'application_id':9},{'environment':'RC'},{'address':'https://shop.test/other'}):
            assert evidence.navigation_routes('shop',**{**params,**changed}) == []
        context = evidence.context('shop',application_id=8,environment='QA')
        assert context['approved_journeys'] == []
        assert len(context['observed_navigation'][0]['trace']) == 1
        path = tmp_path/'sources'/'agent_observations.json'
        doc = evidence._read(path)
        doc['navigation_captures'][0]['captured_at'] = (datetime.utcnow()-timedelta(days=2)).isoformat()
        evidence._write(path,doc)
        assert evidence.navigation_routes('shop',**params) == []


def test_phrase_intent_is_not_lost_in_reuse_key():
    assert evidence._terms(['smart living','Travel Insurance']) == ['smart living','travel insurance']
