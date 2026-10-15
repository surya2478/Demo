/* Runs inside the target page. It reads structure and accessible labels only;
   input values, cookies, storage, HTML and network bodies are never read. */
(() => {
  if (globalThis.__automationStudioCollectorLoaded) return;
  globalThis.__automationStudioCollectorLoaded = true;
  const api = globalThis.chrome || globalThis.browser;
  const clean=(v,n=120)=>String(v||'').replace(/\s+/g,' ').trim().slice(0,n);
  const secret=/token|code|session|auth|key|pass|pwd|secret|sig|otp/i;
  const cleanUrl=value=>{try{const u=new URL(value);u.hash='';for(const key of [...u.searchParams.keys()])if(secret.test(key))u.searchParams.set(key,'redacted');return u.href}catch(_){return ''}};
  const crawlUrl=value=>{try{const u=new URL(value);if([...u.searchParams.keys()].some(key=>secret.test(key)))return '';u.hash='';return u.href}catch(_){return ''}};
  const quote=s=>String(s).replace(/\\/g,'\\\\').replace(/"/g,'\\"');
  const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>=2&&r.height>=2&&s.display!=='none'&&s.visibility!=='hidden'};
  const generated=v=>/^(?:[a-f0-9]{8}-[a-f0-9-]{27,}|mui-|headlessui-|react-|ember\d|radix-|:r\d+:)/i.test(v)||/\d{5,}/.test(v);
  const role=el=>el.getAttribute('role')||({A:'link',BUTTON:'button',SELECT:'combobox',TEXTAREA:'textbox',IMG:'img'}[el.tagName]||(el.tagName==='INPUT'?(el.type==='checkbox'?'checkbox':el.type==='radio'?'radio':['submit','button','reset','image'].includes(el.type)?'button':'textbox'):el.tagName.toLowerCase()));
  const label=el=>{
    const id=el.id; const by=id?document.querySelector(`label[for="${CSS.escape(id)}"]`):null;
    // A submit/button value is its visible label, not typed user data. Values
    // from editable fields remain deliberately excluded.
    const buttonValue=el.tagName==='INPUT'&&['submit','button','reset'].includes(el.type)?el.value:'';
    return clean(el.getAttribute('aria-label')||by?.innerText||el.getAttribute('placeholder')||el.getAttribute('title')||buttonValue||el.innerText||el.textContent);
  };
  const uniqueCss=(selector,el)=>{try{const all=document.querySelectorAll(selector);return all.length===1&&all[0]===el}catch(_){return false}};
  const uniqueXPath=(xpath,el)=>{try{const r=document.evaluate(xpath,document,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null);return r.snapshotLength===1&&r.snapshotItem(0)===el}catch(_){return false}};
  const xpathLiteral=v=>!v.includes("'")?`'${v}'`:!v.includes('"')?`"${v}"`:null;
  function candidates(el) {
    const out=[]; const add=(strategy,value,kind)=>{if(!value||out.some(x=>x.value===value))return;const ok=kind==='xpath'?uniqueXPath(value,el):uniqueCss(value,el);if(ok)out.push({strategy,value,unique:true,targetVerified:true})};
    for(const attr of ['data-testid','data-test','data-qa']){const v=el.getAttribute(attr);if(v)add(attr,`[${attr}="${quote(v)}"]`,'css')}
    if(el.id&&!generated(el.id))add('id',`#${CSS.escape(el.id)}`,'css');
    const name=el.getAttribute('name');if(name)add('name',`${el.tagName.toLowerCase()}[name="${quote(name)}"]`,'css');
    const aria=el.getAttribute('aria-label');if(aria)add('aria-label',`[aria-label="${quote(aria)}"]`,'css');
    const text=clean(el.innerText||el.textContent,80),lit=xpathLiteral(text);
    if(lit)add('text',`//${el.tagName.toLowerCase()}[normalize-space(.)=${lit}]`,'xpath');
    if(!out.length){let node=el,path=[];while(node&&node.nodeType===1&&path.length<5){let part=node.tagName.toLowerCase();const p=node.parentElement;if(p){const same=[...p.children].filter(x=>x.tagName===node.tagName);if(same.length>1)part+=`:nth-of-type(${same.indexOf(node)+1})`}path.unshift(part);const css=path.join(' > ');if(uniqueCss(css,el)){add('scoped-css',css,'css');break}node=p}}
    return out;
  }
  function collect() {
    const selector='a[href],button,input:not([type=hidden]),select,textarea,[role],h1,h2,h3,h4,h5,h6,th,label,legend,[aria-live]';
    const elements=[];
    for(const el of document.querySelectorAll(selector)){
      if(elements.length>=400||!visible(el))continue;
      const locators=candidates(el);if(!locators.length)continue;
      const rect=el.getBoundingClientRect();
      elements.push({role:role(el),name:label(el),text:clean(el.innerText||el.textContent),tag:el.tagName.toLowerCase(),selector:locators[0].value,alternates:locators.slice(1,5).map(x=>x.value),strategy:locators[0].strategy,kind:/^(H[1-6]|TH|LABEL|LEGEND)$/.test(el.tagName)?'text':'control',bounds:{x:Math.max(0,Math.round(rect.left)),y:Math.max(0,Math.round(rect.top)),width:Math.max(2,Math.round(rect.width)),height:Math.max(2,Math.round(rect.height))}});
    }
    const links=[...document.querySelectorAll('a[href]')].filter(visible).map(a=>crawlUrl(a.href)).filter(Boolean).slice(0,300);
    const path=location.pathname.replace(/\/+$/,'')||'/';
    const slug=clean(path,80).replace(/[^a-z0-9]+/gi,'-').replace(/^-+|-+$/g,'');
    return {page_id:`page-${slug||'home'}`,name:clean(document.title||path,120),url:cleanUrl(location.href),title:clean(document.title,200),captured_at:new Date().toISOString(),browser:navigator.userAgent.slice(0,100),viewport:{width:Math.max(320,Math.round(innerWidth)),height:Math.max(240,Math.round(innerHeight))},elements,picked:[],links};
  }
  const matchesRole=(el,roles)=>!roles?.length||roles.includes(role(el))||(roles.includes('textbox')&&['INPUT','TEXTAREA'].includes(el.tagName));
  const locate=action=>{
    if(action.selector){try{const found=action.selector.startsWith('//')?document.evaluate(action.selector,document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue:document.querySelector(action.selector);if(found&&visible(found))return found}catch(_) {}}
    const labels=(action.labels||[]).map(x=>clean(x).toLowerCase()).filter(Boolean);
    const candidates=[...document.querySelectorAll('input:not([type=hidden]),textarea,select,button,a[href],[role],h1,h2,h3,h4,h5,h6,label,legend,span,p')].filter(visible);
    return candidates.find(el=>matchesRole(el,action.roles)&&labels.includes(label(el).toLowerCase()))||
      candidates.find(el=>matchesRole(el,action.roles)&&labels.some(w=>label(el).toLowerCase().includes(w)))||
      [...document.querySelectorAll('body *')].slice(0,2500).find(el=>visible(el)&&labels.includes(label(el).toLowerCase()))||null;
  };
  const pause=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
  const setValue=(el,value)=>{
    el.focus();
    const previous=el.value;
    const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;
    if(setter)setter.call(el,String(value??''));else el.value=String(value??'');
    // React-controlled fields keep a private tracker. Resetting it to the old
    // value makes the synthetic input event visible to React as a real change.
    el._valueTracker?.setValue?.(previous);
    const Input=globalThis.InputEvent||globalThis.Event;
    el.dispatchEvent(new Input('input',{bubbles:true,inputType:'insertText',data:null}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    el.blur();
  };
  const execute=async action=>{
    if(action.kind==='goto')return {done:true};
    const waitMs=Math.max(2000,Math.min(120000,Number(action.wait_seconds||20)*1000));
    const deadline=Date.now()+waitMs;
    let el=locate(action);
    // Browser navigation completes before many Angular/React screens finish
    // rendering. Poll every action, including OTP/fill, until the configured
    // wait expires instead of failing on the first DOM snapshot.
    while(!el&&Date.now()<deadline){await pause(250);el=locate(action);}
    if(!el)return {done:false,error:`Could not find ${action.labels?.[0]||action.text||'the required element'} on this screen after ${Math.round(waitMs/1000)} seconds.`};
    if(action.kind==='otp'){
      const digits=String(action.value??'').split('');
      const boxes=[...document.querySelectorAll('input:not([type=hidden])')].filter(node=>visible(node)&&(
        node.getAttribute('maxlength')==='1'||node.getAttribute('inputmode')==='numeric'||node.getAttribute('autocomplete')==='one-time-code'||/otp|code|digit/i.test(`${node.name||''} ${node.id||''} ${node.getAttribute('aria-label')||''}`)
      ));
      if(boxes.length>1){
        for(let i=0;i<Math.min(boxes.length,digits.length);i+=1){setValue(boxes[i],digits[i]);await pause(60);}
        return {done:true};
      }
      setValue(el,action.value);await pause(180);
      return String(el.value??'')===String(action.value??'')?{done:true}:{done:false,error:'The browser could not enter the one-time password.'};
    }
    if(action.kind==='fill'){
      setValue(el,action.value);
      // Give controlled inputs time to update their framework state before the
      // next action. Only equality is returned; the value never leaves the tab.
      await pause(180);
      return String(el.value??'')===String(action.value??'')
        ? {done:true}
        : {done:false,error:`The browser could not enter ${action.labels?.[0]||'the required value'}.`};
    }
    if(action.kind==='click'){
      el.focus(); el.click();
      // If the click does not navigate, wake the service worker reliably. A
      // navigation is handled by tabs.onUpdated instead.
      setTimeout(()=>{const pending=api.runtime.sendMessage({type:'action-settled'});pending?.catch?.(()=>{});},1200);
      return {done:true,clicked:true};
    }
    return {done:true};
  };
  api.runtime.onMessage.addListener((message,_sender,respond)=>{
    if(message.type==='collect'){respond(collect());return true}
    if(message.type==='execute'){
      execute(message.action||{}).then(respond).catch(error=>respond({done:false,error:error?.message||String(error)}));
      return true;
    }
  });
})();
