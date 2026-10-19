import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from app.services.automation.live_authoring import author, Decision, script, journey_bindings
from app.services.automation.preflight import resolve_node_tool


def test_unused_null_evidence_does_not_block_a_browser_action():
    choice = Decision.model_validate({'action':'click', 'candidate_id':7,
        'reason':'Use observed control', 'evidence':None, 'checks':None})
    assert choice.candidate_id == 7 and choice.evidence == '' and choice.checks == []


def test_null_completion_does_not_invent_browser_evidence():
    choice = Decision.model_validate({'action':'complete_step', 'reason':'No proof',
        'evidence':None, 'checks':None})
    assert choice.evidence == '' and choice.evidence_id is None and choice.checks == []
    observed = Decision.model_validate({'action':'complete_step', 'reason':'Use snapshot ID',
        'evidence':None, 'checks':[{'kind':'text','value':None,'evidence_id':2}]})
    assert observed.evidence_id == 2 and observed.checks[0].value == ''


def test_decision_compaction_preserves_all_observed_choices_and_lineage():
    from app.services.automation.live_authoring import decision_evidence
    state={'url':'https://shop.test/devices','title':'Devices','evidence':['In stock'],
           'snapshot':8,'controls':[{'id':7,'role':'link','label':'Phone',
             'href':'https://shop.test/phone','page_url':'https://shop.test/devices',
             'descriptor':{'by':'role','role':'link','name':'Phone'}}]}
    history=[{'source_step':2,'operation':'click','label':'Devices',
              'to_url':state['url'],'descriptor':{},'reason':'Long rationale'}]
    browser,performed=decision_evidence(state,history)
    assert browser['controls']==[{'candidate_id':7,'role':'link','label':'Phone','destination':'/phone'}]
    assert browser['evidence']==[{'id':0,'text':'In stock'}] and browser['url']==state['url']
    assert performed[0]['source_step']==2 and performed[0]['to_url']==state['url']
    assert 'descriptor' not in browser['controls'][0] and 'reason' not in performed[0]
    assert state['controls'][0]['descriptor']['name']=='Phone'


@pytest.mark.parametrize('always_invalid', [False, True])
def test_invalid_model_control_reobserves_without_executing_unobserved_action(monkeypatch, always_invalid):
    from app.services.automation import live_authoring
    calls, goals = [], []
    class Browser:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def call(self, **args):
            calls.append(args)
            return {'url':'https://shop.test/', 'title':'Shop', 'snapshot':len(calls),
                    'evidence':['Filtered results'], 'controls':[]}
    def planner(goal, *args):
        goals.append(goal)
        if always_invalid or len(goals) == 1:
            return Decision(action='click', candidate_id=99, reason='Invalid proposed control')
        return Decision(action='complete_step', evidence_id=0, reason='Current result observed')
    monkeypatch.setattr(live_authoring, 'BrowserSession', Browser)
    result = author('https://shop.test/', ['Observe filtered results'], planner=planner)
    assert not any(c['command'] == 'click' for c in calls)
    assert 'NO action was executed' in goals[1]
    assert sum(c['command'] == 'observe' for c in calls) == (2 if always_invalid else 1)
    assert result['status'] == ('incomplete' if always_invalid else 'authored')


@pytest.mark.parametrize('evidence_id,expected',[(0,'authored'),(9,'incomplete'),(-1,'incomplete')])
def test_evidence_ids_are_bound_to_current_snapshot(monkeypatch,evidence_id,expected):
    from app.services.automation import live_authoring
    calls=[]
    class Browser:
        def __enter__(self): return self
        def __exit__(self,*args): pass
        def call(self,**args):
            calls.append(args)
            return {'url':'https://shop.test/','title':'Shop','snapshot':1,
                    'evidence':['AED 7,099.00 4,862.00'],'controls':[]}
    monkeypatch.setattr(live_authoring,'BrowserSession',Browser)
    result=author('https://shop.test/',['Check price'],planner=lambda *args:Decision(
        action='complete_step',evidence_id=evidence_id,reason='Observed price'))
    assert result['status']==expected
    assertions=[call for call in calls if call['command']=='assert']
    if expected=='authored':
        assert assertions[0]['value']=='AED 7,099.00 4,862.00'
    else:
        assert not assertions and 'Evidence ID' in result['issue']


