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
  let screenshotMask=[];
  const maskScreenshot=()=>{
    screenshotMask=[];
    for(const el of document.querySelectorAll('input:not([type=hidden]),textarea')){
      if(!visible(el)||!String(el.value||''))continue;
      screenshotMask.push([el,el.style.color,el.style.textShadow,el.style.caretColor]);
      el.style.setProperty('color','transparent','important');
      el.style.setProperty('text-shadow','none','important');
      el.style.setProperty('caret-color','transparent','important');
    }
    return {done:true};
  };
  const restoreScreenshot=()=>{
    for(const [el,color,shadow,caret] of screenshotMask){el.style.color=color;el.style.textShadow=shadow;el.style.caretColor=caret;}
    screenshotMask=[];return {done:true};
  };
  const selectInteractive=async action=>new Promise(resolve=>{
    for(const old of document.querySelectorAll('#__automation_collector_repair,#__automation_collector_menu,#__automation_collector_highlight'))old.remove();
    // Remove outlines left by collector 1.9.4 in an already-open application
    // tab. Only the exact legacy collector style is touched.
    for(const el of document.querySelectorAll('[style*="outline"]')){
      if(el.style.outline==='3px solid rgb(239, 68, 68)'||el.style.outline==='3px solid #ef4444'){
        el.style.outline='';el.style.outlineOffset='';
      }
    }
    const banner=document.createElement('div');banner.id='__automation_collector_repair';
    banner.textContent=`Automation Studio · Step ${action.order}: hover to highlight. Left-click uses the original action; right-click lets you choose the action.`;
    Object.assign(banner.style,{position:'fixed',zIndex:'2147483647',left:'16px',right:'16px',top:'16px',padding:'14px 18px',borderRadius:'10px',background:'#1f2937',color:'#fff',font:'600 14px system-ui,sans-serif',boxShadow:'0 8px 28px rgba(0,0,0,.28)',pointerEvents:'none',textAlign:'center'});
    document.documentElement.appendChild(banner);
    let highlighted=null;
    const overlay=document.createElement('div');overlay.id='__automation_collector_highlight';
    Object.assign(overlay.style,{position:'fixed',zIndex:'2147483646',display:'none',pointerEvents:'none',border:'3px solid #ef4444',borderRadius:'4px',boxSizing:'border-box',boxShadow:'0 0 0 2px rgba(255,255,255,.8)'});
    document.documentElement.appendChild(overlay);
    const targetOf=target=>target.closest?.('a,button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"]')||target.closest?.('[role],[data-test],[data-testid],h1,h2,h3,h4,h5,h6,label,span,p')||target;
    const clearHighlight=()=>{highlighted=null;overlay.style.display='none';};
    const highlight=el=>{if(!el)return clearHighlight();highlighted=el;const rect=el.getBoundingClientRect();Object.assign(overlay.style,{display:'block',left:`${Math.max(0,rect.left-3)}px`,top:`${Math.max(0,rect.top-3)}px`,width:`${Math.max(6,rect.width+6)}px`,height:`${Math.max(6,rect.height+6)}px`});};
    const defaultChoice=()=>action.kind==='fill'||action.kind==='otp'?'fill_test_data':action.kind==='click'?'click':'verify_visible';
    const cleanup=()=>{clearHighlight();overlay.remove();banner.remove();document.getElementById('__automation_collector_menu')?.remove();document.removeEventListener('mouseover',hover,true);document.removeEventListener('mouseout',leave,true);document.removeEventListener('scroll',reposition,true);document.removeEventListener('click',chooseDefault,true);document.removeEventListener('contextmenu',openMenu,true);};
    const complete=async(el,choice,option=null)=>{
      if(choice==='navigate_only'){
        cleanup();resolve({done:true,clicked:true,navigationOnly:true});
        // Let the result reach the background worker before navigation can
        // unload this content script and turn a successful click into an error.
        setTimeout(()=>{el.focus();el.click();},0);return;
      }
      const locator=candidates(el)[0];
      if(!locator){cleanup();resolve({done:false,error:'The selected element did not produce a unique locator.'});return;}
      let clicked=false;
      if(choice==='fill_test_data'){
        if(action.value==null){cleanup();resolve({done:false,error:'This step has no saved Test Data value to fill.'});return;}
        if(action.kind==='otp'){
          const digits=String(action.value).split('');
          const boxes=[...document.querySelectorAll('input:not([type=hidden])')].filter(node=>visible(node)&&(node.getAttribute('maxlength')==='1'||node.getAttribute('inputmode')==='numeric'||node.getAttribute('autocomplete')==='one-time-code'||/otp|code|digit/i.test(`${node.name||''} ${node.id||''} ${node.getAttribute('aria-label')||''}`)));
          if(boxes.length>1){for(let i=0;i<Math.min(boxes.length,digits.length);i+=1){setValue(boxes[i],digits[i]);await pause(60);}}
          else setValue(el,action.value);
        }else setValue(el,action.value);
        await pause(180);
      }else if(['click','tap'].includes(choice)){
        clicked=true;setTimeout(()=>{el.focus();el.click();},0);
      }else if(choice==='double_click'){
        el.focus();el.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,view:window}));clicked=true;
      }else if(choice==='hover'){
        el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,view:window}));el.dispatchEvent(new MouseEvent('mouseenter',{bubbles:false,view:window}));
      }else if(choice==='focus'){
        el.focus();
      }else if(choice==='check'||choice==='uncheck'){
        const desired=choice==='check';const current=el.matches('input')?Boolean(el.checked):el.getAttribute('aria-checked')==='true';
        if(current!==desired)el.click();
      }else if(choice==='press_enter'){
        el.focus();for(const type of ['keydown','keypress','keyup'])el.dispatchEvent(new KeyboardEvent(type,{key:'Enter',code:'Enter',bubbles:true,cancelable:true}));
      }else if(choice==='select_option'){
        const select=el.matches('select')?el:el.querySelector?.('select');
        if(!select||option==null){cleanup();resolve({done:false,error:'Choose a select control and one of its options.'});return;}
        select.value=option;select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));
      }
      const repair={order:action.order,selector:locator.value,app_label:label(el),role:role(el),action:choice,...(option==null?{}:{option})};
      cleanup();resolve({done:true,clicked,repair});
    };
    const hover=event=>{if(event.target instanceof Element&&!event.target.closest('#__automation_collector_repair,#__automation_collector_menu'))highlight(targetOf(event.target));};
    const leave=event=>{if(event.relatedTarget==null)clearHighlight();};
    const reposition=()=>{if(highlighted)highlight(highlighted);};
    const chooseDefault=event=>{if(!(event.target instanceof Element)||event.target.closest('#__automation_collector_repair,#__automation_collector_menu'))return;event.preventDefault();event.stopImmediatePropagation();void complete(targetOf(event.target),defaultChoice());};
    const openMenu=event=>{
      if(!(event.target instanceof Element)||event.target.closest('#__automation_collector_repair,#__automation_collector_menu'))return;
      event.preventDefault();event.stopImmediatePropagation();
      const el=targetOf(event.target);highlight(el);document.getElementById('__automation_collector_menu')?.remove();
      const menu=document.createElement('div');menu.id='__automation_collector_menu';
      Object.assign(menu.style,{position:'fixed',zIndex:'2147483647',left:`${Math.min(event.clientX,innerWidth-230)}px`,top:`${Math.min(event.clientY,innerHeight-250)}px`,width:'220px',padding:'6px',borderRadius:'10px',background:'#fff',color:'#111827',font:'600 13px system-ui,sans-serif',boxShadow:'0 12px 36px rgba(0,0,0,.3)',border:'1px solid #e5e7eb'});
      const options=[['verify_visible','Verify element is visible'],['verify_text','Verify this text'],['hover','Hover'],['focus','Focus'],['press_enter','Press Enter']];
      if(el.matches('a,button,[role="button"],[role="link"],input[type="button"],input[type="submit"]'))options.push(['click','Click'],['tap','Tap'],['double_click','Double-click'],['navigate_only','Navigate only · do not record']);
      if(el.matches('input[type="checkbox"],input[type="radio"],[role="checkbox"],[role="radio"],[role="switch"]'))options.push(['check','Check'],['uncheck','Uncheck']);
      if(action.value!=null&&el.matches('input:not([type="checkbox"]):not([type="radio"]),textarea'))options.push(['fill_test_data','Fill from saved Test Data']);
      if(el.matches('select'))for(const item of [...el.options])options.push(['select_option',`Choose: ${clean(item.textContent,60)}`,item.value]);
      for(const [value,text,option] of options){const button=document.createElement('button');button.type='button';button.textContent=text;Object.assign(button.style,{display:'block',width:'100%',padding:'9px 10px',border:'0',borderRadius:'7px',background:'transparent',textAlign:'left',cursor:'pointer',color:'#111827',font:'inherit'});button.onmouseenter=()=>button.style.background='#fef2f2';button.onmouseleave=()=>button.style.background='transparent';button.onclick=e=>{e.preventDefault();e.stopPropagation();void complete(el,value,option??null)};menu.appendChild(button);}
      document.documentElement.appendChild(menu);
    };
    document.addEventListener('mouseover',hover,true);
    document.addEventListener('mouseout',leave,true);
    document.addEventListener('scroll',reposition,true);
    document.addEventListener('click',chooseDefault,true);
    document.addEventListener('contextmenu',openMenu,true);
  });
  const execute=async action=>{
    if(action.kind==='goto')return {done:true};
    if(action.interactive)return selectInteractive(action);
    const waitMs=Math.max(2000,Math.min(120000,Number(action.wait_seconds||20)*1000));
    const deadline=Date.now()+waitMs;
    let el=locate(action);
    let satisfied=!el&&action.satisfied_by?locate(action.satisfied_by):null;
    // Browser navigation completes before many Angular/React screens finish
    // rendering. Poll every action, including OTP/fill, until the configured
    // wait expires instead of failing on the first DOM snapshot.
    while(!el&&!satisfied&&Date.now()<deadline){await pause(250);el=locate(action);satisfied=!el&&action.satisfied_by?locate(action.satisfied_by):null;}
    if(!el&&satisfied)return {done:true,alreadySatisfied:true};
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
      setTimeout(()=>{el.focus();el.click();},0);
      return {done:true,clicked:true};
    }
    if(action.kind==='dblclick'){el.focus();el.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,view:window}));return {done:true,clicked:true};}
    if(action.kind==='hover'){el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,view:window}));return {done:true};}
    if(action.kind==='focus'){el.focus();return {done:true};}
    if(action.kind==='check'||action.kind==='uncheck'){
      const desired=action.kind==='check';const current=el.matches('input')?Boolean(el.checked):el.getAttribute('aria-checked')==='true';if(current!==desired)el.click();return {done:true};
    }
    if(action.kind==='press'){el.focus();for(const type of ['keydown','keypress','keyup'])el.dispatchEvent(new KeyboardEvent(type,{key:action.key||'Enter',code:action.key||'Enter',bubbles:true,cancelable:true}));return {done:true};}
    if(action.kind==='select'){
      const desired=String(action.option??'');el.value=desired;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return el.value===desired?{done:true}:{done:false,error:'The requested option is not available.'};
    }
    return {done:true};
  };
  api.runtime.onMessage.addListener((message,_sender,respond)=>{
    if(message.type==='collect'){respond(collect());return true}
    if(message.type==='mask-screenshot'){respond(maskScreenshot());return true}
    if(message.type==='restore-screenshot'){respond(restoreScreenshot());return true}
    if(message.type==='execute'){
      execute(message.action||{}).then(respond).catch(error=>respond({done:false,error:error?.message||String(error)}));
      return true;
    }
  });
})();
