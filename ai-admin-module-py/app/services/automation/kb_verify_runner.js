// Automation Module: KB verification crawl (kb_verify.py writes plan.json next to this file).
//
// For each probe: a fresh browser session reaches its page with the KB's own
// steps, then every check runs the KB component's steps and is recorded as
// verified / failed / ambiguous. Then the page is swept (sweepPage, the same
// code as the journey crawl), its collapsed panels are opened and it is swept
// again, so objects the KB does not know yet are reported too.
// Never types a value from Test Data, never submits anything.
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const plan = JSON.parse(fs.readFileSync(path.join(__dirname, 'plan.json'), 'utf8'));
const PACE = plan.pace_ms || 1500;
const out = { started_at: new Date().toISOString(), probes: [] };
const save = () => fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify(out, null, 1));
const pace = (ms = PACE) => new Promise((r) => setTimeout(r, ms));
const SWEEP = plan.sweep_js;

async function settle(page, extra = 0) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await pace(PACE + extra);
}

async function visibleCount(page, xp) {
  return page.evaluate((x) => {
    let s; try { s = document.evaluate(x, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); } catch (e) { return -1; }
    let n = 0;
    for (let i = 0; i < s.snapshotLength; i++) {
      const e = s.snapshotItem(i); const b = e.getBoundingClientRect();
      if (b.width > 1 && b.height > 1 && getComputedStyle(e).visibility !== 'hidden') n++;
    }
    return n;
  }, xp).catch(() => -1);
}

async function goto(page, route) {
  const url = new URL(route, plan.base_url).toString();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (await page.getByText('The requested URL was rejected').count().catch(() => 0)) {
    await pace(8000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }
  await settle(page, 1000);
}

// One KB step, with the compiler's semantics: navigate / cookie / click / fill / assert.
async function runStep(page, step) {
  const { action, action_type: type, target, expected } = step;
  if (type === 'navigate') return goto(page, target);
  if (target === '#usercentrics-root' || /cookie/i.test(action)) {
    await page.evaluate(() => { document.querySelector('#usercentrics-root')?.remove(); document.body.style.overflow = 'auto'; }).catch(() => {});
    return;
  }
  const loc = page.locator('xpath=' + target).first();
  if (type === 'click') { await loc.click({ timeout: 20000 }); await settle(page); return; }
  if (type === 'fill') {
    const m = action.match(/'([^']+)'/);
    await loc.fill(m ? m[1] : ''); await pace(); return;
  }
  // assert
  const deadline = Date.now() + 20000;
  let n = 0;
  while (Date.now() < deadline) { n = await visibleCount(page, target); if (n > 0) break; await pace(500); }
  if (n <= 0) throw new Error(`not visible: ${target}`);
  const text = `${action} ${expected || ''}`.toLowerCase();
  if (/\b(disabled|not clickable)\b/.test(text) && !(await loc.isDisabled())) throw new Error(`expected disabled: ${target}`);
  if (/\benabled\b/.test(text) && !(await loc.isEnabled())) throw new Error(`expected enabled: ${target}`);
  return n;
}

// sweepPage, with site-wide re-judged by real ancestry: Angular Material's
// mat-expansion-panel-header reads as "header" to sweepPage's class test, which
// hid the listing's filters. Plus the labelled choices sweepPage cannot address
// (every filter checkbox is aria-label="checkbox"): each option gets the
// selector of the control beside its label, when that is unique.
async function sweep(page) {
  const objects = await page.evaluate(`(() => { ${SWEEP}; return sweepPage(); })()`).catch(() => []);
  return page.evaluate((objs) => {
    const one = (xp) => { try { const s = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); return s.snapshotLength === 1 ? s.snapshotItem(0) : null; } catch (e) { return null; } };
    const SITE = 'header, footer, nav, [role=banner], [role=contentinfo], [role=navigation], app-header-layout, app-copyright-footer, app-mega-menu';
    for (const o of objs) { const el = one(o.selector); o.site_wide = el ? !!el.closest(SITE) : !!o.chrome; }
    const seen = new Set(objs.map((o) => o.selector));
    for (const input of document.querySelectorAll('input[type=checkbox], input[type=radio]')) {
      if (input.closest(SITE)) continue;
      let control = input; while (control.parentElement && control.parentElement.querySelectorAll('input[type=checkbox], input[type=radio]').length === 1 && !control.parentElement.nextElementSibling && control.parentElement !== document.body) control = control.parentElement;
      const labelEl = control.nextElementSibling;
      const label = (labelEl && labelEl.textContent || '').trim().replace(/\s+/g, ' ');
      if (!label || label.length > 40 || label.includes("'")) continue;
      const tag = control.tagName.toLowerCase();
      const xp = `//*[normalize-space(text())='${label}']/preceding-sibling::${tag}`;
      const el = one(xp);
      if (!el || !el.contains(input) || seen.has(xp)) continue;
      const panel = input.closest('mat-expansion-panel, fieldset, [role=group]');
      const group = panel ? ((panel.querySelector('mat-expansion-panel-header, legend') || {}).textContent || '').trim().replace(/\s+/g, ' ') : '';
      seen.add(xp);
      objs.push({ role: input.type, name: label, group, tag, selector: xp, site_wide: false, chrome: false });
    }
    return objs;
  }, objects).catch(() => objects);
}