@pytest.fixture
def form_site():
    submissions=[]
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def respond(self,body):
            self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers()
            self.wfile.write(body.encode())
        def do_GET(self):
            self.respond('<title>Test portal</title><form method="post"><label>Username<input name="username"></label>'
                '<label>Password<input type="password" name="password"></label><button type="submit">Sign in</button></form>')
        def do_POST(self):
            submissions.append(self.rfile.read(int(self.headers['Content-Length'])).decode())
            self.respond('<title>Account</title><h1 style="text-transform:uppercase">Signed in successfully</h1><h1 hidden>Signed in successfully</h1>')
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    yield f'http://127.0.0.1:{server.server_port}/',submissions
    server.shutdown(); server.server_close()


def form_planner(goal,state,history,fields):
    assert 'fixture-password' not in json.dumps((state,history,fields))
    if state['title']=='Account':
        return Decision(action='complete_step',evidence_kind='text',evidence='SIGNED IN SUCCESSFULLY',reason='Observed success',
                        checks=[{'kind':'title','value':'Account'},{'kind':'text','value':'SIGNED IN SUCCESSFULLY'}])
    filled=[t['data_ref'] for t in history if t['operation']=='fill']
    for label,ref in [('Username','TESTDATA_USERNAME'),('Password','TESTDATA_PASSWORD')]:
        if ref not in filled:
            c=next(c for c in state['controls'] if c['label']==label)
            return Decision(action='fill',candidate_id=c['id'],data_ref=ref,reason='Use selected fixture identity')
    c=next(c for c in state['controls'] if c['label']=='Sign in')
    return Decision(action='click',candidate_id=c['id'],reason='Submit observed form')


@pytest.mark.skipif(os.getenv('RUN_BROWSER_RECOVERY_TESTS')!='1',reason='real browser opt-in')
def test_credentials_form_authoring_journey_and_generated_script_replay(form_site,tmp_path,monkeypatch):
    url,submissions=form_site
    fields={'TESTDATA_USERNAME':{'label':'Username','value':'fixture-user'},
            'TESTDATA_PASSWORD':{'label':'Password','value':'fixture-password'}}
    result=author(url,['Sign in with assigned account'],fields=fields,planner=form_planner,expected_result='Signed-in account confirmation is visible')
    assert result['status']=='authored',result['issue']
    assert len(submissions)==1
    assert 'fixture-password' not in json.dumps(result)
    steps,screens=journey_bindings(result)
    assert len(steps)==4 and all(step['screen_id'] in screens for step in steps)
    generated=script(result)
    assert 'fixture-password' not in generated and 'TESTDATA_PASSWORD' in generated
    (tmp_path/'journey.spec.cjs').write_text(generated,encoding='utf-8')
    (tmp_path/'playwright.config.cjs').write_text("module.exports={testDir:'.',workers:1,use:{headless:true}}",encoding='utf-8')
    env=dict(os.environ)
    if env.get('AUTOMATION_PLAYWRIGHT_PROJECT'):
        env['NODE_PATH']=str(Path(env['AUTOMATION_PLAYWRIGHT_PROJECT'])/'node_modules')
    env.update({ref:item['value'] for ref,item in fields.items()})
    node=resolve_node_tool('node')
    package=subprocess.check_output([node,'-p',"require.resolve('@playwright/test/package.json')"],env=env,text=True).strip()
    run=subprocess.run([node,str(Path(package).with_name('cli.js')),'test','--config',str(tmp_path/'playwright.config.cjs')],
        cwd=tmp_path,env=env,capture_output=True,text=True,timeout=60)
    assert run.returncode==0,run.stdout+run.stderr
    assert len(submissions)==2
    from app.services.automation.live_authoring import replay
    from app.services.automation import workspace
    monkeypatch.setattr(workspace,'storage_root',lambda:tmp_path)
    bundle=replay(result,values={ref:item['value'] for ref,item in fields.items()})
    assert bundle['status']=='passed',bundle
    from app.services.automation.live_authoring import verify_saved_replay
    verified={**result,'script_verification':bundle}
    verify_saved_replay(verified)
    from app.services.automation.live_authoring import verify_expanded_journey
    expected=result['expected_result']
    expanded,screens=journey_bindings(verified,expected)
    journey={'steps':expanded,'source':{'live_authoring':verified}}
    assert verify_expanded_journey(journey,screens,result['source_actions'],expected,url)
    with pytest.raises(ValueError,match='different'):
        verify_expanded_journey(journey,screens,result['source_actions'],expected,'https://wrong.test/')
    import copy
    changed=copy.deepcopy(journey); changed['steps'][-1]['action']='Invented action'
    with pytest.raises(ValueError,match='Published steps'):
        verify_expanded_journey(changed,screens,result['source_actions'],expected,url)
    with pytest.raises(ValueError,match='differs'):
        verify_saved_replay({**verified,'expected_result':'Changed after execution'})
    with pytest.raises(ValueError,match='outside'):
        verify_saved_replay({**verified,'script_verification':{**bundle,'script_path':str(tmp_path/'outside.cjs')}})
    assert Path(bundle['journey_path']).exists() and Path(bundle['report_path']).exists()
    assert 'fixture-password' not in Path(bundle['journey_path']).read_text()
    assert len(submissions)==3


