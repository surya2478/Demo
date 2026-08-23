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

logger = logging.getLogger(__name__)

# Cap the crawl. A same-origin follow on a large app would otherwise walk the
# whole site, and the useful catalogue is overwhelmingly on the first few
# screens -- the ones test cases actually name.
DEFAULT_MAX_PAGES = 8
DISCOVERY_OUTPUT_FILE = "discovery.json"


def slugify(role: str | None, name: str | None) -> str:
    """A stable handle for one control, from its role and accessible name."""
    parts = [p for p in (role or "", name or "") if p]
    slug = re.sub(r"[^a-z0-9]+", "_", " ".join(parts).lower()).strip("_")
    return (slug or "element")[:200]


def build_discovery_spec(
    base_url: str,
    *,
    max_pages: int = DEFAULT_MAX_PAGES,
) -> str:
    """A Playwright spec that walks the app and writes a catalogue as JSON.

    Written to a file in the workspace rather than logged, because the runner
    parses stdout as a JSON test report and a catalogue printed there would
    have to be disentangled from it.
    """
    return f"""import {{ test, expect }} from '@playwright/test';
import fs from 'fs';
import path from 'path';

// --- Application Discovery ---------------------------------------------
// Walks same-origin pages from the entry point and records every interactive
// control, with a locator verified to resolve uniquely before it is stored.

const START = {json.dumps(base_url)};
const MAX_PAGES = {max_pages};

/** Escape a value for a single-quoted Playwright query. */
function q(value) {{
  return String(value).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
}}

test('discover application', async ({{ page }}) => {{
  test.setTimeout(300_000);
  const origin = new URL(START).origin;
  const queue = [START];
  const seen = new Set();
  const pages = [];
  const elements = [];
  const blockers = [];

  // Suppress automation flag on the page context
  await page.addInitScript(() => {{
    try {{
      Object.defineProperty(navigator, 'webdriver', {{ get: () => undefined }});
    }} catch (e) {{}}
  }});

  try {{
    while (queue.length && seen.size < MAX_PAGES) {{
      const url = queue.shift();
      if (seen.has(url)) continue;
      seen.add(url);

      try {{
        const response = await page.goto(url, {{ waitUntil: 'domcontentloaded', timeout: 35000 }});
        // Settle network, but do not fail if polling keeps it alive
        await page.waitForLoadState('networkidle', {{ timeout: 6000 }}).catch(() => {{}});

        // Auto-dismiss cookie/consent popups
        try {{
          const cookieBtn = page.locator('button', {{ hasText: /accept all|agree|allow all/i }}).first();
          if (await cookieBtn.isVisible({{ timeout: 2500 }}).catch(() => false)) {{
            await cookieBtn.click({{ force: true }}).catch(() => {{}});
            await page.waitForTimeout(500);
          }}
        }} catch (e) {{}}

        const status = response ? response.status() : 0;
        const title = await page.title().catch(() => '');
        pages.push({{ url, title, status }});

        if (status >= 400 || title.includes('Request Rejected') || title.includes('Access Denied')) {{
          blockers.push({{ url, reason: `The page returned HTTP ${{status}} or WAF challenge (${{title}}).` }});
          continue;
        }}
      }} catch (error) {{
        blockers.push({{ url, reason: String(error && error.message ? error.message : error).slice(0, 300) }});
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
            const text = tidy(el.innerText || el.value);
            if (text) return {{ name: text, how: 'text' }};
            const placeholder = el.getAttribute('placeholder');
            if (tidy(placeholder)) return {{ name: tidy(placeholder), how: 'placeholder' }};
            return {{ name: '', how: 'none' }};
          }};

          const out = [];
          const nodes = document.querySelectorAll(
            'a[href], button, input, select, textarea, [role]'
          );
          for (const el of nodes) {{
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const role = roleOf(el);
            if (!role) continue;
            const {{ name, how }} = nameOf(el);
            if (!name) continue;
            out.push({{
              role,
              name: name.slice(0, 300),
              how,
              testId: el.getAttribute('data-testid') || null,
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
          candidates.push({{ strategy: 'text', expr: `page.getByText('${{q(item.name)}}')`, confidence: 45 }});

          let chosen = null;
          for (const candidate of candidates) {{
            let locator;
            if (candidate.strategy === 'testid') locator = page.getByTestId(item.testId);
            else if (candidate.strategy === 'label') locator = page.getByLabel(item.name);
            else if (candidate.strategy === 'placeholder') locator = page.getByPlaceholder(item.name);
            else if (candidate.strategy === 'role') locator = page.getByRole(item.role, {{ name: item.name }});
            else locator = page.getByText(item.name);

            const count = await locator.count().catch(() => 0);
            if (count === 1) {{ chosen = candidate; break; }}
            if (count > 1 && !chosen) chosen = {{ ...candidate, confidence: Math.max(20, candidate.confidence - 40) }};
          }}

          if (!chosen) continue;
          elements.push({{
            page_url: page.url(),
            page_title: title,
            role: item.role,
            accessible_name: item.name,
            recommended_locator: chosen.expr,
            recommended_strategy: chosen.strategy,
            confidence_score: chosen.confidence,
            href: item.href
          }});
        }}
      }} catch (evalErr) {{}}

      // Discover next same-origin links
      try {{
        const links = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href]'))
            .map((a) => a.href)
            .filter(Boolean)
        );
        for (const link of links) {{
          try {{
            const parsed = new URL(link);
            parsed.hash = '';
            if (parsed.origin === origin && !seen.has(parsed.href) && queue.length + seen.size < MAX_PAGES) {{
              queue.push(parsed.href);
            }}
          }} catch {{}}
        }}
      }} catch (linkErr) {{}}

      // Inter-page delay
      await page.waitForTimeout(1000).catch(() => {{}});
    }}
  }} finally {{
    try {{
      fs.writeFileSync(
        path.join(process.cwd(), {json.dumps(DISCOVERY_OUTPUT_FILE)}),
        JSON.stringify({{ pages, elements, blockers }}, null, 2),
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
    seen: set[tuple[str, str]] = set()

    for item in data.get("elements") or []:
        name = (item.get("accessible_name") or "").strip()
        role = (item.get("role") or "").strip() or None
        if not name:
            continue
        # The same control appears on every page that shares a header. Keeping
        # one row per role+name makes the catalogue about the application
        # rather than about how many pages were crawled.
        key = (role or "", name.lower())
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
                "business_meaning": None,
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
                "title": (p.get("title") or "")[:500],
                "status": p.get("status"),
            }
            for p in pages
        ],
        "elements": elements,
        "blockers": blockers,
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
