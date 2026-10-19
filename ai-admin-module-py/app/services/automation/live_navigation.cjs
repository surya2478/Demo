// Private, bounded browser transport. The model never supplies code or selectors.
const { chromium } = require('@playwright/test');
const readline = require('node:readline');
let browser, context, page, origin, candidates = [], serial = 0;
let consentScope;
let authoring = false, allowForms = false;
let pageDataPhase = true;
let viewUpdateAllowed = false;
const pageDataRoutes = new Set();
const statuses = new Map();
const blockedRequests = [];
const risky = /\b(buy|purchase|checkout|pay|delete|remove|submit|confirm|subscribe|logout|sign out|sign in|log in|login|order|accept|agree)\b/i;
const riskyLink = /\b(checkout|pay|delete|remove|submit|confirm|subscribe|logout|sign out|sign in|log in|login|order|accept|agree)\b/i;
// BEGIN PORTABLE OBSERVED INTERACTIONS
async function dismissOptionalCookies(allowManage=true) {
  const choices = page.getByRole('button');
  const consent = [];
  const manage = [];
  const save = [];
  for (const button of await choices.all()) {
    if (!await button.isVisible()) continue;
    const label = (await button.innerText()).trim() || (await button.getAttribute('aria-label')) || '';
    const rejection = /^(reject all|reject all cookies|deny|deny all|decline|decline all|only necessary|necessary cookies only|use necessary cookies only)$/i.test(label);
    const preferences = /^(manage my preferences|manage preferences|cookie settings|customize cookies)$/i.test(label);
    const savePreferences = /^(save settings|save preferences|confirm my choices)$/i.test(label);
    if (!rejection && !preferences && !savePreferences) continue;
    const inKnownConsent = consentScope && await button.evaluate((node, scope) => node.getRootNode() === scope, consentScope).catch(() => false);
    const cookieContext = inKnownConsent || await button.evaluate(node => {
      for (let level=0; node && level<20; level++) {
        if (node.tagName === 'BODY' || node.tagName === 'HTML') return false;
        if (/\b(cookies?|privacy|tracking consent)\b/i.test(node.innerText || node.textContent || '')) return true;
        const root = node.getRootNode();
        if (!node.parentElement && root.host && /cookies?|privacy|tracking consent/i.test(root.textContent || '')) return true;
        node = node.parentElement || root.host;
      }
      return false;
    });
    if (cookieContext) (rejection ? consent : preferences ? manage : save).push(button);
  }
  if (!consent.length && allowManage && manage.length === 1) {
    // Preference views may say "technologies", not "cookies". Retain only
    // the already-verified shadow root, never the entire document, as scope.
    const shadow = await manage[0].evaluate(node => !!node.getRootNode().host);
    if (shadow) consentScope = await manage[0].evaluateHandle(node => node.getRootNode());
    await manage[0].click({timeout:4000});
    // The preference panel is rendered asynchronously. Re-observe only once
    // its choice controls appear, not in the old banner's click event frame.
    await page.getByRole('button').filter({hasText:/^(save settings|save preferences|confirm my choices|reject all|deny all|necessary cookies only)$/i})
      .first().waitFor({state:'visible',timeout:4000}).catch(() => {});
    return dismissOptionalCookies(false);
  }
  if (!consent.length && save.length === 1) {
    // Preserve the site's current preferences; do not toggle optional consent
    // on or claim that this constitutes rejecting every optional category.
    // The button must be uniquely observed inside a cookie/privacy context.
    await save[0].click({timeout:4000});
    return true;
  }
  if (consent.length !== 1) return false;
  await consent[0].click({timeout:4000});
  return true;
}
async function clickObserved(target, locator, expectedUrl) {
  page = target;
  await dismissOptionalCookies();
  try { await locator.click({timeout:30000}); }
  catch (error) {
    if (!await dismissOptionalCookies()) throw error;
    if (page.url() !== expectedUrl || await locator.count() !== 1) throw Error('Control changed while resolving cookie dialog');
    await locator.click({timeout:30000});
  }
}
// END PORTABLE OBSERVED INTERACTIONS
async function hasVisibleText(target, value) {
  const normalize = text => String(text).trim().replace(/\s+/g,' ');
  return (await target.locator('body').innerText()).split(/\n+/).some(line=>normalize(line)===normalize(value));
}
async function observe(attempt = 0) {
  if (new URL(page.url()).origin !== origin) throw Error('Navigation left the registered origin');
  let title = await page.title();
  if (/request rejected|access denied|captcha|verify you are human/i.test(title)) throw Error('Website access challenge; human review required');
  await dismissOptionalCookies();
  // Readiness hint only, not an action success condition. Analytics may keep
  // the network busy; the actual controls/assertions are still checked below.
  if (authoring) await page.waitForLoadState('networkidle',{timeout:2000}).catch(()=>{});
  title = await page.title();
  const observedUrl = page.url();
  const refreshChangedPage = () => {
    if (attempt >= 2) throw Error('Page kept changing while collecting controls; no stable observation is available');
    return observe(attempt + 1);
  };
  const controlNodes = page.locator('a[href],button,input,select,textarea,[role="button"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"]');
  const raw = await controlNodes.evaluateAll(nodes => nodes.map((n, domIndex) => ({
    domIndex, visible: !!n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden',
    role: n.getAttribute('role') || (n.tagName === 'A' ? 'link' : n.tagName === 'SELECT' ? 'combobox' : ['INPUT','TEXTAREA'].includes(n.tagName) ? (['checkbox','radio'].includes(n.type) ? n.type : ['submit','button'].includes(n.type) ? 'button' : 'textbox') : 'button'),
    label: (n.getAttribute('aria-label') || (n.labels && Array.from(n.labels).map(l=>l.innerText).join(' ')) || (()=>{
      // Accessible button/link names include image alternatives in DOM order.
      // innerText alone loses "close icon" and rejects an otherwise unique
      // observed role/name locator. Count/visibility validation remains below.
      const text = node => {
        if (node.nodeType === 3) return node.textContent;
        if (node.nodeType !== 1 || node.getAttribute('aria-hidden') === 'true' || getComputedStyle(node).display === 'none') return '';
        if (node.tagName === 'IMG') return node.getAttribute('alt') || '';
        return Array.from(node.childNodes).map(text).join(' ');
      };
      return text(n);
    })() || '').trim().replace(/\s+/g,' ').slice(0,180),
    inputType: n.type || null,
    submitsForm: !!n.form && n.type === 'submit',
    checked: ['checkbox','radio'].includes(n.type) ? n.checked : n.getAttribute('aria-checked'),
    rowContexts: (()=>{const rows=[];let p=n.parentElement;for(let i=0;p&&i<6;i++,p=p.parentElement){if(['BODY','HTML'].includes(p.tagName))break;const text=(p.innerText||'').trim().replace(/\s+/g,' ');if(text&&text.length<=120)rows.push({tag:p.tagName.toLowerCase(),text});}return rows;})(),
    href: n.tagName === 'A' ? n.href : null,
    rawHref: n.tagName === 'A' ? n.getAttribute('href') : null,
    context: (()=>{let p=n.parentElement;for(let i=0;p&&i<3;i++,p=p.parentElement){const t=(p.innerText||'').trim().replace(/\s+/g,' ');if(t&&t.length<400)return t;}return '';})(),
    expandable: n.hasAttribute('aria-expanded') || n.getAttribute('aria-haspopup') === 'menu',
    expanded: n.getAttribute('aria-expanded') === 'true',
    disabled: n.disabled || n.getAttribute('aria-disabled') === 'true'
  })).filter(n => n.visible));
  candidates = [];
  for (const item of raw.slice(0,200)) {
    if (page.url() !== observedUrl) return refreshChangedPage();
    if (item.disabled) continue;
    let descriptor = item.inputType === 'password' ? {by:'label',name:item.label} : {by:'role',role:item.role,name:item.label};
    let locator = descriptor.by === 'label' ? page.getByLabel(item.label,{exact:true}) : page.getByRole(item.role, {name:item.label, exact:true});
    if (descriptor.by === 'role' && await locator.count() !== 1) {
      // Read the browser-computed accessible name of this observed node. This
      // handles icon/inline spacing without guessing a selector or using nth
      // in the resulting journey. Ambiguous semantic names still fail closed.
      let line;
      try { line = (await controlNodes.nth(item.domIndex).ariaSnapshot()).split('\n')[0]; }
      catch (error) {
        if (page.url() !== observedUrl) return refreshChangedPage();
        throw error;
      }
      const match = line.match(/^- ([a-z][\w-]*)(?: (.*))?$/);
      if (match && match[1] === item.role) {
        const quoted = (match[2] || '').match(/^"(?:\\.|[^"\\])*"/);
        const name = quoted ? JSON.parse(quoted[0]) : (match[2] || '').replace(/(?: \[.*\])?:$/, '').replace(/ \[.*\]$/, '');
        if (name) {
          item.label = name;
          descriptor = {by:'role',role:item.role,name};
          locator = page.getByRole(item.role,{name,exact:true});
        }
      }
    }
    if (item.role === 'link' && item.rawHref && (!item.label || await locator.count() !== 1)) {
      // An observed destination can identify a nameless image link or repeated
      // link name, but only if precisely one visible link has that destination.
      descriptor = {by:'href',href:item.rawHref};
      locator = page.locator(`a[href=${JSON.stringify(item.rawHref)}]:visible`);
    }
    if (authoring && ['checkbox','radio'].includes(item.role) && await locator.count() !== 1) {
      for (const row of item.rowContexts) {
        const escaped = row.text.split(/\s+/).map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('\\s+');
        const scoped = page.locator(row.tag).filter({hasText:new RegExp('^\\s*'+escaped+'\\s*$')}).getByRole(item.role,{name:item.label,exact:true});
        if (await scoped.count() !== 1 || !await scoped.isVisible()) continue;
        // The scope must select this actual observed element, not another row.
        const handle = await controlNodes.nth(item.domIndex).elementHandle();
        const same = await scoped.evaluate((node, original)=>node===original,handle);
        await handle.dispose();
        if (!same) continue;
        descriptor = {by:'context',tag:row.tag,text:row.text,role:item.role,name:item.label};
        locator = scoped;
        item.label = row.text + ' (' + item.role + ')';
        item.context = row.text + (item.checked === true || item.checked === 'true' ? ' [checked]' : ' [unchecked]');
        break;
      }
    }
    if (await locator.count() !== 1 || !await locator.isVisible()) continue;
    if (!item.label) item.label = item.context || item.href;
    if (!item.label) continue;
    const safeLink = item.role === 'link' && item.href && new URL(item.href).origin === origin && /^https?:/.test(item.href);
    const safeExpand = item.role === 'button' && item.expandable && !item.expanded;
    // A tab switches the current view. Mutation requests remain blocked by
    // the transport; form buttons are not granted execution by this role.
    const safeTab = item.role === 'tab';
    // Public UI controls (for example clearing a filter) do not require login
    // data. Submit buttons remain reserved for explicitly enabled forms;
    // mutation requests and dangerous labels are still denied independently.
    const safeButton = authoring && item.role === 'button' && !item.submitsForm && !risky.test(item.label);
    const safeChoice = authoring && ['checkbox','radio'].includes(item.role) && !risky.test(item.label + ' ' + item.context);
    const formControl = authoring && allowForms && ['textbox','combobox','button'].includes(item.role)
      && !/\b(buy|purchase|checkout|pay|delete|remove|confirm|subscribe|order|agree)\b/i.test(item.label);
    // Opening a product's "Buy now" link is not submitting its order form.
    // Checkout/payment/commit routes remain excluded from public discovery.
    if (!formControl && ((!safeLink && !safeExpand && !safeTab && !safeButton && !safeChoice) || (safeLink ? riskyLink : risky).test(item.label + ' ' + (item.href || '')))) continue;
    if (candidates.some(c=>JSON.stringify(c.descriptor)===JSON.stringify(descriptor))) continue;
    const public_view_control = (safeChoice || safeButton || safeTab) && !/\b(save|update|create|send|register)\b/i.test(item.label);
    candidates.push({...item, public_view_control, id: candidates.length, page_url: page.url(), descriptor, locator});
  }
  if (page.url() !== observedUrl) return refreshChangedPage();
  serial++;
  const evidence = authoring ? (await page.locator('body').innerText()).split(/\n+/).map(t=>t.trim()).filter(t=>t&&t.length<350).slice(0,180) : [];
  return {snapshot:serial, url:page.url(), title, status:statuses.get(page.url()) || null, evidence:[...new Set(evidence)], blocked_requests:blockedRequests.slice(-30),
    controls:candidates.map(({locator,...c}) => c)};
}
async function command(input) {
  if (input.command === 'observe' && authoring) return observe();
  if (input.command === 'start') {
    origin = new URL(input.url).origin;
    authoring = input.authoring === true;
    allowForms = authoring && input.allow_forms === true;
    browser = await chromium.launch({headless:!input.headed, ...(input.headed && input.channel ? {channel:input.channel} : {})});
    context = await browser.newContext({serviceWorkers:'block'});
    if (allowForms && context.routeWebSocket) await context.routeWebSocket('**/*', socket => socket.close());
    await context.route('**/*', route => {
      const request = route.request();
      // Discovery cannot send form data or navigate to another trust boundary.
      const target = new URL(request.url());
      if (request.isNavigationRequest() && request.frame() === page?.mainFrame() && request.method()==='GET' && target.origin===origin) pageDataPhase=true;
      const dataRequest = authoring && target.origin===origin && request.method()==='POST' && ['xhr','fetch'].includes(request.resourceType());
      const routeKey = (page ? new URL(page.url()).pathname : '') + ' ' + target.origin + target.pathname;
      if (dataRequest && pageDataPhase) pageDataRoutes.add(routeKey);
      const pageData = dataRequest && (pageDataPhase || (viewUpdateAllowed && pageDataRoutes.has(routeKey)));
      if ((allowForms && target.origin !== origin) || (!['GET','HEAD'].includes(request.method()) && !(allowForms && target.origin === origin) && !pageData) || (request.isNavigationRequest() && target.origin !== origin)) {
        // Diagnostic metadata only: never retain request bodies or query values.
        blockedRequests.push({method:request.method(),url:target.origin+target.pathname.split(';')[0],type:request.resourceType()});
        return route.abort();
      }
      return route.continue();
    });
    page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.on('response', response => { if (response.request().isNavigationRequest()) statuses.set(response.url(),response.status()); });
    page.on('dialog', dialog => dialog.dismiss());
    await page.goto(input.url,{waitUntil:'domcontentloaded',timeout:25000});
    return observe();
  }
  if (input.command === 'click' || input.command === 'fill' || input.command === 'select') {
    const selected = candidates.find(c => c.id === input.candidate_id);
    if (input.snapshot !== serial || !selected || selected.page_url !== page.url()) throw Error('Stale or unobserved control');
    if (await selected.locator.count() !== 1 || !await selected.locator.isVisible()) throw Error('Control is missing or ambiguous');
    if (selected.href && await selected.locator.getAttribute('href').then(h => new URL(h,page.url()).href) !== selected.href) throw Error('Link changed after observation');
    if (input.command !== 'click') {
      if (!allowForms || new URL(page.url()).origin !== origin) throw Error('Form execution is not authorized for this origin');
      if (input.command === 'fill' && selected.role === 'textbox') await selected.locator.fill(String(input.value));
      else if (input.command === 'select' && selected.role === 'combobox') await selected.locator.selectOption({label:String(input.value)});
      else throw Error('Input action does not match observed control type');
      return observe();
    }
    if (selected.role === 'textbox' || selected.role === 'combobox') throw Error('A field needs a bound Test Data value');
    // A link click must navigate before its new page may load background data.
    // This blocks JS-only POST submissions disguised as navigation links.
    pageDataPhase = selected.role === 'tab';
    viewUpdateAllowed = selected.public_view_control === true;
    await clickObserved(page, selected.locator, selected.page_url);
    await page.waitForLoadState('domcontentloaded',{timeout:10000});
    return observe();
  }
  if (input.command === 'scroll' && authoring) {
    await page.mouse.wheel(0, input.direction === 'up' ? -600 : 600);
    return observe();
  }
  if (input.command === 'expect_url' && authoring) {
    if (new URL(input.url).origin !== origin) throw Error('Expected URL is outside the registered origin');
    await page.waitForURL(input.url,{timeout:6000,waitUntil:'domcontentloaded'});
    return observe();
  }
  if (input.command === 'assert' && authoring) {
    if (input.snapshot !== serial) throw Error('Stale assertion evidence');
    if (input.kind === 'url') {
      if (page.url() !== input.value) throw Error('Observed URL changed');
    } else if (input.kind === 'title') {
      if (await page.title() !== input.value) throw Error('Observed title changed');
    } else if (input.kind === 'text') {
      // Validate rendered text using the same observation method. CSS uppercase
      // and inline price spans can differ from getByText's DOM textContent.
      if (!await hasVisibleText(page,input.value)) throw Error('Assertion text is missing: '+String(input.value).slice(0,120));
    } else throw Error('Unsupported assertion kind');
    return {verified:true};
  }
  if (input.command === 'close') { await browser?.close(); return {closed:true}; }
  throw Error('Unsupported browser operation');
}
module.exports.resolveConsent = async target => { page=target; return dismissOptionalCookies(); };
module.exports.clickObserved = clickObserved;
module.exports.hasVisibleText = hasVisibleText;
if (require.main === module) (async () => {
  for await (const line of readline.createInterface({input:process.stdin})) {
    let input;
    try { input=JSON.parse(line); const result=await command(input); console.log(JSON.stringify({ok:true,result})); if(input.command==='close') break; }
    catch(error) {
      const buttons = page ? await page.getByRole('button').allTextContents().catch(()=>[]) : [];
      console.log(JSON.stringify({ok:false,error:['fill','select'].includes(input?.command) ? 'Test Data input failed; value withheld' : String(error.message).slice(0,350),visible_buttons:allowForms ? [] : buttons.map(t=>t.trim().slice(0,60)).filter(Boolean).slice(-20)}));
    }
  }
  await browser?.close();
})().catch(() => process.exitCode=1);