@pytest.mark.skipif(os.getenv('RUN_BROWSER_RECOVERY_TESTS')!='1',reason='real browser opt-in')
def test_wrong_field_binding_cannot_send_credentials(form_site):
    url,submissions=form_site
    result=author(url,['Sign in'],fields={'TESTDATA_PASSWORD':{'label':'Another field','value':'fixture-password'}},
        planner=lambda goal,state,*_:Decision(action='fill',candidate_id=next(c['id'] for c in state['controls'] if c['label']=='Password'),
            data_ref='TESTDATA_PASSWORD',reason='Wrong field'))
    assert result['status']=='incomplete' and 'does not match' in result['issue']
    assert submissions==[]


def test_incomplete_journey_cannot_be_compiled():
    with pytest.raises(ValueError,match='incomplete'):
        script({'status':'incomplete'})


def test_unused_nulls_do_not_require_another_model_call():
    assert Decision(action='click',candidate_id=1,direction=None,evidence_kind=None,reason='Observed').action=='click'
    with pytest.raises(ValueError):
        Decision(action='scroll',direction=None,reason='Missing direction')
    with pytest.raises(ValueError):
        Decision(action='complete_step',evidence_kind=None,reason='Missing evidence kind')
    checked=Decision(action='complete_step',evidence_kind=None,evidence=None,
                     checks=[{'kind':'text','evidence_id':4}],reason='Observed evidence check')
    assert checked.evidence_kind=='text' and checked.evidence_id==4


def test_only_short_explicit_throttles_are_retried():
    from types import SimpleNamespace
    from app.services.automation.llm import _short_rate_limit_delay
    response=SimpleNamespace(status_code=429,text='tokens per minute',headers={'Retry-After':'12.5'})
    assert _short_rate_limit_delay(response)==12.5
    response.text='free-models-per-day'
    assert _short_rate_limit_delay(response) is None
    response.text='tokens per minute'; response.headers={'Retry-After':'3600'}
    assert _short_rate_limit_delay(response) is None
    response.headers={}
    assert _short_rate_limit_delay(response) is None
    response.status_code=413; response.headers={'Retry-After':'1'}
    assert _short_rate_limit_delay(response) is None


