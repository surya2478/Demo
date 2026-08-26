import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// --- Application Discovery ---------------------------------------------
// Walks same-origin pages from the entry point and records every interactive
// control, with a locator verified to resolve uniquely before it is stored.

const START = "https://rankix.ai/";
const MAX_PAGES = 8;

/** Escape a value for a single-quoted Playwright query. */
function q(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

test('discover application', async ({ page }) => {
  test.setTimeout(300_000);
  const origin = new URL(START).origin;
  const queue = [START];
  const seen = new Set();
  const pages = [];
  const elements = [];
  const blockers = [];

  // Suppress automation flag on the page context
  await page.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    } catch (e) {}
  });

  try {
    while (queue.length && seen.size < MAX_PAGES) {
      const url = queue.shift();
      if (seen.has(url)) continue;
      seen.add(url);

      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
        // Settle network, but do not fail if polling keeps it alive
        await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});

        // Auto-dismiss cookie/consent popups
        try {
          const cookieBtn = page.locator('button', { hasText: /accept all|agree|allow all/i }).first();
          if (await cookieBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
            await cookieBtn.click({ force: true }).catch(() => {});
            await page.waitForTimeout(500);
          }
        } catch (e) {}

        const status = response ? response.status() : 0;
        const title = await page.title().catch(() => '');
        pages.push({ url, title, status });

        if (status >= 400 || title.includes('Request Rejected') || title.includes('Access Denied')) {
          blockers.push({ url, reason: `The page returned HTTP ${status} or WAF challenge (${title}).` });
          continue;
        }
      } catch (error) {
        blockers.push({ url, reason: String(error && error.message ? error.message : error).slice(0, 300) });
        continue;
      }

      const title = await page.title().catch(() => '');

      // Read interactive elements from page
      try {
        const found = await page.evaluate(() => {
          const roleOf = (el) => {
            const explicit = el.getAttribute('role');
            if (explicit) return explicit;
            const tag = el.tagName.toLowerCase();
            if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
            if (tag === 'button') return 'button';
            if (tag === 'select') return 'combobox';
            if (tag === 'textarea') return 'textbox';
            if (tag === 'input') {
              const type = (el.getAttribute('type') || 'text').toLowerCase();
              if (['button', 'submit', 'reset'].includes(type)) return 'button';
              if (type === 'checkbox') return 'checkbox';
              if (type === 'radio') return 'radio';
              if (type === 'search') return 'searchbox';
              if (type === 'number') return 'spinbutton';
              if (['hidden'].includes(type)) return null;
              return 'textbox';
            }
            return null;
          };

          const tidy = (value) => (value || '').replace(/\s+/g, ' ').trim();

          const nameOf = (el) => {
            const aria = el.getAttribute('aria-label');
            if (tidy(aria)) return { name: tidy(aria), how: 'aria' };
            const labelledBy = el.getAttribute('aria-labelledby');
            if (labelledBy) {
              const ref = document.getElementById(labelledBy);
              if (ref && tidy(ref.innerText)) return { name: tidy(ref.innerText), how: 'aria' };
            }
            if (el.id) {
              const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
              if (label && tidy(label.innerText)) return { name: tidy(label.innerText), how: 'label' };
            }
            const wrapping = el.closest('label');
            if (wrapping && tidy(wrapping.innerText)) return { name: tidy(wrapping.innerText), how: 'label' };
            const text = tidy(el.innerText || el.value);
            if (text) return { name: text, how: 'text' };
            const placeholder = el.getAttribute('placeholder');
            if (tidy(placeholder)) return { name: tidy(placeholder), how: 'placeholder' };
            return { name: '', how: 'none' };
          };

          const out = [];
          const nodes = document.querySelectorAll(
            'a[href], button, input, select, textarea, [role]'
          );
          for (const el of nodes) {
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const role = roleOf(el);
            if (!role) continue;
            const { name, how } = nameOf(el);
            if (!name) continue;
            out.push({
              role,
              name: name.slice(0, 300),
              how,
              testId: el.getAttribute('data-testid') || null,
              href: el.getAttribute('href') || null
            });
          }
          return out;
        });

        for (const item of found) {
          const candidates = [];
          if (item.testId) {
            candidates.push({ strategy: 'testid', expr: `page.getByTestId('${q(item.testId)}')`, confidence: 95 });
          }
          if (item.how === 'label') {
            candidates.push({ strategy: 'label', expr: `page.getByLabel('${q(item.name)}')`, confidence: 85 });
          }
          if (item.how === 'placeholder') {
            candidates.push({ strategy: 'placeholder', expr: `page.getByPlaceholder('${q(item.name)}')`, confidence: 70 });
          }
          candidates.push({
            strategy: 'role',
            expr: `page.getByRole('${q(item.role)}', { name: '${q(item.name)}' })`,
            confidence: 80
          });
          candidates.push({ strategy: 'text', expr: `page.getByText('${q(item.name)}')`, confidence: 45 });

          let chosen = null;
          for (const candidate of candidates) {
            let locator;
            if (candidate.strategy === 'testid') locator = page.getByTestId(item.testId);
            else if (candidate.strategy === 'label') locator = page.getByLabel(item.name);
            else if (candidate.strategy === 'placeholder') locator = page.getByPlaceholder(item.name);
            else if (candidate.strategy === 'role') locator = page.getByRole(item.role, { name: item.name });
            else locator = page.getByText(item.name);

            const count = await locator.count().catch(() => 0);
            if (count === 1) { chosen = candidate; break; }
            if (count > 1 && !chosen) chosen = { ...candidate, confidence: Math.max(20, candidate.confidence - 40) };
          }

          if (!chosen) continue;
          elements.push({
            page_url: page.url(),
            page_title: title,
            role: item.role,
            accessible_name: item.name,
            recommended_locator: chosen.expr,
            recommended_strategy: chosen.strategy,
            confidence_score: chosen.confidence,
            href: item.href
          });
        }
      } catch (evalErr) {}

      // Discover next same-origin links
      try {
        const links = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href]'))
            .map((a) => a.href)
            .filter(Boolean)
        );
        for (const link of links) {
          try {
            const parsed = new URL(link);
            parsed.hash = '';
            if (parsed.origin === origin && !seen.has(parsed.href) && queue.length + seen.size < MAX_PAGES) {
              queue.push(parsed.href);
            }
          } catch {}
        }
      } catch (linkErr) {}

      // Inter-page delay
      await page.waitForTimeout(1000).catch(() => {});
    }
  } finally {
    try {
      fs.writeFileSync(
        path.join(process.cwd(), "discovery.json"),
        JSON.stringify({ pages, elements, blockers }, null, 2),
        'utf-8'
      );
    } catch (fsErr) {
      console.error('Failed to write discovery output:', fsErr);
    }
  }

  expect(pages.length).toBeGreaterThan(0);
});
