"""
--- Automation Module: Application Discovery --------------------------------

Crawl a running application and catalogue the controls it actually renders.

Upstream drives this with `@playwright/mcp`: an LLM steers a browser session
through the app, deciding where to click. That buys exploration of flows a
crawler cannot reach, and costs an MCP dependency, a model call per page and a
non-reproducible catalogue.

This does it with a Playwright spec executed through the runner that already
exists. The output is the same shape -- role, accessible name, a verified
locator, a confidence score -- because that is what grounding consumes. What is
given up is agentic exploration: this follows same-origin links, it does not
reason about what to do next. What is gained is determinism (the same app
yields the same catalogue), no new dependency, and evidence, logs and
cancellation that already work because a crawl is an ordinary run.

The locator each element carries is not a guess. The spec resolves it and
counts the matches before recording it, so anything stored has been verified to
resolve uniquely at crawl time. That is the whole value of the catalogue: the
generator can emit something known to exist instead of a phrase it hoped would
match.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# Cap the crawl. A same-origin follow on a large app would otherwise walk the
# whole site, and the useful catalogue is overwhelmingly on the first few
# screens -- the ones test cases actually name.
DEFAULT_MAX_PAGES = 8
DISCOVERY_OUTPUT_FILE = "discovery.json"
DISCOVERY_PROGRESS_FILE = "discovery-progress.json"

# --- Automation Module: a time budget that follows max_pages -----------------
#
# The spec used to hardcode `test.setTimeout(300_000)` -- five minutes for the
# whole crawl, whatever max_pages said. Against a WAF-fronted production site a
# page costs roughly 30s (35s navigation allowance, a 6s networkidle settle,
# cookie handling, a 1s inter-page delay), so 300s buys about ten pages. Asking
# for twenty produced ten pages, one genuine timeout, and then a blocker per
# still-queued page reading "Target page, context or browser has been closed"
# -- which names the teardown, not the cause, and buries it under nine copies.
#
# The budget is now derived, and the crawl stops itself before it runs out so
# it can say so once, in words that name the fix.
PER_PAGE_BUDGET_MS = 30_000
MIN_CRAWL_BUDGET_MS = 90_000
# Leave the spec room to write the catalogue it has already gathered.
BUDGET_WRITE_RESERVE_MS = 15_000


def crawl_budget_ms(max_pages: int, *, run_timeout_seconds: int = 600) -> int:
    """How long a crawl of `max_pages` pages may take.

    Capped below the runner's own subprocess timeout: a crawl killed from
    outside never reaches the spec's `finally`, so its catalogue is lost
    entirely rather than arriving short.
    """
    wanted = MIN_CRAWL_BUDGET_MS + max(1, max_pages) * PER_PAGE_BUDGET_MS
    ceiling = max(MIN_CRAWL_BUDGET_MS, int(run_timeout_seconds * 1000 * 0.85))
    return min(wanted, ceiling)


def slugify(role: str | None, name: str | None) -> str:
    """A stable handle for one control, from its role and accessible name."""
    parts = [p for p in (role or "", name or "") if p]
    slug = re.sub(r"[^a-z0-9]+", "_", " ".join(parts).lower()).strip("_")
    return (slug or "element")[:200]


def validated_capture_urls(base_url: str, urls: list[str] | None) -> list[str]:
    base = urlparse(base_url)
    result = []
    for value in (urls or [])[:5]:
        candidate = urlparse(str(value).strip())
        if (candidate.scheme not in {'http', 'https'} or candidate.username or candidate.password
                or (candidate.scheme.lower(), candidate.netloc.lower()) != (base.scheme.lower(), base.netloc.lower())):
            raise ValueError('The additional page must belong to the selected application host and environment.')
        normalized = candidate._replace(fragment='').geturl()
        if normalized not in result:
            result.append(normalized)
    return result


def build_discovery_spec(
    base_url: str,
    *,
    max_pages: int = DEFAULT_MAX_PAGES,
    budget_ms: Optional[int] = None,
    auth: Optional[dict[str, str]] = None,
    focus_terms: Optional[list[str]] = None,
    additional_urls: Optional[list[str]] = None,
) -> str:
    """A Playwright spec that walks the app and writes a catalogue as JSON.

    Written to a file in the workspace rather than logged, because the runner
    parses stdout as a JSON test report and a catalogue printed there would
    have to be disentangled from it.
    """
    budget = budget_ms if budget_ms is not None else crawl_budget_ms(max_pages)
    reserve = BUDGET_WRITE_RESERVE_MS
    auth_bootstrap = ""
    if auth:
        # Only browser-observed locator evidence is embedded; vault values are
        # supplied by the runner through TESTDATA_* environment variables.
        auth_variables = auth.get('credential_variables') or ['TESTDATA_USERNAME', 'TESTDATA_PASSWORD']
        if not auth_variables or any(not re.fullmatch(r'TESTDATA_[A-Z0-9_]+', item) for item in auth_variables):
            raise ValueError('The approved login profile has invalid Test Data variables.')
        auth_reads = "\n".join(f"void process.env.{item};" for item in auth_variables)
        auth_bootstrap = f"""
    phase = 'Signing in with Test Data';
    currentUrl = {json.dumps(auth['login_url'])};
    publishProgress();
    try {{
      {auth_reads}
      const requiredAuthValues = {json.dumps(auth_variables)};
      if (requiredAuthValues.some((name) => !process.env[name]))
        throw new Error('Username or password Test Data is unavailable to the browser runner.');
      const commands = {json.dumps(auth.get('commands') or [
          {'kind': 'goto', 'url': auth['login_url']},
          {'kind': 'fill', 'url': auth['login_url'], 'variable': 'TESTDATA_USERNAME', 'locator': {'strategy': 'css', 'selector': auth['username_selector']}},
          {'kind': 'fill', 'url': auth['login_url'], 'variable': 'TESTDATA_PASSWORD', 'locator': {'strategy': 'css', 'selector': auth['password_selector']}},
          {'kind': 'click', 'url': auth['login_url'], 'locator': {'strategy': 'role', 'role': 'button', 'name': auth['submit_name']}},
      ])};
      const authLocator = spec => spec.strategy === 'css' ? page.locator(spec.selector) : page.getByRole(spec.role, {{name:spec.name, exact:true}});
      for (const command of commands) {{
        if (command.kind === 'goto') {{
          await page.goto(command.url, {{waitUntil:'domcontentloaded', timeout:35000}});
          // A sign-in dialog may sit in front of otherwise observed controls.
          // Only dismiss a uniquely identified, non-committing control.
          const loginOverlays = page.locator('dialog[open]:visible, [aria-modal="true"]:visible, [role="dialog"]:visible');
          if (await loginOverlays.count() === 1) {{
            const panel = loginOverlays.first();
            const dismiss = panel.getByRole('button', {{name:/^(close|dismiss|not now|no thanks|reject all|decline all)$/i}});
            if (await dismiss.count() === 1) await dismiss.click({{timeout:3000}});
            if (await panel.isVisible().catch(() => false))
              throw new Error('A visible dialog blocks the approved login controls. Capture a safe dismissal step and retry.');
          }} else if (await loginOverlays.count() > 1) {{
            throw new Error('Multiple dialogs block the login page; the safe dismissal is ambiguous.');
          }}
          continue;
        }}
        if (new URL(page.url()).origin !== new URL(command.url).origin || new URL(page.url()).pathname.split(';')[0] !== new URL(command.url).pathname.split(';')[0])
          throw new Error('Login reached a different screen. Capture this authentication step before retrying.');
        const control = authLocator(command.locator);
        const expectedCount = command.kind === 'manual_otp' ? command.boxes : 1;
        if (await control.count() !== expectedCount) throw new Error('The approved login controls are missing or ambiguous on their observed screen.');
        if (command.kind === 'manual_otp') {{
          phase = 'Enter and submit a fresh OTP in the visible browser (up to 120 seconds)';
          publishProgress();
          const until = Date.now() + 120000;
          let filled = false;
          while (Date.now() < until) {{
            const marker = {json.dumps(auth.get('success'))};
            if (!marker) throw new Error('OTP requires an observed signed-in success marker.');
            const successControl = authLocator(marker.locator);
            filled = new URL(page.url()).origin === new URL(marker.url).origin && new URL(page.url()).pathname === new URL(marker.url).pathname && await successControl.count() === 1 && await successControl.isVisible();
            if (filled) break;
            await page.waitForTimeout(500);
          }}
          if (!filled) throw new Error('A fresh OTP is required. Complete sign-in in the visible browser and retry from Human Evaluation.');
          break; // The person completed the challenge and its submit action.
        }}
        if (command.kind === 'fill') {{
          if (!process.env[command.variable]) throw new Error('Required authentication Test Data is unavailable: ' + command.variable);
          await control.fill(process.env[command.variable]);
        }} else {{
          await control.click();
          await page.waitForLoadState('domcontentloaded', {{timeout:15000}});
        }}
      }}
      await page.waitForLoadState('domcontentloaded', {{ timeout: 15000 }}).catch(() => {{}});
      if (![origin, ...{json.dumps(auth.get('allowed_origins') or [])}].includes(new URL(page.url()).origin))
        throw new Error('Sign-in left the registered application host.');
      const authError = await page.locator('body').innerText({{ timeout: 5000 }}).catch(() => '');
      if (/invalid (?:user|pass|credential)|incorrect (?:user|pass|credential)|(?:user\\s*name|password).{{0,60}}could not be verified|authentication failed|login failed|sign.?in failed/i.test(authError))
        throw new Error("The application rejected the configured sign-in data. Check this environment's Test Data.");
      const signedOut = page.getByRole('link', {{ name: /^(log|sign)\\s*out$/i }});
      const signedOutButton = page.getByRole('button', {{ name: /^(log|sign)\\s*out$/i }});
      const success = {json.dumps(auth.get('success'))};
      let verified = false;
      if (success) {{
        const marker = authLocator(success.locator);
        verified = new URL(page.url()).pathname === new URL(success.url).pathname && await marker.count() === 1 && await marker.isVisible();
      }} else {{
        verified = await signedOut.first().isVisible().catch(() => false) || await signedOutButton.first().isVisible().catch(() => false);
      }}
      if (!verified) throw new Error('Sign-in success is unverified. Capture an authenticated success marker or complete external sign-in.');
      authResult = {{ verified: true, detail: 'Sign-in succeeded and an authenticated control was observed.' }};
      queue.unshift({{ url: page.url(), viaHref: null, viaText: null, from: null }});
      phase = 'Signed in; scanning protected pages';
      publishProgress();
    }} catch (error) {{
      const detail = String(error && error.message ? error.message : error).slice(0, 300);
      authResult = {{ verified: false, detail }};
      blockers.push({{ url: {json.dumps(auth['login_url'])}, reason: 'Authenticated discovery stopped: ' + detail }});
      throw error;
    }}