@pytest.mark.skipif(os.getenv('RUN_BROWSER_RECOVERY_TESTS')!='1',reason='real browser opt-in')
@pytest.mark.parametrize('noun',['Phone','Flight'])
def test_unique_observed_destination_authoring_and_replay(noun,tmp_path,monkeypatch):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def do_GET(self):
            self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers()
            body=(f'<title>{noun} catalogue</title><article><h2>{noun} available</h2><a href="/detail"><img src="data:," width="30" height="30"></a></article>'
                '<a href="/other">View</a><a href="/third">View</a>'
                '<a href="/ambiguous">Same</a><a href="/ambiguous">Same</a>'
                '<a href="https://wrong.invalid/detail">Outside</a>') if self.path=='/' else f'<h1>{noun} details</h1>'
            self.wfile.write(body.encode())
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    def planner(goal,state,*_):
        if state['url'].endswith('/detail'):
            return Decision(action='complete_step',evidence_kind='text',evidence=f'{noun} details',reason='Observed details')
        assert not any(c['label'] in ('Same','Outside') for c in state['controls'])
        assert len([c for c in state['controls'] if c['label']=='View'])==2
        control=next(c for c in state['controls'] if c.get('href','').endswith('/detail'))
        assert control['descriptor']=={'by':'href','href':'/detail'}
        return Decision(action='click',candidate_id=control['id'],reason='Unique observed image link')
    try:
        result=author(f'http://127.0.0.1:{server.server_port}/',[f'Open {noun}'],planner=planner)
        assert result['status']=='authored',result['issue']
        resumed=author(f'http://127.0.0.1:{server.server_port}/',[f'Open {noun}'],planner=planner,resume=result)
        assert resumed['status']=='authored',resumed['issue']
        unverified=author(f'http://127.0.0.1:{server.server_port}/',[f'Open {noun}'],planner=planner,resume=result,expected_result='Details')
        assert unverified['status']=='incomplete' and 'explicit browser assertions' in unverified['issue']
        wrong={**result,'entry_url':'https://wrong.invalid/'}
        rejected=author(f'http://127.0.0.1:{server.server_port}/',[f'Open {noun}'],planner=planner,resume=wrong)
        assert rejected['status']=='incomplete' and 'exact entry' in rejected['issue']
        from app.services.automation import workspace
        from app.services.automation.live_authoring import replay
        monkeypatch.setattr(workspace,'storage_root',lambda:tmp_path)
        assert replay(result)['status']=='passed'
        bindings, screens = journey_bindings(result)
        plan = {'items': [{'step_number': b['step_number'], 'screen_id': b['screen_id'],
                          'element': {'element_id': b['element_id']} if b['element_id'] else None}
                         for b in bindings]}
        code = script(result, crawl_plan=plan)
        spec = tmp_path/'crawl.spec.cjs'
        spec.write_text(code, encoding='utf-8')
        config = tmp_path/'crawl.config.cjs'
        config.write_text("module.exports={testDir:'.',testMatch:'crawl.spec.cjs',workers:1,use:{headless:true}}", encoding='utf-8')
        env = dict(os.environ)
        if env.get('AUTOMATION_PLAYWRIGHT_PROJECT'):
            env['NODE_PATH'] = str(Path(env['AUTOMATION_PLAYWRIGHT_PROJECT'])/'node_modules')
        node = resolve_node_tool('node')
        package = subprocess.check_output([node,'-p',"require.resolve('@playwright/test/package.json')"],env=env,text=True).strip()
        run = subprocess.run([node,str(Path(package).with_name('cli.js')),'test','--config',str(config)],
                             cwd=tmp_path,env=env,capture_output=True,text=True,timeout=60)
        assert run.returncode == 0, run.stdout+run.stderr
        output = json.loads((tmp_path/'journey_crawl.json').read_text())
        assert len(output['steps']) == len(bindings) and all(s['status']=='done' for s in output['steps'])
        assert output['outcome_observation']['assertions'][0]['value'] == f'{noun} details'
        wrong_plan = {'items': [{**plan['items'][0], 'screen_id': 'WRONG'}, *plan['items'][1:]]}
        with pytest.raises(ValueError, match='Crawl plan differs'):
            script(result, crawl_plan=wrong_plan)
    finally:
        server.shutdown(); server.server_close()


def test_wrong_origin_trace_cannot_be_compiled():
    with pytest.raises(ValueError,match='origin'):
        script({'status':'authored','entry_url':'https://a.test/','source_actions':['Open'],
            'completed_steps':[1],'trace':[{'source_step':1,'from_url':'https://a.test/','to_url':'https://b.test/'}]})


@pytest.mark.skipif(os.getenv('RUN_BROWSER_RECOVERY_TESTS')!='1',reason='real browser opt-in')
def test_page_data_post_loads_but_link_disguised_submission_is_blocked():
    from app.services.automation.live_navigation import BrowserSession
    posts=[]
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def do_GET(self):
            self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers()
            self.wfile.write(b'''<script>fetch('/catalogue',{method:'POST'}).then(r=>r.text()).then(t=>document.body.insertAdjacentHTML('beforeend',t))</script><body></body>''')
        def do_POST(self):
            posts.append(self.path)
            self.send_response(200); self.end_headers()
            self.wfile.write(b'''<h1>Catalogue loaded</h1><a href="#" onclick="fetch('/commit',{method:'POST'}).catch(()=>{})">Open details</a>''')
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        with BrowserSession() as browser:
            state=browser.call(command='start',url=f'http://127.0.0.1:{server.server_port}/',authoring=True)
            assert 'Catalogue loaded' in state['evidence']
            c=next(c for c in state['controls'] if c['label']=='Open details')
            browser.call(command='click',snapshot=state['snapshot'],candidate_id=c['id'])
            assert posts==['/catalogue']
    finally:
        server.shutdown(); server.server_close()
