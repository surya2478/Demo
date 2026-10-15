/* Cross-browser background controller. Uses only the WebExtension API subset
   shared by Firefox and Chromium browsers; no chrome.debugger dependency. */
const api = globalThis.chrome || globalThis.browser;
const STATE = 'automationStudioCollector';
const DANGEROUS = /(?:^|[\/_?&=.-])(logout|logoff|signout|delete|remove|cancel|deactivate|revoke|confirm|submit|checkout|purchase|payment|pay)(?:$|[\/_?&=.-])/i;
const SENSITIVE = /token|code|session|auth|key|pass|pwd|secret|sig|otp|pairing|value/i;
const MAX_LOGS = 300;

function storageGet(key) { return new Promise(resolve => api.storage.local.get(key, value => resolve(value[key]))); }
function storageSet(value) { return new Promise(resolve => api.storage.local.set({[STATE]:value}, resolve)); }
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
function inject(id) { return new Promise((resolve,reject) => api.scripting.executeScript({target:{tabId:id},files:['collector.js']},()=>api.runtime.lastError?reject(new Error(api.runtime.lastError.message)):resolve())); }
function send(id,message) { return new Promise((resolve,reject) => api.tabs.sendMessage(id,message,response=>api.runtime.lastError?reject(new Error(api.runtime.lastError.message)):resolve(response))); }
function requestOrigins(origins) { return new Promise(resolve => api.permissions.request({origins:[...new Set(origins.filter(Boolean))].map(origin=>`${origin}/*`)},resolve)); }
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
  try { await request(state,`/automation/knowledge-base/browser-crawl/sessions/${state.id}/finish`,{method:'POST',body:'{}'}); }
  catch (e) { state.message=e.message; state.active=false; await storageSet(state); await tabRemove(state.tabId); throw e; }
  await tabRemove(state.tabId);
  const done={active:false,pages:state.visited.length,message:message||`Finished. Sent ${state.visited.length} page(s) to Automation Studio.`,logs:state.logs||[],id:state.id};
  addLog(done,'finished',done.message,{pages:done.pages});
  await storageSet(done); return done;
}
async function failAutomation(state, error) {
  const message=error?.message||String(error||'The guided crawl stopped.');
  // Preserve a value-free snapshot of the actual failure screen before the
  // one-crawl credential is revoked.
  if(state?.tabId){
    try{
      await inject(state.tabId);
      const page=await send(state.tabId,{type:'collect'});
      const capturedUrl=page?.url&&normalise(page.url,state.origin);
      if(capturedUrl){
        await request(state,`/automation/knowledge-base/browser-crawl/sessions/${state.id}/pages`,{method:'POST',body:JSON.stringify(page)});
        if(!state.visited.includes(page.url))state.visited.push(page.url);
        addLog(state,'failure-captured','Captured the screen where the collector stopped.',{url:capturedUrl,elements:page.elements?.length||0});
      }
    }catch(_){/* keep the original failure */}
  }
  try { await request(state,`/automation/knowledge-base/browser-crawl/sessions/${state.id}/fail`,{method:'POST',body:JSON.stringify({message})}); } catch (_) {}
  const failed={active:false,pages:state.visited?.length||0,message,logs:state.logs||[],id:state.id};
  addLog(failed,'failed',message,{step:state.actionIndex??null});
  // Keep the application tab open for inspection or an external OTP step.
  await storageSet(failed); return failed;
}
async function reportProgress(state, collectorState='executing') {
  try {
    await request(state,`/automation/knowledge-base/browser-crawl/sessions/${state.id}/progress`,{
      method:'POST',body:JSON.stringify({
        state:collectorState,message:state.message,action_index:state.actionIndex,
        action_total:state.automation?.actions?.length||0,action_text:state.actionText||null
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
  }
}
async function collect(tabId) {
  let state=await storageGet(STATE);
  if (!state?.active || state.tabId!==tabId || state.busy) return;
  state.busy=true; await storageSet(state);
  try {
    await inject(tabId);
    const page=await send(tabId,{type:'collect'});
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
    if(!state.visited.includes(page.url))state.visited.push(page.url);
    addLog(state,'captured',`Captured ${page.name||page.page_id||'page'}.`,{url:capturedUrl,elements:page.elements?.length||0});
    if(state.automation?.actions?.length){state.busy=false;await storageSet(state);return await runAutomation(state,tabId);}
    for (const raw of page.links||[]) {
      const url=normalise(raw,state.origin);
      if(url && !state.visited.includes(url) && !state.queue.includes(url)) state.queue.push(url);
    }
    state.message=`Captured ${state.visited.length} page(s); ${state.queue.length} waiting.`;
    state.busy=false;await storageSet(state); await next(state);
  } catch (e) {
    state=await storageGet(STATE)||state;
    if(state.automation?.actions?.length)return failAutomation(state,e);
    state.message=`Skipped ${state.current}: ${e.message}`;state.busy=false;
    if(!state.visited.includes(state.current))state.visited.push(state.current); await storageSet(state); await next(state);
  }
}
async function runAutomation(state,tabId) {
  const actions=state.automation?.actions||[];
  while(state.active && state.actionIndex<actions.length){
    const action=actions[state.actionIndex];
    state.actionText=action.text||action.kind;
    state.message=`Running step ${state.actionIndex+1} of ${actions.length}: ${state.actionText}`;
    addLog(state,'action-start',state.message,{action:action.kind,index:state.actionIndex+1,total:actions.length});
    await storageSet(state);await reportProgress(state);
    if(action.kind==='goto'){state.actionIndex+=1;continue;}
    let result=null;
    for(let attempt=0;attempt<=state.retryCount;attempt+=1){
      result=await send(tabId,{type:'execute',action:{...action,wait_seconds:state.waitSeconds,retry_count:state.retryCount}});
      if(result?.done)break;
      if(attempt<state.retryCount){
        addLog(state,'action-retry',`Retry ${attempt+1} of ${state.retryCount}: ${result?.error||state.actionText}`,{action:action.kind,index:state.actionIndex+1});
        state.message=`Waiting and retrying step ${state.actionIndex+1}: ${state.actionText}`;
        await storageSet(state);await reportProgress(state,'waiting');
      }
    }
    if(!result?.done)throw new Error(result?.error||`Could not execute ${action.text||action.kind}.`);
    state.actionIndex+=1;addLog(state,'action-done',`Completed: ${state.actionText}`,{action:action.kind,index:state.actionIndex,total:actions.length});await storageSet(state);
    if(result.clicked){
      state.message=`Clicked ${action.labels?.[0]||action.text||'the control'}; waiting for the screen to settle.`;
      await storageSet(state);await reportProgress(state,'waiting');
      return;
    }
  }
  if(state.actionIndex>=actions.length){
    // The page snapshot taken on navigation may precede framework hydration.
    // The final assertion has now proved the target exists, so capture again
    // and replace the transitional snapshot before evaluating the journey.
    const page=await send(tabId,{type:'collect'});
    const capturedUrl=page?.url&&normalise(page.url,state.origin);
    if(!capturedUrl)throw new Error('The reached screen is outside the authorised application.');
    await request(state,`/automation/knowledge-base/browser-crawl/sessions/${state.id}/pages`,{method:'POST',body:JSON.stringify(page)});
    if(!state.visited.includes(page.url))state.visited.push(page.url);
    addLog(state,'target-captured',`Validated and captured ${state.automation.target||'the target screen'}.`,{url:capturedUrl,elements:page.elements?.length||0});
    await storageSet(state);
    return finish(state,`Reached and captured ${state.automation.target||'the next screen'}.`);
  }
}
async function begin(pairing, maxPages, firstPairing) {
  const pair=parsePairing(pairing); const stub={api:pair.api.replace(/\/$/,''),id:pair.id,token:pair.token};
  const apiOrigin=new URL(stub.api).origin;
  if (firstPairing) {
    if(!await requestOrigins([apiOrigin,pair.origin,pair.studio])) throw new Error('Permission to contact Automation Studio and the application was not granted.');
  }
  const cfg=await request(stub,`/automation/knowledge-base/browser-crawl/sessions/${pair.id}`);
  if(cfg.allowed_origin!==pair.origin) throw new Error('The pairing code origin does not match the server session.');
  if (firstPairing && pair.studio) {
    try { await registerBridge(new URL(pair.studio).origin); }
    catch (_) { /* Crawling still works; this browser can keep using manual pairing. */ }
  }
  const state={...stub,active:true,origin:cfg.allowed_origin,baseUrl:cfg.base_url,maxPages:Math.min(cfg.max_pages,Math.max(1,maxPages||cfg.max_pages)),waitSeconds:Math.max(2,Number(cfg.wait_seconds)||20),retryCount:Math.max(0,Number(cfg.retry_count)||0),queue:[cfg.base_url],visited:[],current:null,tabId:null,pairing,automation:cfg.automation||null,actionIndex:0,busy:false,message:'Starting…',logs:[]};
  addLog(state,'started','Collector session started.',{crawl_id:pair.id,origin:cfg.allowed_origin,max_pages:state.maxPages});
  await storageSet(state); await next(state); return state;
}
api.tabs.onUpdated.addListener((tabId,change) => { if(change.status==='complete') void collect(tabId); });
api.runtime.onMessage.addListener((message,sender,respond) => {
  (async()=>{
    if(message.type==='status') return (await storageGet(STATE))||{active:false};
    if(message.type==='logs') {const state=await storageGet(STATE);return {id:state?.id||null,logs:state?.logs||[]};}
    if(message.type==='finish') return finish(await storageGet(STATE));
    if(message.type==='start') return begin(message.pairing,message.maxPages,true);
    if(message.type==='bridge-start') return begin(message.pairing,message.maxPages,false);
    if(message.type==='action-settled') {
      if(sender.tab?.id) void collect(sender.tab.id);
      return {active:true};
    }
    if(message.type==='bridge-resume') {
      const state=await storageGet(STATE);
      if(!state?.active || Number(state.id)!==Number(message.crawlId)) return {active:false,message:'This crawl is no longer active.'};
      state.actionIndex=0;state.actionText=null;state.busy=false;state.current=state.baseUrl;
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
        state.tabId=tab.id;addLog(state,'tab-created','Created a replacement visible crawl tab.',{tab_id:tab.id});await storageSet(state);
      }
      return state;
    }
    return {active:false};
  })().then(respond).catch(e=>respond({active:false,message:e.message}));
  return true;
});