"""
    return f"""import {{ test, expect }} from '@playwright/test';
import fs from 'fs';
import path from 'path';

// --- Application Discovery ---------------------------------------------
// Walks same-origin pages from the entry point and records every interactive
// control, with a locator verified to resolve uniquely before it is stored.

const START = {json.dumps(base_url)};
const MAX_PAGES = {max_pages};
const FOCUS_TERMS = {json.dumps([term.lower() for term in (focus_terms or []) if re.fullmatch(r'[a-zA-Z0-9 -]{3,80}', term)][:12])};
const AUTHENTICATED = {str(bool(auth)).lower()};
const BUDGET_MS = {budget};
// Stop early enough to still write what has been gathered.
const DEADLINE = Date.now() + BUDGET_MS - {reserve};

/** Escape a value for a single-quoted Playwright query. */
function q(value) {{
  return String(value).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
}}

test('discover application', async ({{ page }}) => {{
  test.setTimeout(BUDGET_MS);
  const origin = new URL(START).origin;
  // Each entry carries the link that reached it, not just the destination.
  // A generated script can then click `a[href="/eshop/cart"]` -- routing through
  // the application the way a user does -- instead of deep-linking to the
  // absolute URL and losing the session on every step.
  const queue = [{{ url: START, viaHref: null, viaText: null, from: null }},
    ...{json.dumps(validated_capture_urls(base_url, additional_urls))}.map(url => ({{url, viaHref: null, viaText: null, from: null}}))];
  // Public, browser-observed sign-in links may be inspected on another
  // public HTTPS origin. This never authorizes sending Test Data there.
  const linkedAuthOrigins = new Set();
  const seen = new Set();
  const pages = [];
  const elements = [];
  const blockers = [];
  let authResult = {json.dumps(None if auth else {'verified': False, 'detail': 'Anonymous discovery.'})};
  const progressPath = path.join(process.cwd(), {json.dumps(DISCOVERY_PROGRESS_FILE)});
  let currentUrl = START;
  let phase = 'Starting browser scan';
  const publishProgress = () => {{
    try {{
      fs.writeFileSync(progressPath, JSON.stringify({{
        phase, current_url: currentUrl, pages: pages.length,
        controls: elements.length, blockers: blockers.length,
        max_pages: MAX_PAGES, recent_pages: pages.slice(-5).map((item) => ({{ url: item.url, title: item.title }}))
      }}), 'utf-8');
    }} catch (e) {{}}
  }};
  publishProgress();

  // Suppress automation flag on the page context
  await page.addInitScript(() => {{
    try {{
      Object.defineProperty(navigator, 'webdriver', {{ get: () => undefined }});
    }} catch (e) {{}}
  }});

  try {{
{auth_bootstrap}
    while (queue.length && seen.size < MAX_PAGES) {{
      // Say it once, in words that name the fix -- rather than letting the
      // test time out mid-navigation and log a teardown error per queued page.
      if (Date.now() > DEADLINE) {{
        blockers.push({{
          url: (queue[0] && queue[0].url) || START,
          reason: `The crawl ran out of its ${{Math.round(BUDGET_MS / 1000)}}s time budget after `
            + `${{pages.length}} page(s), with ${{queue.length}} still queued. Lower Max pages, `
            + `or raise AUTOMATION_RUN_TIMEOUT_SECONDS to buy a longer budget.`
        }});
        break;
      }}

      const entry = queue.shift();
      const url = entry.url;
      const target = new URL(url);
      if (entry.linkedAuth && (target.protocol !== 'https:' ||
          /^(?:localhost|.*\\.localhost|.*\\.local)$/i.test(target.hostname) ||
          /^(?:\\d+\\.\\d+\\.\\d+\\.\\d+|\\[.*\\])$/.test(target.hostname))) {{
        blockers.push({{url: entry.from, reason: 'The linked sign-in address is not a public HTTPS hostname; it was not opened.'}});
        continue;
      }}
      if (seen.has(url)) continue;
      seen.add(url);
      currentUrl = url;
      phase = 'Opening page';
      publishProgress();

      try {{
        const response = await page.goto(url, {{ waitUntil: 'domcontentloaded', timeout: 35000 }});
        // Settle network, but do not fail if polling keeps it alive
        await page.waitForLoadState('networkidle', {{ timeout: 6000 }}).catch(() => {{}});

        if (new URL(page.url()).origin !== target.origin || (!entry.linkedAuth && target.origin !== origin)) {{
          const landed = new URL(page.url());
          if (!AUTHENTICATED && entry.authEntry && !entry.linkedAuth && landed.protocol === 'https:'
              && landed.origin !== origin && entry.from && linkedAuthOrigins.size < 2
              && !linkedAuthOrigins.has(landed.origin)) {{
            blockers.push({{ url: entry.from, reason: 'Observed sign-in link redirects to a different host (' + landed.origin
              + '). Public login controls can be inspected; credentials require an approved trust boundary.',
              kind: 'linked_auth', entry_url: url, target_url: landed.href,
              source_url: entry.from, link_text: entry.viaText }});
            linkedAuthOrigins.add(landed.origin);
            queue.unshift({{ url: landed.href, viaHref: entry.viaHref, viaText: entry.viaText,
                             from: entry.from, linkedAuth: true }});
          }} else {{
            blockers.push({{ url, reason: 'The route redirected to an unverified host; its controls were not captured.' }});
          }}
          continue;
        }}

        // Only a uniquely observed, non-committing dismissal is safe. Never
        // accept consent, submit a form, or count controls behind an overlay.
        const overlay = await page.evaluate(() => {{
          const nodes = document.querySelectorAll('dialog[open], [aria-modal="true"], [role="dialog"], [class*="cookie" i], [id*="cookie" i]');
          for (const el of nodes) {{
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            const semantic = el.matches('dialog[open], [aria-modal="true"], [role="dialog"]');
            if (style.display === 'none' || style.visibility === 'hidden' || rect.width < 100 || rect.height < 50) continue;
            if (!semantic && !(style.position === 'fixed' && rect.width * rect.height > innerWidth * innerHeight * 0.05)) continue;
            el.setAttribute('data-discovery-active-overlay', 'true');
            return {{ text: (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 180) }};
          }}
          return null;
        }}).catch(() => null);
        let overlayBlocked = false;
        if (overlay) {{
          const panel = page.locator('[data-discovery-active-overlay="true"]');
          const dismiss = panel.getByRole('button', {{name:/^(close|dismiss|not now|no thanks|reject all|decline all)$/i}});
          if (await dismiss.count() === 1 && await dismiss.isVisible().catch(() => false)) {{
            await dismiss.click({{timeout:3000}}).catch(() => {{}});
            await page.waitForTimeout(350);
          }}
          overlayBlocked = await panel.isVisible().catch(() => false);
          if (overlayBlocked) blockers.push({{url, reason: 'A visible dialog or consent overlay blocks this page. Dismiss it in the browser or provide an approved setup step before recrawling. Visible text: ' + overlay.text}});
        }}

        const status = response ? response.status() : 0;
        const title = await page.title().catch(() => '');
        pages.push({{
          url: page.url(), requested_url: url, title, status,
          via_href: entry.viaHref,
          via_text: entry.viaText,
          from_url: entry.from,
          linked_auth: Boolean(entry.linkedAuth),
          linked_auth_controls: [],
          blocked_by_overlay: overlayBlocked
        }});
        phase = 'Finding controls';
        publishProgress();

        if (status >= 400 || title.includes('Request Rejected') || title.includes('Access Denied')) {{
          blockers.push({{ url, reason: `The page returned HTTP ${{status}} or WAF challenge (${{title}}).` }});
          continue;
        }}
        if (overlayBlocked) continue;
      }} catch (error) {{
        const message = String(error && error.message ? error.message : error);
        blockers.push({{ url, reason: message.slice(0, 300) }});
        // Once the context is gone every later navigation fails identically.
        // Recording one blocker per queued page buries whatever really went
        // wrong under a wall of teardown noise.
        if (/context or browser has been closed|Target closed/i.test(message)) break;
        continue;
      }}

      const title = await page.title().catch(() => '');

      // Read interactive elements from page
      try {{
        const found = await page.evaluate(() => {{
          const roleOf = (el) => {{
            const explicit = el.getAttribute('role');
            if (explicit) return explicit;
            const tag = el.tagName.toLowerCase();
            if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
            if (tag === 'button') return 'button';
            if (tag === 'select') return 'combobox';
            if (tag === 'textarea') return 'textbox';
            if (tag === 'input') {{
              const type = (el.getAttribute('type') || 'text').toLowerCase();
              if (['button', 'submit', 'reset'].includes(type)) return 'button';
              if (type === 'checkbox') return 'checkbox';
              if (type === 'radio') return 'radio';
              if (type === 'search') return 'searchbox';
              if (type === 'number') return 'spinbutton';
              if (['hidden'].includes(type)) return null;
              return 'textbox';
            }}
            return null;
          }};

          const tidy = (value) => (value || '').replace(/\\s+/g, ' ').trim();

          const nameOf = (el) => {{
            const aria = el.getAttribute('aria-label');
            if (tidy(aria)) return {{ name: tidy(aria), how: 'aria' }};
            const labelledBy = el.getAttribute('aria-labelledby');
            if (labelledBy) {{
              const ref = document.getElementById(labelledBy);
              if (ref && tidy(ref.innerText)) return {{ name: tidy(ref.innerText), how: 'aria' }};
            }}
            if (el.id) {{
              const label = document.querySelector(`label[for="${{CSS.escape(el.id)}}"]`);
              if (label && tidy(label.innerText)) return {{ name: tidy(label.innerText), how: 'label' }};
            }}
            const wrapping = el.closest('label');
            if (wrapping && tidy(wrapping.innerText)) return {{ name: tidy(wrapping.innerText), how: 'label' }};
            // Legacy business forms often put the caption in the preceding
            // table cell instead of an HTML label (for example ParaBank).
            const cell = el.closest('td');
            if (cell && cell.previousElementSibling && tidy(cell.previousElementSibling.innerText))
              return {{ name: tidy(cell.previousElementSibling.innerText), how: 'adjacent' }};
            const preceding = el.previousElementSibling;
            if (['input', 'select', 'textarea'].includes(el.tagName.toLowerCase()) && preceding
                && !preceding.matches('input,select,textarea,button') && !preceding.querySelector('input,select,textarea,button')
                && tidy(preceding.innerText) && tidy(preceding.innerText).length <= 160)
              return {{ name: tidy(preceding.innerText), how: 'adjacent' }};
            // Never treat a typed field value as a control name or persist it
            // in the discovery catalogue. Button captions are safe labels.
            const inputType = (el.getAttribute('type') || '').toLowerCase();
            const text = tidy((el.tagName.toLowerCase() === 'select' ? '' : el.innerText) || (['button', 'submit', 'reset'].includes(inputType) ? el.value : ''));
            if (text) return {{ name: text, how: 'text' }};
            const placeholder = el.getAttribute('placeholder');
            if (tidy(placeholder)) return {{ name: tidy(placeholder), how: 'placeholder' }};
            const fieldName = el.getAttribute('name');
            if (tidy(fieldName)) return {{ name: tidy(fieldName).replace(/[._-]+/g, ' '), how: 'name' }};
            if (el.id && ['input', 'select', 'textarea'].includes(el.tagName.toLowerCase()))
              return {{ name: tidy(el.id).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._-]+/g, ' '), how: 'id' }};
            return {{ name: '', how: 'none' }};
          }};

          const out = [];
          const nodes = document.querySelectorAll(
            'a[href], button, input, select, textarea, [role]'
          );
          for (const el of nodes) {{
            const style = window.getComputedStyle(el);
            // Hidden tab panels can contain controls whose own display value
            // is still "inline". They are not actionable until revealed.
            if (style.display === 'none' || style.visibility === 'hidden'
                || el.getClientRects().length === 0) continue;
            const role = roleOf(el);
            if (!role) continue;
            const {{ name, how }} = nameOf(el);
            if (!name) continue;
            out.push({{
              role,
              name: name.slice(0, 300),
              how,
              testId: el.getAttribute('data-testid') || null,
              fieldName: el.getAttribute('name') || null,
              fieldId: el.id || null,
              href: el.getAttribute('href') || null
            }});
          }}
          return out;
        }});

        for (const item of found) {{
          const candidates = [];
          if (item.testId) {{
            candidates.push({{ strategy: 'testid', expr: `page.getByTestId('${{q(item.testId)}}')`, confidence: 95 }});
          }}
          if (item.fieldId) {{
            const css = `[id=${{JSON.stringify(item.fieldId)}}]`;
            candidates.push({{ strategy: 'css', css, expr: `page.locator('${{q(css)}}')`, confidence: 92 }});
          }}
          if (item.fieldName) {{
            const css = `[name=${{JSON.stringify(item.fieldName)}}]`;
            candidates.push({{ strategy: 'css', css, expr: `page.locator('${{q(css)}}')`, confidence: 88 }});
          }}
          if (item.how === 'label') {{
            candidates.push({{ strategy: 'label', expr: `page.getByLabel('${{q(item.name)}}')`, confidence: 85 }});
          }}
          if (item.how === 'placeholder') {{
            candidates.push({{ strategy: 'placeholder', expr: `page.getByPlaceholder('${{q(item.name)}}')`, confidence: 70 }});
          }}
          candidates.push({{
            strategy: 'role',
            expr: `page.getByRole('${{q(item.role)}}', {{ name: '${{q(item.name)}}' }})`,
            confidence: 80
          }});
          // Text on an adjacent <td> is not the field itself. Never mistake
          // a caption for a verified input locator.
          if (!['textbox', 'searchbox', 'spinbutton', 'combobox'].includes(item.role))
            candidates.push({{ strategy: 'text', expr: `page.getByText('${{q(item.name)}}')`, confidence: 45 }});

          let chosen = null;
          for (const candidate of candidates) {{
            let locator;
            if (candidate.strategy === 'testid') locator = page.getByTestId(item.testId);
            else if (candidate.strategy === 'css') locator = page.locator(candidate.css);
            else if (candidate.strategy === 'label') locator = page.getByLabel(item.name);
            else if (candidate.strategy === 'placeholder') locator = page.getByPlaceholder(item.name);
            else if (candidate.strategy === 'role') locator = page.getByRole(item.role, {{ name: item.name }});
            else locator = page.getByText(item.name);

            const count = await locator.count().catch(() => 0);
            if (count === 1) {{ chosen = candidate; break; }}
            if (count > 1 && !chosen) chosen = {{ ...candidate, confidence: Math.max(20, candidate.confidence - 40) }};
          }}

          if (!chosen) continue;
          const observedControl = {{
            page_url: page.url(),
            page_title: title,
            role: item.role,
            accessible_name: item.name,
            recommended_locator: chosen.expr,
            recommended_strategy: chosen.strategy,
            confidence_score: chosen.confidence,
            href: item.href
          }};
          if (entry.linkedAuth) pages[pages.length - 1].linked_auth_controls.push(observedControl);
          else elements.push(observedControl);
        }}
      }} catch (evalErr) {{}}

      // A category tab can reveal product links without changing the URL.
      // Inspect only uniquely named, case-relevant ARIA tabs; do not click
      // cards, buttons, forms, or controls on another origin.
      if (!entry.linkedAuth && FOCUS_TERMS.length && Date.now() < DEADLINE - 5000) {{
        const tabNames = await page.getByRole('tab').allTextContents().catch(() => []);
        const relevantTabs = [...new Set(tabNames.map((name) => name.replace(/\\s+/g, ' ').trim()))]
          .filter((name) => name && FOCUS_TERMS.some((term) => name.toLowerCase().includes(term)))
          .slice(0, 3);
        for (const tabName of relevantTabs) {{
          if (Date.now() > DEADLINE - 5000) break;
          const tab = page.getByRole('tab', {{name: tabName, exact: true}});
          if (await tab.count().catch(() => 0) !== 1 || !await tab.isVisible().catch(() => false)) continue;
          if (await tab.getAttribute('aria-selected').catch(() => null) === 'true') continue;
          const beforeUrl = page.url();
          const beforeHrefs = new Set(await page.locator('a[href]:visible').evaluateAll(
            (links) => links.map((link) => link.getAttribute('href'))).catch(() => []));
          try {{
            await tab.click({{timeout: 3000}});
            await page.waitForTimeout(500);
          }} catch {{ continue; }}
          if (page.url() !== beforeUrl || new URL(page.url()).origin !== origin) {{
            blockers.push({{url: beforeUrl, reason: 'A relevant tab navigated away; its destination needs a separate browser capture.'}});
            break;
          }}
          const revealed = await page.locator('a[href]:visible').evaluateAll((links) => links.map((link) => ({{
            href: link.getAttribute('href') || '',
            name: (link.getAttribute('aria-label') || link.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300)
          }}))).catch(() => []);
          for (const link of revealed) {{
            if (!link.href || !link.name || beforeHrefs.has(link.href)) continue;
            let destination;
            try {{ destination = new URL(link.href, beforeUrl); }} catch {{ continue; }}
            if (destination.origin !== origin || !['http:', 'https:'].includes(destination.protocol)
                || /\\.(?:pdf|docx?|xlsx?|zip)(?:$|[?#])/i.test(destination.pathname)) continue;
            const selector = `a[href=${{JSON.stringify(link.href)}}]`;
            const control = page.locator(selector);
            if (await control.count().catch(() => 0) !== 1 || !await control.isVisible().catch(() => false)
                || await page.getByRole('link', {{name: link.name, exact: true}}).count().catch(() => 0) !== 1) continue;
            elements.push({{
              page_url: beforeUrl, page_title: title, role: 'link', accessible_name: link.name,
              recommended_locator: `page.locator('${{q(selector)}}')`, recommended_strategy: 'css',
              confidence_score: 90, href: link.href, revealed_by: tabName
            }});
            destination.hash = '';
            if (!seen.has(destination.href) && !queue.some((queued) => queued.url === destination.href)
                && queue.length + seen.size < MAX_PAGES) {{
              queue.push({{url: destination.href, viaHref: link.href, viaText: link.name,
                           from: beforeUrl, focusScore: FOCUS_TERMS.some((term) => link.name.toLowerCase().includes(term)) ? 1 : 0}});
            }}
          }}
        }}
      }}

      // Discover next same-origin links
      try {{
        const links = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href]'))
            .filter((a) => a.getClientRects().length > 0 && getComputedStyle(a).visibility !== 'hidden')
            .map((a) => ({{
              absolute: a.href,
              // The href as authored, not as resolved. `a[href="/eshop/cart"]`
              // matches what the application renders; the absolute form does
              // not, so the authored value is the one a script can select on.
              href: a.getAttribute('href') || '',
              text: (a.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200)
            }}))
            .filter((link) => link.absolute)
        );
        const focusScore = (link) => FOCUS_TERMS.reduce((score, term) => {{
          const compact = value => value.toLowerCase().replace(/[^a-z0-9]/g, '');
          const matched = compact(link.text + ' ' + new URL(link.absolute).pathname).includes(compact(term));
          return score + (matched ? (term.includes(' ') ? 20 : 1) : 0);
        }}, 0);
        links.sort((left, right) => focusScore(right) - focusScore(left));
        for (const link of links) {{
          try {{
            const parsed = new URL(link.absolute);
            parsed.hash = '';
            // Visiting sign-out during an authenticated scan invalidates the
            // browser session and makes later protected pages look uncrawled.
            if (AUTHENTICATED && (/\\b(log|sign)[\\s_-]*out\\b/i.test(link.text)
                || /\\b(log|sign)[\\s_-]*out\\b/i.test(parsed.pathname))) continue;
            const authEntry = /\\b(sign[\\s-]*in|log[\\s-]*in|login|my account)\\b/i.test(link.text)
              || /(?:^|[/-])(login|signin|sign-in|auth)(?:[/.?-]|$)/i.test(parsed.pathname);
            const isDocument = /\\.(?:pdf|docx?|xlsx?|zip)(?:$|[?#])/i.test(parsed.pathname);
            if (isDocument) continue;
            if (authEntry && parsed.origin !== origin && !entry.linkedAuth) {{
              const note = 'Observed sign-in link opens a different host (' + parsed.origin
                + '). Public login controls can be inspected; credentials require a separately approved trust boundary.';
              if (!blockers.some((item) => item.target_url === parsed.href))
                blockers.push({{url, reason:note, kind:'linked_auth', target_url:parsed.href, source_url:page.url(), link_text:link.text}});
              if (!AUTHENTICATED && parsed.protocol === 'https:' && linkedAuthOrigins.size < 2
                  && !linkedAuthOrigins.has(parsed.origin) && seen.size < MAX_PAGES) {{
                if (queue.length + seen.size >= MAX_PAGES) queue.pop();
                linkedAuthOrigins.add(parsed.origin);
                queue.unshift({{url: parsed.href, viaHref:link.href, viaText:link.text,
                               from:page.url(), linkedAuth:true}});
              }}
            }}
            if (!entry.linkedAuth && parsed.origin === origin && !seen.has(parsed.href)
                && !queue.some((queued) => queued.url === parsed.href)) {{
              if (authEntry && queue.length + seen.size >= MAX_PAGES) {{
                const ordinary = queue.findLastIndex((queued) => !queued.authEntry && !queued.linkedAuth);
                if (ordinary >= 0) queue.splice(ordinary, 1);
              }}
              if (queue.length + seen.size >= MAX_PAGES && focusScore(link) > 0) {{
                const ordinary = queue.findLastIndex((queued) => !queued.authEntry && !queued.linkedAuth
                  && (queued.focusScore || 0) < focusScore(link));
                if (ordinary >= 0) queue.splice(ordinary, 1);
              }}
              if (queue.length + seen.size >= MAX_PAGES) continue;
              const next = {{
                url: parsed.href,
                viaHref: link.href,
                viaText: link.text,
                from: page.url(),
                authEntry,
                focusScore: focusScore(link)
              }};
              if (authEntry) queue.unshift(next);
              else queue.push(next);
              queue.sort((left, right) => Number(!!right.linkedAuth) - Number(!!left.linkedAuth)
                || Number(!!right.authEntry) - Number(!!left.authEntry)
                || (right.focusScore || 0) - (left.focusScore || 0));
            }}
          }} catch {{}}
        }}
      }} catch (linkErr) {{}}

      phase = 'Page captured';
      publishProgress();

      // Inter-page delay
      await page.waitForTimeout(1000).catch(() => {{}});
    }}
  }} finally {{
    phase = 'Preparing evidence';
    publishProgress();
    try {{
      fs.writeFileSync(
        path.join(process.cwd(), {json.dumps(DISCOVERY_OUTPUT_FILE)}),
        JSON.stringify({{ pages, elements, blockers, auth: authResult }}, null, 2),
        'utf-8'
      );
    }} catch (fsErr) {{
      console.error('Failed to write discovery output:', fsErr);
    }}
  }}

  expect(pages.length).toBeGreaterThan(0);
}});
"""


def parse_discovery_output(raw: str) -> dict[str, Any]:
    """Read the catalogue the spec wrote, and normalise it for storage."""
    try:
        data = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"The discovery output was not valid JSON: {exc}") from exc

    pages = data.get("pages") or []
    blockers = data.get("blockers") or []
    elements: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str]] = set()

    for item in data.get("elements") or []:
        name = (item.get("accessible_name") or "").strip()
        role = (item.get("role") or "").strip() or None
        if not name:
            continue
        # Keep one control per page route. A login Username field and a
        # registration Username field are different evidence, even though
        # their labels are identical. Ignore session parameters in the route.
        page = urlparse(item.get("page_url") or "")
        key = (page.netloc, page.path, role or "", name.lower())
        if key in seen:
            continue
        seen.add(key)

        elements.append(
            {
                "page_url": (item.get("page_url") or "")[:1000],
                "page_title": (item.get("page_title") or "")[:500] or None,
                "element_name": slugify(role, name),
                "role": role,
                "accessible_name": name,
                "business_meaning": f"Observed after selecting tab {item['revealed_by']}" if item.get("revealed_by") else None,
                "recommended_locator": item.get("recommended_locator") or "",
                "recommended_strategy": item.get("recommended_strategy") or "role",
                "confidence_score": int(item.get("confidence_score") or 0),
                "href": item.get("href"),
            }
        )

    return {
        "pages": [
            {
                "url": (p.get("url") or "")[:1000],
                "requested_url": (p.get("requested_url") or "")[:1000] or None,
                "title": (p.get("title") or "")[:500],
                "status": p.get("status"),
                # How the crawl reached this page: the authored href of the
                # link it followed, that link's text, and the page it was on.
                # Null for the entry point, which nothing linked to.
                "via_href": (p.get("via_href") or None),
                "via_text": (p.get("via_text") or "")[:200] or None,
                "from_url": (p.get("from_url") or "")[:1000] or None,
                "linked_auth": bool(p.get("linked_auth")),
                "linked_auth_controls": [
                    {"page_url": str(item.get("page_url") or "")[:1000],
                     "role": str(item.get("role") or "")[:40],
                     "accessible_name": str(item.get("accessible_name") or "")[:200],
                     "recommended_locator": str(item.get("recommended_locator") or "")[:500],
                     "recommended_strategy": str(item.get("recommended_strategy") or "")[:30],
                     "confidence_score": int(item.get("confidence_score") or 0)}
                    for item in (p.get("linked_auth_controls") or [])[:100]
                    if isinstance(item, dict)
                ] if p.get("linked_auth") else [],
                "blocked_by_overlay": bool(p.get("blocked_by_overlay")),
            }
            for p in pages
        ],
        "elements": elements,
        "blockers": blockers,
        "auth": data.get("auth"),
    }


def catalog_from_elements(elements: list[Any]) -> list[dict[str, Any]]:
    """The shape the grounding matcher expects, from stored rows."""
    out = []
    for element in elements:
        out.append(
            {
                "element_name": element.element_name,
                "role": element.role,
                "accessible_name": element.accessible_name,
                "business_meaning": element.business_meaning,
                "recommended_locator": element.recommended_locator,
                "recommended_strategy": element.recommended_strategy,
                "confidence_score": element.confidence_score,
                "page": element.page_url,
            }
        )
    return out


def summarise(result: dict[str, Any]) -> dict[str, Optional[int]]:
    return {
        "pages_discovered": len(result.get("pages") or []),
        "elements_discovered": len(result.get("elements") or []),
        "blockers": len(result.get("blockers") or []),
    }
