/* Cross-browser background controller. Uses only the WebExtension API subset
   shared by Firefox and Chromium browsers; no chrome.debugger dependency. */
const api = globalThis.chrome || globalThis.browser;
const STATE = 'automationStudioCollector';
const DANGEROUS = /(?:^|[\/_?&=.-])(logout|logoff|signout|delete|remove|cancel|deactivate|revoke|confirm|submit|checkout|purchase|payment|pay)(?:$|[\/_?&=.-])/i;
const SENSITIVE = /token|code|session|auth|key|pass|pwd|secret|sig|otp|pairing|value/i;
const MAX_LOGS = 300;

function storageGet(key) { return new Promise(resolve => api.storage.local.get(key, value => resolve(value[key]))); }
function storageSet(value) { return new Promise(resolve => api.storage.local.set({[STATE]:value}, resolve)); }
async function persistRunning(state) {
  const current=await storageGet(STATE);
  if(!current?.active||current.terminal||Number(current.id)!==Number(state.id))return false;
  await storageSet({...state,active:true,terminal:false});return true;
}
// Owl requires extension-created tabs to be active. A WebExtension cannot run
// a truly headless browser, so use one visible crawl tab and close it on finish.
function browserCall(call, missingMessage) {
  return new Promise((resolve,reject) => {
    let settled=false;
    const done=value=>{
      if(settled)return;
      const error=api.runtime.lastError;
      if(error){settled=true;reject(new Error(error.message));return;}
      if(value==null&&missingMessage){settled=true;reject(new Error(missingMessage));return;}
      settled=true;resolve(value);
    };
    try {
      const pending=call(done);
      pending?.then?.(done,error=>{if(!settled){settled=true;reject(error);}});
    } catch (error) { settled=true;reject(error); }
  });
}
function tabCreate(url) {
  return browserCall(done=>api.tabs.create({url,active:true},done),'The browser did not create the crawl tab.');
}
function tabUpdate(id,url) {
  return browserCall(done=>api.tabs.update(id,{url,active:true},done),'The previous crawl tab is no longer available.');
}
function tabRemove(id) { return new Promise(resolve => id ? api.tabs.remove(id,()=>{ void api.runtime.lastError; resolve(); }) : resolve()); }
function tabGet(id) { return browserCall(done=>api.tabs.get(id,done),'The crawl tab is no longer available.'); }
function captureVisible(windowId) { return browserCall(done=>api.tabs.captureVisibleTab(windowId,{format:'png'},done),'The browser did not capture the crawl tab.'); }
async function closeOwnedTabs(state) {
  const ids=[...new Set([...(state?.createdTabIds||[]),state?.tabId].filter(id=>Number.isInteger(id)))];
  for(const id of ids){await tabRemove(id);await new Promise(resolve=>setTimeout(resolve,120));await tabRemove(id);}
}
function inject(id) { return new Promise((resolve,reject) => api.scripting.executeScript({target:{tabId:id},files:['collector.js']},()=>api.runtime.lastError?reject(new Error(api.runtime.lastError.message)):resolve())); }
function send(id,message) { return new Promise((resolve,reject) => api.tabs.sendMessage(id,message,response=>api.runtime.lastError?reject(new Error(api.runtime.lastError.message)):resolve(response))); }
async function captureSanitised(tabId) {
  let masked=false;
  try {
    await send(tabId,{type:'mask-screenshot'});masked=true;
    const tab=await tabGet(tabId);
    await browserCall(done=>api.tabs.update(tabId,{active:true},done),'The crawl tab could not be activated.');
    await new Promise(resolve=>setTimeout(resolve,80));
    return await captureVisible(tab.windowId);
  } catch (_) { return null; }
  finally { if(masked)try{await send(tabId,{type:'restore-screenshot'});}catch(_){} }
}
function unregisterBridge() { return new Promise(resolve => api.scripting.unregisterContentScripts({ids:['automation-studio-bridge']},()=>{ void api.runtime.lastError; resolve(); })); }
function registerBridgeScript(origin) { return new Promise((resolve,reject) => api.scripting.registerContentScripts([{
  id:'automation-studio-bridge', matches:[`${origin}/*`], js:['bridge.js'], runAt:'document_start', persistAcrossSessions:true
}],()=>api.runtime.lastError?reject(new Error(api.runtime.lastError.message)):resolve())); }
function matchingTabs(origin) { return new Promise(resolve => api.tabs.query({url:`${origin}/*`},resolve)); }