// The options a configuration page has selected: active pills and the checked colour.
async function selection(page) {
  return page.evaluate(() => ({
    pills: [...document.querySelectorAll('a.device-configurations__pill')].map((a) => ({ text: a.textContent.trim(), active: a.className.includes('--active'), locked: a.className.includes('--disabled') })),
    colours: [...document.querySelectorAll('app-dc-color-selection-radio input')].map((i) => i.id.replace(/^color-/, '')),
    colour: (document.querySelector('app-dc-color-selection-radio input:checked') || {}).id?.replace(/^color-/, '') || null,
  })).catch(() => null);
}

// Open what is collapsed on the page (filter panels, accordions, tabs), one at a time.
async function explore(page) {
  const found = [];
  const handles = await page.$$("main [aria-expanded='false'], app-root [aria-expanded='false'], [role=tab][aria-selected='false']");
  for (const h of handles.slice(0, plan.max_expand || 15)) {
    const inChrome = await h.evaluate((el) => !!el.closest('header, footer, nav')).catch(() => true);
    if (inChrome) continue;
    await h.click({ timeout: 5000 }).catch(() => {});
    await pace(800);
  }
  for (const e of await sweep(page)) found.push(e);
  return found;
}

(async () => {
  const browser = await chromium.launch({ channel: plan.browser === 'chrome' ? 'chrome' : undefined, headless: true });
  const probe0 = await browser.newPage();
  const ua = (await probe0.evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
  await probe0.close();
  for (const probe of plan.probes) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: ua, locale: 'en-US' });
    const page = await ctx.newPage();
    const rec = { id: probe.id, screen: probe.screen, reach_ok: true, checks: [], objects: [], explored: [] };
    const reach = async () => { for (const s of probe.reach) await runStep(page, s); };
    try { await reach(); } catch (e) { rec.reach_ok = false; rec.reach_error = String(e).slice(0, 300); }
    if (rec.reach_ok) {
      let dirty = false;
      for (const check of probe.checks) {
        if (dirty) { try { await reach(); } catch (e) { /* recorded on the check */ } dirty = false; }
        const r = { id: check.id, component: check.component, params: check.params, status: 'verified', matches: [] };
        for (const s of check.steps) {
          try {
            const n = await runStep(page, s);
            if (typeof n === 'number') r.matches.push(n);
            if (s.action_type === 'click' || s.action_type === 'fill') dirty = true;
          } catch (e) {
            r.status = 'failed';
            r.failed_step = s.action;
            r.failed_target = s.target;
            r.error = String(e).split('\n')[0].slice(0, 300);
            r.screenshot = `fail-${check.id.replace(/[^A-Za-z0-9._-]+/g, '_')}.png`;
            await page.screenshot({ path: path.join(__dirname, r.screenshot) }).catch(() => {});
            dirty = true;
            break;
          }
        }
        if (r.status === 'verified' && r.matches.some((n) => n > 1)) r.status = 'ambiguous';
        rec.checks.push(r);
        save();
      }
      if (probe.sweep) {
        try { await reach(); } catch (e) { /* sweep what is there */ }
        rec.objects = await sweep(page);
        rec.selection = await selection(page);
        rec.explored = await explore(page);
      }
      // Probe clicks: what one candidate control does. Reach, sweep, click, sweep again.
      for (const target of probe.clicks || []) {
        const pr = { target, ok: false };
        try {
          await reach();
          const before = new Set((await sweep(page)).map((o) => o.selector));
          const url = page.url();
          await page.locator('xpath=' + target).first().click({ timeout: 15000 });
          await settle(page, 1500);
          const after = await sweep(page);
          pr.ok = true;
          pr.url_changed = page.url() !== url ? page.url() : null;
          pr.appeared = after.filter((o) => !before.has(o.selector) && !o.site_wide);
          pr.visible_text = (await page.evaluate(() => document.body.innerText)).slice(0, 1500);
        } catch (e) { pr.error = String(e).split('\n')[0].slice(0, 300); }
        (rec.probe_clicks = rec.probe_clicks || []).push(pr);
        save();
      }
    }
    out.probes.push(rec);
    save();
    console.log(`${rec.screen.padEnd(28)} reach=${rec.reach_ok} checks=${rec.checks.length} failed=${rec.checks.filter((c) => c.status === 'failed').length}`);
    await ctx.close();
  }
  out.finished_at = new Date().toISOString();
  save();
  await browser.close();
})().catch((e) => { out.error = String(e); save(); console.error(e); process.exit(1); });
