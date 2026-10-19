"""Real-browser coverage for the portable shared consent/click implementation."""
import os
import subprocess
from pathlib import Path

import pytest
from app.services.automation.compiler import NAVIGATION_HELPER
from app.services.automation.preflight import resolve_node_tool


def test_literal_assertions_require_observed_host_screen_and_values():
    from app.services.automation.compiler import _observed_literal_assertion, sanitize_catalog_locator
    observation = {'url':'https://shop.test/item', 'title':'Phone details',
                   'visible_text':['IN STOCK', 'Price 100'], 'controls':[]}
    assert 'toHaveTitle' in _observed_literal_assertion("Assert title 'Phone details'", 'page title', observation, observation['url'])
    assert 'toContain' in _observed_literal_assertion("Assert text 'IN STOCK'", 'visible text', observation, observation['url'])
    assert _observed_literal_assertion("Assert text 'IN STOCK'", 'visible text', observation, 'https://other.test/item') is None
    assert _observed_literal_assertion("Assert text 'IN STOCK'", 'visible text', observation, 'https://shop.test/cart') is None
    assert _observed_literal_assertion("Assert text 'invented'", 'visible text', observation, observation['url']) is None
    assert '.first()' not in sanitize_catalog_locator('a[href="/item"]')
    observation['visible_text'].append('CONTINUE')
    observation['controls'].append('CONTINUE')
    control = _observed_literal_assertion("Assert 'CONTINUE' is enabled", "button 'CONTINUE'", observation, observation['url'])
    assert 'getByText' in control and 'toBeEnabled' in control and 'getByRole' not in control


@pytest.mark.skipif(os.getenv('RUN_BROWSER_RECOVERY_TESTS') != '1', reason='real browser opt-in')
def test_portable_interactions_two_apps_and_ambiguous_negative(tmp_path):
    from app.services.automation.compiler import _observed_literal_assertion
    control_check = _observed_literal_assertion("Assert 'ADD TO CART' is enabled", "button 'ADD TO CART'",
        {'url':'about:blank', 'visible_text':['ADD TO CART'], 'controls':['ADD TO CART']}, 'about:blank')
    code = "const {chromium,expect}=require('@playwright/test');\n" + NAVIGATION_HELPER + r'''
    (async()=>{
      const browser=await chromium.launch({headless:true});
      const page=await browser.newPage();
      try {
        for(const name of ['Phone catalogue','Flight search']) {
          await page.setContent(`<h1>${name}</h1><button onclick="this.textContent='Opened'">Open details</button>
            <aside style="position:fixed;inset:0;background:white"><p>Cookie privacy choices</p>
            <button onclick="this.parentElement.remove()">Reject all</button></aside>`);
          await observedInteractions.clickObserved(page,page.getByRole('button',{name:'Open details',exact:true}),page.url());
          if(await page.getByRole('button',{name:'Opened',exact:true}).count()!==1) throw Error(name+' failed');
          await page.setContent('<button><span style="text-transform:uppercase"> Add to cart </span></button>');
          __CONTROL_CHECK__
        }
        await page.setContent(`<button>Open details</button><aside style="position:fixed;inset:0;background:white">
          <p>Cookie privacy choices</p><button>Reject all</button><button>Reject all</button></aside>`);
        let failed=false;
        try {await observedInteractions.clickObserved(page,page.getByRole('button',{name:'Open details',exact:true}),page.url());}
        catch {failed=true;}
        if(!failed || await page.getByRole('button',{name:'Reject all',exact:true}).count()!==2) throw Error('Ambiguous choice was swallowed');
      } finally {await browser.close();}
    })().catch(e=>{console.error(e);process.exitCode=1;});
    '''.replace('__CONTROL_CHECK__', control_check)
    target = tmp_path/'interactions.cjs'
    target.write_text(code, encoding='utf-8')
    env = dict(os.environ)
    if env.get('AUTOMATION_PLAYWRIGHT_PROJECT'):
        env['NODE_PATH'] = str(Path(env['AUTOMATION_PLAYWRIGHT_PROJECT'])/'node_modules')
    result = subprocess.run([resolve_node_tool('node'),str(target)], env=env,
                            capture_output=True,text=True,timeout=45)
    assert result.returncode == 0, result.stdout+result.stderr