async function registerBridge(origin) {
  if (!origin) return;
  await unregisterBridge();
  await registerBridgeScript(origin);
  // Dynamic registrations apply on the next navigation. Also inject the bridge
  // into an Automation Studio tab that is already open.
  for (const tab of await matchingTabs(origin)) {
    if (tab.id) try { await injectFile(tab.id,'bridge.js'); } catch (_) { /* next reload will install it */ }
  }
}
function injectFile(id,file) { return new Promise((resolve,reject) => api.scripting.executeScript({target:{tabId:id},files:[file]},()=>api.runtime.lastError?reject(new Error(api.runtime.lastError.message)):resolve())); }

function parsePairing(text) {
  let value;
  try { let raw=String(text||'').trim().replace(/-/g,'+').replace(/_/g,'/'); while(raw.length%4)raw+='='; value = JSON.parse(atob(raw)); }
  catch (_) { throw new Error('The pairing code is not valid. Copy a fresh code from Automation Studio.'); }
  if (!value.api || !value.id || !value.token || !value.origin) throw new Error('The pairing code is incomplete.');
  return value;
}
async function request(state,path,options={}) {
  const response = await fetch(`${state.api}${path}`, { ...options, headers:{'Content-Type':'application/json','Authorization':`Collector ${state.token}`,...(options.headers||{})} });
  let body={}; try { body=await response.json(); } catch (_) {}
  if (!response.ok) throw new Error(body.detail || `Collector server returned ${response.status}.`);
  return body;
}
function normalise(url, origin) {
  try { const u=new URL(url); u.hash=''; if(u.origin!==origin || !['http:','https:'].includes(u.protocol) || DANGEROUS.test(`${u.pathname}${u.search}`)) return null; return u.href; } catch (_) { return null; }
}
function routeMatches(url, expectedRoutes=[]) {
  if(!expectedRoutes.length)return true;
  try {
    const actual=new URL(url).pathname.replace(/\/+$/,'')||'/';
    return expectedRoutes.some(route=>{
      const expected=new URL(String(route||'/'),'https://collector.invalid').pathname.replace(/\/+$/,'')||'/';
      return actual===expected;
    });
  } catch (_) { return false; }
}
function addLog(state, event, message, details={}) {
  if(!state)return state;
  const safe={};
  for(const [key,value] of Object.entries(details)){
    if(SENSITIVE.test(key))continue;
    if(key==='url'){
      try {const parsed=new URL(String(value));for(const name of [...parsed.searchParams.keys()])if(SENSITIVE.test(name))parsed.searchParams.set(name,'redacted');safe[key]=parsed.href;}
      catch(_){safe[key]='invalid-url';}
    } else safe[key]=value;
  }
  const entry={at:new Date().toISOString(),event,message:String(message||'').slice(0,500),...safe};
  state.logs=[...(state.logs||[]),entry].slice(-MAX_LOGS);
  return state;
}
async function finish(state, message) {
  if (!state?.active) return {active:false,message:message||'No crawl is running.'};
  const before=await storageGet(STATE);
  if(!before?.active||before.terminal||Number(before.id)!==Number(state.id))return before||{active:false,message:'This crawl is no longer active.'};
  await storageSet({...before,active:false,terminal:true,busy:false,message:'Finalising collector results…'});
  try {
    const result=await request(state,`/automation/knowledge-base/browser-crawl/sessions/${state.id}/finish`,{method:'POST',body:'{}'});
    if(result?.status==='failed')throw new Error(result.error||'The selected element did not reach the expected screen.');
  }
  catch (e) {
    const current=await storageGet(STATE);
    if(Number(current?.id)===Number(state.id)){await storageSet({...current,active:false,terminal:true,busy:false,message:e.message});await closeOwnedTabs(state);}
    throw e;
  }
  const done={active:false,terminal:true,pages:state.visited.length,message:message||`Finished. Sent ${state.visited.length} page(s) to Automation Studio.`,logs:state.logs||[],id:state.id};
  addLog(done,'finished',done.message,{pages:done.pages});
  const current=await storageGet(STATE);
  if(Number(current?.id)!==Number(state.id))return current||done;
  await storageSet(done);
  await closeOwnedTabs(state);
  return done;
}
async function failAutomation(state, error) {
  const message=error?.message||String(error||'The guided crawl stopped.');
  const before=await storageGet(STATE);
  if(Number(before?.id)!==Number(state.id))return before||{active:false,message};
  await storageSet({...before,active:false,terminal:true,busy:false,message});
  state.message=message;
  await reportProgress(state,'failed','error',message);
  // Preserve a value-free snapshot of the actual failure screen before the
  // one-crawl credential is revoked.
  if(state?.tabId){
    try{
      await inject(state.tabId);
      const page=await send(state.tabId,{type:'collect'});
      page.screenshot=await captureSanitised(state.tabId);
      const capturedUrl=page?.url&&normalise(page.url,state.origin);
      if(capturedUrl){
        await request(state,`/automation/knowledge-base/browser-crawl/sessions/${state.id}/pages`,{method:'POST',body:JSON.stringify(page)});
        if(!state.visited.includes(page.url))state.visited.push(page.url);
        addLog(state,'failure-captured','Captured the screen where the collector stopped.',{url:capturedUrl,elements:page.elements?.length||0});
      }
    }catch(_){/* keep the original failure */}
  }
  try { await request(state,`/automation/knowledge-base/browser-crawl/sessions/${state.id}/fail`,{method:'POST',body:JSON.stringify({message})}); } catch (_) {}
  const failed={active:false,terminal:true,pages:state.visited?.length||0,message,logs:state.logs||[],id:state.id};
  addLog(failed,'failed',message,{step:state.actionIndex??null});
  // A terminal failure owns no further interaction. Close the extension-created
  // tab after its final snapshot is safely uploaded; the failure preview stays
  // available in Automation Studio without leaving abandoned application tabs.
  const current=await storageGet(STATE);
  if(Number(current?.id)!==Number(state.id))return current||failed;
  await storageSet(failed);
  await closeOwnedTabs(state);
  return failed;
}
async function reportProgress(state, collectorState='executing', actionStatus=null, actionError=null) {
  try {
    await request(state,`/automation/knowledge-base/browser-crawl/sessions/${state.id}/progress`,{
      method:'POST',body:JSON.stringify({
        state:collectorState,message:state.message,action_index:state.actionIndex,
        action_total:state.automation?.actions?.length||0,action_text:state.actionText||null,
        action_order:state.automation?.actions?.[state.actionIndex]?.order||state.actionIndex+1,
        action_status:actionStatus,action_error:actionError
      })
    });
  } catch (_) { /* progress must never stop the crawl */ }
}
async function next(state) {
  if (!state.active) return;
  let url;
  while (state.queue.length && !url) {
    const candidate=state.queue.shift();
    if (!state.visited.includes(candidate)) url=candidate;
  }
  if (!url || state.visited.length >= state.maxPages) return finish(state);
  state.current=url; state.message=`Opening ${url}`;addLog(state,'navigation','Opening an application page.',{url});await storageSet(state);
  if (state.tabId) {
    try { await tabUpdate(state.tabId,url); }
    catch (_) { state.tabId=null; }
  }
  if (!state.tabId) {
    const tab=await tabCreate(url);
    if(!tab?.id)throw new Error('The browser created a crawl tab without an identifier.');
    state.tabId=tab.id;addLog(state,'tab-created','Created the visible crawl tab.',{tab_id:tab.id});await storageSet(state);
    state.createdTabIds=[...new Set([...(state.createdTabIds||[]),tab.id])];await storageSet(state);
  }
}
async function collect(tabId) {
  let state=await storageGet(STATE);
  if (!state?.active || state.tabId!==tabId || state.busy) return;
  const crawlId=state.id;
  state.busy=true; await storageSet(state);
  try {
    await inject(tabId);
    const page=await send(tabId,{type:'collect'});
    page.screenshot=await captureSanitised(tabId);
    const capturedUrl=page?.url&&normalise(page.url,state.origin);
    const expectedUrl=normalise(state.current,state.origin);
    if (!capturedUrl || (!state.automation?.actions?.length && capturedUrl!==expectedUrl)) {
      state.busy=false;await storageSet(state);return;
    }
    // Guided setup is expected to navigate between screens on the registered
    // origin (for example / -> /inventory.html after login).
    if(state.automation?.actions?.length)state.current=capturedUrl;
    await request(state,`/automation/knowledge-base/browser-crawl/sessions/${state.id}/pages`,{method:'POST',body:JSON.stringify(page)});
    state=await storageGet(STATE);
    if(!state?.active||Number(state.id)!==Number(crawlId)||state.tabId!==tabId)return;
    if(!state.visited.includes(page.url))state.visited.push(page.url);
    addLog(state,'captured',`Captured ${page.name||page.page_id||'page'}.`,{url:capturedUrl,elements:page.elements?.length||0});
    if(state.automation?.actions?.length){
      const keepAlive=setInterval(()=>{try{api.runtime.getPlatformInfo(()=>void api.runtime.lastError);}catch(_){}},20000);
      let recollect=false;
      try{recollect=Boolean(await runAutomation(state,tabId,page));}
      finally{clearInterval(keepAlive);}
      state=await storageGet(STATE);
      if(!state?.active||Number(state.id)!==Number(crawlId)||state.tabId!==tabId)return;
      state.busy=false;await storageSet(state);
      if(recollect)setTimeout(()=>void collect(tabId),1200);
      return;
    }
    for (const raw of page.links||[]) {
      const url=normalise(raw,state.origin);
      if(url && !state.visited.includes(url) && !state.queue.includes(url)) state.queue.push(url);
    }
    state.message=`Captured ${state.visited.length} page(s); ${state.queue.length} waiting.`;
    state.busy=false;await storageSet(state); await next(state);
  } catch (e) {
    state=await storageGet(STATE)||state;
    if(!state?.active||Number(state.id)!==Number(crawlId)||state.tabId!==tabId)return;
    if(state.automation?.actions?.length)return failAutomation(state,e);
    state.message=`Skipped ${state.current}: ${e.message}`;state.busy=false;
    if(!state.visited.includes(state.current))state.visited.push(state.current); await storageSet(state); await next(state);
  }
}
async function runAutomation(state,tabId,page) {
  const actions=state.automation?.actions||[];
  if(state.pendingValidation){
    const pending=state.pendingValidation;
    const action=actions[pending.actionIndex];
    const matched=routeMatches(page?.url,action?.expected_routes||[]);
    if(matched){
      if(pending.repair){
        await request(state,`/automation/knowledge-base/browser-crawl/sessions/${state.id}/repair`,{method:'POST',body:JSON.stringify(pending.repair)});
        addLog(state,'action-repaired',`Validated and saved the selected element for step ${pending.actionIndex+1}.`,{action:action?.kind,index:pending.actionIndex+1,url:page?.url});
      }
      state.actionIndex=pending.actionIndex+1;state.pendingValidation=null;
      state.actionText=action?.text||action?.kind;
      state.message=`Validated the expected screen after step ${pending.actionIndex+1}.`;
      await reportProgress(state,'executing','done');
      addLog(state,'action-done',`Completed: ${state.actionText}`,{action:action?.kind,index:state.actionIndex,total:actions.length,url:page?.url});
      if(!await persistRunning(state))return false;
    }else if(action?.interactive){
      const expected=(action.expected_screens||action.expected_routes||[]).join(', ')||'the expected screen';
      state.pendingValidation=null;
      state.message=`The selected element opened ${page?.url||'another screen'}, not ${expected}. The recapture is still open; navigate back or choose the correct element.`;
      addLog(state,'repair-rejected',state.message,{action:action.kind,index:pending.actionIndex+1,url:page?.url});
      if(!await persistRunning(state))return false;
      await reportProgress(state,'waiting','running');
    }else{
      const expected=(action?.expected_screens||action?.expected_routes||[]).join(', ')||'the expected screen';
      throw new Error(`Step ${pending.actionIndex+1} opened ${page?.url||'another screen'} instead of ${expected}.`);
    }
  }
  while(state.active && state.actionIndex<actions.length){
    const current=await storageGet(STATE);
    if(!current?.active||current.terminal||Number(current.id)!==Number(state.id)||current.tabId!==tabId)return false;
    state={...state,...current};
    const action=actions[state.actionIndex];
    state.actionText=action.text||action.kind;
    state.message=`Running step ${state.actionIndex+1} of ${actions.length}: ${state.actionText}`;
    addLog(state,'action-start',state.message,{action:action.kind,index:state.actionIndex+1,total:actions.length});
    if(!await persistRunning(state))return false;await reportProgress(state,'executing','running');
    if(action.kind==='goto'){
      await reportProgress(state,'executing','done');
      state.actionIndex+=1;
      addLog(state,'action-done',`Completed: ${state.actionText}`,{action:action.kind,index:state.actionIndex,total:actions.length});
      if(!await persistRunning(state))return false;
      continue;
    }
    let result=null;
    for(let attempt=0;attempt<=state.retryCount;attempt+=1){
      result=await send(tabId,{type:'execute',action:{...action,wait_seconds:state.waitSeconds,retry_count:state.retryCount}});
      if(result?.done)break;
      if(attempt<state.retryCount){
        addLog(state,'action-retry',`Retry ${attempt+1} of ${state.retryCount}: ${result?.error||state.actionText}`,{action:action.kind,index:state.actionIndex+1});
        state.message=`Waiting and retrying step ${state.actionIndex+1}: ${state.actionText}`;
        if(!await persistRunning(state))return false;await reportProgress(state,'waiting');
      }
    }
    if(!result?.done)throw new Error(result?.error||`Could not execute ${action.text||action.kind}.`);
    if(result.navigationOnly){
      state.message='Navigation click completed without recording it. Waiting for the new screen; the same recapture step remains selected.';
      addLog(state,'navigation-only',state.message,{index:state.actionIndex+1});
      if(!await persistRunning(state))return false;await reportProgress(state,'waiting');return true;
    }
    if(result.clicked && (action.expected_routes||[]).length){
      state.pendingValidation={actionIndex:state.actionIndex,repair:result.repair||null};
      state.message=`Clicked ${action.labels?.[0]||action.text||'the control'}; validating the destination screen before saving the step.`;
      addLog(state,'action-validation',state.message,{action:action.kind,index:state.actionIndex+1,expected_routes:action.expected_routes});
      if(!await persistRunning(state))return false;await reportProgress(state,'waiting','running');
      return true;
    }
    if(result.repair){
      await request(state,`/automation/knowledge-base/browser-crawl/sessions/${state.id}/repair`,{method:'POST',body:JSON.stringify(result.repair)});
      addLog(state,'action-repaired',`Selected the element for step ${state.actionIndex+1}.`,{action:action.kind,index:state.actionIndex+1});
    }
    await reportProgress(state,'executing','done');
    state.actionIndex+=1;addLog(state,'action-done',`Completed: ${state.actionText}`,{action:action.kind,index:state.actionIndex,total:actions.length});if(!await persistRunning(state))return false;
    if(result.clicked){
      state.message=`Clicked ${action.labels?.[0]||action.text||'the control'}; waiting for the screen to settle.`;
      if(!await persistRunning(state))return false;await reportProgress(state,'waiting');
      return true;
    }
  }
  if(state.actionIndex>=actions.length){
    // The page snapshot taken on navigation may precede framework hydration.
    // The final assertion has now proved the target exists, so capture again
    // and replace the transitional snapshot before evaluating the journey.
    const page=await send(tabId,{type:'collect'});
    page.screenshot=await captureSanitised(tabId);
    const capturedUrl=page?.url&&normalise(page.url,state.origin);
    if(!capturedUrl)throw new Error('The reached screen is outside the authorised application.');
    await request(state,`/automation/knowledge-base/browser-crawl/sessions/${state.id}/pages`,{method:'POST',body:JSON.stringify(page)});
    if(!state.visited.includes(page.url))state.visited.push(page.url);
    addLog(state,'target-captured',`Validated and captured ${state.automation.target||'the target screen'}.`,{url:capturedUrl,elements:page.elements?.length||0});
    if(!await persistRunning(state))return false;
    await finish(state,`Reached and captured ${state.automation.target||'the next screen'}.`);
    return false;
  }
  return false;
}
async function begin(pairing, maxPages, firstPairing) {
  const previous=await storageGet(STATE);
  if(previous?.tabId||(previous?.createdTabIds||[]).length){
    const wasActive=Boolean(previous.active);
    await storageSet({...previous,active:false,terminal:true,busy:false,message:'Replaced by a new collector session.'});
    await closeOwnedTabs(previous);
    if(wasActive&&previous.api&&previous.id&&previous.token){
      try{await request(previous,`/automation/knowledge-base/browser-crawl/sessions/${previous.id}/fail`,{method:'POST',body:JSON.stringify({message:'This collector session was replaced by a newer recapture.'})});}catch(_){}
    }
  }
  const pair=parsePairing(pairing); const stub={api:pair.api.replace(/\/$/,''),id:pair.id,token:pair.token};
  const cfg=await request(stub,`/automation/knowledge-base/browser-crawl/sessions/${pair.id}`);
  if(cfg.allowed_origin!==pair.origin) throw new Error('The pairing code origin does not match the server session.');
  if (firstPairing && pair.studio) {
    try { await registerBridge(new URL(pair.studio).origin); }
    catch (_) { /* Crawling still works; this browser can keep using manual pairing. */ }
  }
  const state={...stub,active:true,terminal:false,origin:cfg.allowed_origin,baseUrl:cfg.base_url,maxPages:Math.min(cfg.max_pages,Math.max(1,maxPages||cfg.max_pages)),waitSeconds:Math.max(2,Number(cfg.wait_seconds)||20),retryCount:Math.max(0,Number(cfg.retry_count)||0),queue:[cfg.base_url],visited:[],current:null,tabId:null,createdTabIds:[],pairing,automation:cfg.automation||null,actionIndex:0,busy:false,message:'Starting…',logs:[]};
  addLog(state,'started','Collector session started.',{crawl_id:pair.id,origin:cfg.allowed_origin,max_pages:state.maxPages});
  await storageSet(state); await next(state); return state;
}
api.tabs.onUpdated.addListener((tabId,change) => { if(change.status==='complete') void collect(tabId); });
api.tabs.onRemoved.addListener(tabId => {
  void (async()=>{
    const state=await storageGet(STATE);
    if(!state?.active||state.tabId!==tabId)return;
    await failAutomation({...state,tabId:null},new Error('The browser crawl tab was closed before the journey finished.'));
  })();
});
api.runtime.onMessage.addListener((message,sender,respond) => {
  (async()=>{
    if(message.type==='status') return (await storageGet(STATE))||{active:false};
    if(message.type==='logs') {const state=await storageGet(STATE);return {id:state?.id||null,logs:state?.logs||[]};}
    if(message.type==='finish') return finish(await storageGet(STATE));
    if(message.type==='cancel') {
      const state=await storageGet(STATE);
      if(!state?.active)return state||{active:false,message:'No crawl is running.'};
      return failAutomation(state,new Error('Browser crawl stopped by the user.'));
    }
    if(message.type==='start') return begin(message.pairing,message.maxPages,true);
    if(message.type==='bridge-start') return begin(message.pairing,message.maxPages,false);
    if(message.type==='bridge-resume') {
      const state=await storageGet(STATE);
      if(!state?.active || Number(state.id)!==Number(message.crawlId)) return {active:false,message:'This crawl is no longer active.'};
      state.actionIndex=0;state.actionText=null;state.busy=false;state.terminal=false;state.current=state.baseUrl;
      state.message='Retrying the setup from the application start page.';
      addLog(state,'retry',state.message,{crawl_id:state.id});
      await storageSet(state);await reportProgress(state,'opening');
      if(state.tabId) {
        try {await tabUpdate(state.tabId,state.baseUrl);}
        catch (_) {state.tabId=null;}
      }
      if(!state.tabId){
        const tab=await tabCreate(state.baseUrl);
        if(!tab?.id)throw new Error('The browser created a crawl tab without an identifier.');
        state.tabId=tab.id;state.createdTabIds=[...new Set([...(state.createdTabIds||[]),tab.id])];addLog(state,'tab-created','Created a replacement visible crawl tab.',{tab_id:tab.id});await storageSet(state);
      }
      return state;
    }
    if(message.type==='bridge-stop') {
      const state=await storageGet(STATE);
      if(!state||Number(state.id)!==Number(message.crawlId))return {active:false,message:'This crawl is not active in the collector.'};
      const stopped={...state,active:false,terminal:true,busy:false,tabId:null,createdTabIds:[],message:'Stopped by Automation Studio.'};
      await storageSet(stopped);
      await closeOwnedTabs(state);
      return stopped;
    }
    return {active:false};
  })().then(respond).catch(e=>respond({active:false,message:e.message}));
  return true;
});
api.runtime.onInstalled.addListener(()=>{
  void (async()=>{
    const state=await storageGet(STATE);
    if(state?.tabId||(state?.createdTabIds||[]).length){
      await closeOwnedTabs(state);
      await storageSet({...state,active:false,tabId:null,createdTabIds:[],message:'Collector updated. Start the crawl again from Automation Studio.'});
    }
  })();
});
