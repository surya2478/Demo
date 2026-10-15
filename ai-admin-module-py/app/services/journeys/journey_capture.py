"""
--- Browser capture: a walk without Playwright -----------------------------------------

Where Playwright cannot run (an enterprise desktop or network that blocks the
automated browser), the walk's browser half can be done by a person in their
own browser: the capture tool (snippet_js, run as a bookmarklet or from the
DevTools console) records each page they open -- every interactive element
and every heading, column header, dialog title and message, each with a
selector checked to match exactly one element -- plus any element they pick
and name. It downloads a zip; uploaded here against a journey, the zip becomes
the same output a walk writes (steps, sweep, pages, routes), so
journey_crawl.evaluate, the walk review, propose and Generate flow run
unchanged and the Journey Map links the journey to its flow as before.

The selectors come from the walk's own sweepPage and uniqueXPath, cut out of
journey_crawl's spec, so a captured selector is the same string a walk would
have kept for that element.

Nothing typed is captured: names come from labels, text and attributes, never
from an input's value, and URL parameters that look like tokens are redacted.

Also read: the "page object" layout other teams use (journey.json with
steps -> pageId, pages/*.json with elements[].locator {xpath, css, text}),
so a capture made with that helper imports too.
"""
from __future__ import annotations

import io
import json
import re
import zipfile
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from ...models.kb_changes import KbCrawlRun
from . import crawl_runs, journey_crawl

SOURCE = "capture"
FORMAT = "kb-capture/1"
MAX_BYTES = 20 * 1024 * 1024
MAX_FILES = 300
MAX_PAGES = 120
MAX_ELEMENTS = 400


class CaptureError(ValueError):
    """An upload that cannot be read as a capture."""


# --- The capture tool ----------------------------------------------------------------------

def _js_function(name: str) -> str:
    """A top-level function from the walk's spec, verbatim."""
    match = re.search(rf"^function {name}\(.*?^}}\n", journey_crawl._SPEC, re.S | re.M)
    if not match:
        raise RuntimeError(f"journey_crawl's spec has no function {name}")
    return match.group(0)


RECEIVER_PLACEHOLDER = "__KB_RECEIVER__"
# Bump when the tool changes: a newer bookmark then replaces an older panel on the page.
TOOL_VERSION = "3"


def snippet_js(receiver: Optional[str] = None) -> str:
    """The capture tool, self-contained, for a bookmarklet or the DevTools console.

    `receiver`: the app's receiving page (an http(s) URL) that Send to
    Knowledge Base opens; without it the placeholder stays and the page that
    hands out the tool fills in its own address.
    """
    if receiver and not re.match(r"^https?://[^\s'\\<>]+$", receiver):
        raise CaptureError("The receiving page must be an http(s) address.")
    return (
        _SNIPPET.replace(RECEIVER_PLACEHOLDER, receiver or RECEIVER_PLACEHOLDER)
        .replace("__UNIQUE_XPATH__", _js_function("uniqueXPath"))
        .replace("__SWEEP_PAGE__", _js_function("sweepPage"))
        .replace("__FORMAT__", FORMAT)
        .replace("__TOOL_VERSION__", TOOL_VERSION)
    )


_SNIPPET = r"""(() => {
// Knowledge Base capture tool (__FORMAT__). Records what pages show -- never what is typed.
// Clicked again: re-open this version's panel. An older version already on
// the page (its bookmark made before this one) is replaced, so the new
// buttons show without reloading; what it captured is kept (localStorage).
const VERSION = '__TOOL_VERSION__';
if (window.__kbCaptureOpen && window.__kbCaptureVersion === VERSION) { window.__kbCaptureOpen(); return; }
if (window.__kbCaptureClose) { try { window.__kbCaptureClose(); } catch (e) { /* an older tool */ } }
{ const old = document.getElementById('kb-capture-host'); if (old) old.remove(); }
__UNIQUE_XPATH__
__SWEEP_PAGE__
const KEY = '__kbCapture';
const SECRET = /token|code|session|auth|key|pass|pwd|secret|sig|otp/i;
const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n || 120);
const cleanUrl = (u) => {
  try { const x = new URL(u); x.hash = ''; for (const k of Array.from(x.searchParams.keys())) if (SECRET.test(k)) x.searchParams.set(k, 'redacted'); return x.toString(); }
  catch (e) { return String(u || ''); }
};
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } };
const fresh = () => ({ format: '__FORMAT__', started_at: new Date().toISOString(), host: location.host, pages: [] });
let state = load() || fresh();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { alert('The capture could not be kept in this browser: ' + e.message); } };
const visible = (el) => { const b = el.getBoundingClientRect(); const s = getComputedStyle(el); return b.width >= 2 && b.height >= 2 && s.visibility !== 'hidden' && s.display !== 'none'; };
// What a test checks rather than clicks: headings, column headers, labels, dialog titles, messages.
const TEXT_SEL = 'h1,h2,h3,h4,h5,h6,[role=heading],th,[role=columnheader],caption,legend,label,.modal-title,[role=dialog] [class*=title],[role=alert],[role=status],[aria-live=polite],[aria-live=assertive]';
const textRole = (el) => {
  const t = el.tagName.toLowerCase();
  const r = el.getAttribute('role');
  if (r) return r;
  if (/^h[1-6]$/.test(t)) return 'heading';
  if (t === 'th') return 'columnheader';
  if (t === 'label' || t === 'legend' || t === 'caption') return t;
  return 'text';
};
const sweepText = () => {
  const out = []; const seen = new Set();
  for (const el of document.querySelectorAll(TEXT_SEL)) {
    if (out.length >= 150) break;
    if (el.closest('#kb-capture-host') || !visible(el)) continue;
    const name = clean(el.innerText, 120);
    if (!name) continue;
    const selector = uniqueXPath(el);
    if (!selector || seen.has(selector)) continue;
    seen.add(selector);
    out.push({ role: textRole(el), name, tag: el.tagName.toLowerCase(), selector, kind: 'text' });
  }
  return out;
};
// Cards, menu rows and tiles a site builds from plain boxes with a click
// handler in code (Angular, React): no link, button, role or onclick for the
// walk's sweep to see, but the page shows them with a pointer cursor. The
// outermost such box is the control (cursor is inherited by its contents).
const SKIP_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'option', 'label', 'svg', 'path', 'img', 'html', 'body', 'script', 'style']);
const sweepClickables = (known) => {
  const out = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (out.length >= 150) break;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag) || el.closest('#kb-capture-host')) continue;
    let style; try { style = getComputedStyle(el); } catch (e) { continue; }
    if (style.cursor !== 'pointer' || !visible(el)) continue;
    const parent = el.parentElement;
    if (parent && parent !== document.body && getComputedStyle(parent).cursor === 'pointer') continue;
    if (el.querySelector('a,button,input,select,textarea')) continue;
    const lines = String(el.innerText || '').split('\n').map((x) => clean(x, 80)).filter(Boolean);
    const name = lines[0] || clean(el.getAttribute('aria-label') || el.getAttribute('title'), 80);
    if (!name) continue;
    const selector = uniqueXPath(el);
    if (!selector || known.has(selector)) continue;
    known.add(selector);
    out.push({ role: 'clickable', name, text: clean(lines.join(' '), 160), tag, selector, kind: 'control', chrome: false });
  }
  return out;
};
const pathOf = () => location.pathname.replace(/\/+$/, '') || '/';
const slug = (s) => clean(s, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page';
const current = () => state.pages.length ? state.pages[state.pages.length - 1] : null;
const capturePage = (name) => {
  const label = clean(name || document.title || pathOf(), 80);
  const controls = sweepPage().map((e) => ({ ...e, kind: 'control' }));
  const clickables = sweepClickables(new Set(controls.map((e) => e.selector)));
  const page = {
    page_id: `${String(state.pages.length + 1).padStart(2, '0')}-${slug(label)}`, name: label,
    url: cleanUrl(location.href), title: clean(document.title, 120), captured_at: new Date().toISOString(),
    elements: controls.concat(clickables, sweepText()), picked: [],
  };
  state.pages.push(page); save(); render(`Captured "${page.name}": ${page.elements.length} elements.`);
  return page;
};
const ACTION = (el) => {
  const t = el.tagName.toLowerCase(); const ty = (el.getAttribute('type') || '').toLowerCase(); const r = el.getAttribute('role') || '';
  if (t === 'select' || r === 'combobox') return 'select';
  if ((t === 'input' && !['submit', 'button', 'reset', 'image', 'checkbox', 'radio'].includes(ty)) || t === 'textarea') return 'fill';
  if (t === 'a' || t === 'button' || ['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch'].includes(r) || ty === 'checkbox' || ty === 'radio') return 'click';
  return 'assert';
};
const alternates = (el) => {
  const out = [];
  for (const a of ['data-testid', 'data-test', 'id']) { const v = el.getAttribute(a); if (v && !v.includes('"')) out.push(a === 'id' ? `#${CSS.escape(v)}` : `[${a}="${v}"]`); }
  return out;
};
let picking = false; let box = null;
const onMove = (e) => {
  if (!picking || !box) return;
  const el = e.target; if (!el || el.closest('#kb-capture-host')) { box.style.display = 'none'; return; }
  const r = el.getBoundingClientRect();
  Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
};
const onClick = (e) => {
  if (!picking) return;
  const el = e.target; if (!el || el.closest('#kb-capture-host')) return;
  e.preventDefault(); e.stopPropagation();
  const suggested = clean(el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title'), 60);
  const name = window.prompt('Name this element (what the journey calls it):', suggested);
  if (name === null) return;
  const selector = uniqueXPath(el);
  if (!selector) { alert('No selector matches only this element. Pick the element around it, or capture the page instead.'); return; }
  const chosen = ui.querySelector('#kb-action').value;
  let page = current();
  if (!page || page.url !== cleanUrl(location.href)) page = capturePage();
  page.picked.push({ name: clean(name, 80), text: suggested, role: el.getAttribute('role') || el.tagName.toLowerCase(), tag: el.tagName.toLowerCase(),
                     selector, alternates: alternates(el), action: chosen === 'auto' ? ACTION(el) : chosen });
  save(); render(`Picked "${clean(name, 60)}" on ${page.name}.`);
};
const setPicking = (on) => {
  picking = on;
  if (on && !box) { box = document.createElement('div'); Object.assign(box.style, { position: 'fixed', zIndex: 2147483646, pointerEvents: 'none', border: '2px solid #B71920', background: 'rgba(183,25,32,.08)', display: 'none' }); document.body.appendChild(box); }
  if (!on && box) box.style.display = 'none';
  render(on ? 'Click an element to name it. Press "Stop picking" when done.' : '');
};
document.addEventListener('mousemove', onMove, true);
document.addEventListener('click', onClick, true);
// A tiny zip writer (stored, not compressed): manifest.json + pages/<id>.json.
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const zip = (files) => {
  const enc = new TextEncoder(); const parts = []; const central = []; let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name); const data = enc.encode(f.text); const crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(12, 0x21, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
    parts.push(h.buffer, name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(c.buffer, name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((n, p) => n + p.byteLength, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, size, true); e.setUint32(16, offset, true);
  return new Blob(parts.concat(central, [e.buffer]), { type: 'application/zip' });
};
// Send to Knowledge Base: open the app's receiving page and hand it the
// capture with postMessage, only ever to that page's own origin. The page
// asks the person to save it, then answers with the inbox id.
const RECEIVER = '__KB_RECEIVER__';
const payload = () => ({ format: '__FORMAT__', host: state.host, started_at: state.started_at, finished_at: new Date().toISOString(),
                         name: clean(ui.querySelector('#kb-name').value, 120) || '', pages: state.pages });
let receiver = null; let sendId = null;
window.addEventListener('message', (e) => {
  if (!receiver || e.origin !== receiver.origin || !e.data || typeof e.data !== 'object') return;
  if (e.data.type === 'kb-capture-ready' && receiver.win && !receiver.win.closed) {
    receiver.win.postMessage({ type: 'kb-capture', id: sendId, capture: payload() }, receiver.origin);
    render('Sent. Check it in the Knowledge Base tab and press Save to inbox.');
  } else if (e.data.type === 'kb-capture-saved' && e.data.id === sendId) {
    render(`Saved in the Knowledge Base inbox as capture #${e.data.capture_id}. Start over for the next journey.`);
  } else if (e.data.type === 'kb-capture-cancelled' && e.data.id === sendId) {
    render('Not saved: cancelled in the Knowledge Base tab.');
  }
});
const send = () => {
  if (!state.pages.length) { alert('Nothing captured yet.'); return; }
  if (!/^https?:\/\//.test(RECEIVER)) { alert('This copy of the tool does not know your Knowledge Base address. Start it from the Knowledge Base page (Crawl > Capture), or use Download zip.'); return; }
  sendId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const win = window.open(RECEIVER, 'kb-capture-receiver');
  if (!win) { render('The browser blocked the Knowledge Base tab: allow pop-ups for this site, or use Download zip.'); return; }
  receiver = { win, origin: new URL(RECEIVER).origin };
  render('Opening the Knowledge Base… sign in there if it asks.');
};
const download = () => {
  if (!state.pages.length) { alert('Nothing captured yet.'); return; }
  const files = state.pages.map((p) => ({ name: `pages/${p.page_id}.json`, text: JSON.stringify(p, null, 2) }));
  const manifest = { format: '__FORMAT__', started_at: state.started_at, finished_at: new Date().toISOString(), host: state.host,
                     user_agent: navigator.userAgent, pages: state.pages.map((p) => ({ file: `pages/${p.page_id}.json`, page_id: p.page_id, name: p.name, url: p.url })) };
  files.unshift({ name: 'manifest.json', text: JSON.stringify(manifest, null, 2) });
  const a = document.createElement('a'); a.href = URL.createObjectURL(zip(files));
  a.download = `capture-${slug(state.host)}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.zip`;
  document.body.appendChild(a); a.click(); a.remove();
  render(`Downloaded ${state.pages.length} page(s). Upload the zip on the Knowledge Base page (Crawl > Upload a capture).`);
};
const host = document.createElement('div'); host.id = 'kb-capture-host';
Object.assign(host.style, { position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483647 });
const ui = host.attachShadow({ mode: 'open' });
ui.innerHTML = `<style>
  .p{font:13px/1.4 system-ui,sans-serif;color:#1F2937;background:#fff;border:1px solid #E8EAEE;border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:12px;width:290px}
  .h{display:flex;justify-content:space-between;align-items:center;font-weight:700;margin-bottom:8px} .x{cursor:pointer;border:0;background:none;font-size:16px}
  input,select{width:100%;box-sizing:border-box;height:30px;border:1px solid #E8EAEE;border-radius:8px;padding:0 8px;margin:4px 0}
  .r{display:flex;gap:6px;margin-top:6px} button.b{flex:1;height:32px;border-radius:9px;border:1px solid #E8EAEE;background:#fff;font-weight:700;cursor:pointer}
  label.a{display:flex;gap:6px;align-items:center;font-size:12px;margin-top:6px;cursor:pointer} label.a input{width:auto;height:auto;margin:0}
  button.m{background:#B71920;color:#fff;border-color:#B71920} .s{margin-top:8px;color:#4B5563;font-size:12px} .n{color:#6B7280;font-size:11.5px;margin-top:6px}
</style><div class="p"><div class="h"><span>KB capture</span><button class="x" id="kb-close" title="Hide">×</button></div>
  <input id="kb-name" placeholder="Page name (default: the page title)">
  <div class="r"><button class="b m" id="kb-capture">Capture page</button><button class="b" id="kb-pick">Pick element</button></div>
  <select id="kb-action" title="What a test does with the next picked element"><option value="auto">Picked element: guess the action</option><option value="click">click</option><option value="fill">fill</option><option value="select">select</option><option value="assert">check (assert)</option></select>
  <label class="a"><input type="checkbox" id="kb-auto"> Capture each page automatically as I go</label>
  <div class="r"><button class="b m" id="kb-send" title="Opens the Knowledge Base in a new tab with this capture">Send to Knowledge Base</button></div>
  <div class="r"><button class="b" id="kb-zip">Download zip</button><button class="b" id="kb-clear">Start over</button></div>
  <div class="s" id="kb-status"></div><div class="n">Nothing you type is recorded. Open each page of the journey (and each dialog), then Capture page.</div></div>`;
const render = (msg) => {
  const n = state.pages.length; const picks = state.pages.reduce((k, p) => k + p.picked.length, 0);
  ui.querySelector('#kb-status').textContent = `${msg ? msg + ' ' : ''}${n} page(s), ${picks} picked so far.`;
  ui.querySelector('#kb-pick').textContent = picking ? 'Stop picking' : 'Pick element';
};
ui.querySelector('#kb-capture').onclick = () => { capturePage(ui.querySelector('#kb-name').value); ui.querySelector('#kb-name').value = ''; };
ui.querySelector('#kb-pick').onclick = () => setPicking(!picking);
ui.querySelector('#kb-zip').onclick = download;
ui.querySelector('#kb-send').onclick = send;
// Auto-capture: when the address changes (a new page, or a single-page app's
// route), wait for it to settle and capture it. Kept on across page loads:
// click the bookmark again on the next page and it carries on.
let autoUrl = null; let autoWait = null;
const autoTick = () => {
  if (!state.auto || !document.body.contains(host)) return;
  const url = cleanUrl(location.href);
  if (url === autoUrl) return;
  autoUrl = url; clearTimeout(autoWait);
  autoWait = setTimeout(() => {
    const cur = current();
    if (cleanUrl(location.href) === url && (!cur || cur.url !== url)) capturePage();
  }, 1500);
};
const autoTimer = setInterval(autoTick, 700);
ui.querySelector('#kb-auto').checked = !!state.auto;
ui.querySelector('#kb-auto').onchange = (e) => {
  state.auto = e.target.checked; save(); autoUrl = null;
  render(state.auto ? 'Capturing each page you open. Dialogs: press Capture page.' : 'Auto-capture off.');
};
ui.querySelector('#kb-clear').onclick = () => { if (confirm('Discard everything captured so far?')) { state = fresh(); save(); render('Started over.'); } };
ui.querySelector('#kb-close').onclick = () => { setPicking(false); host.style.display = 'none'; };
window.__kbCaptureOpen = () => { host.style.display = 'block'; render(''); };
window.__kbCaptureVersion = VERSION;
window.__kbCaptureClose = () => {
  clearInterval(autoTimer); clearTimeout(autoWait);
  setPicking(false);
  document.removeEventListener('mousemove', onMove, true);
  document.removeEventListener('click', onClick, true);
  host.remove();
};
document.body.appendChild(host);
render(state.auto ? 'Auto-capture is on: capturing each page you open.'
  : state.pages.length ? 'Continuing the capture started earlier.' : 'Open a page of the journey and press Capture page.');
})();
"""


# --- Reading an upload ---------------------------------------------------------------------

def _text(value: Any, limit: int = 200) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def _element(raw: Dict[str, Any], *, picked: bool = False) -> Optional[Dict[str, Any]]:
    """One captured element in the walk's shape: role, name, tag, selector, chrome."""
    locator = raw.get("locator") if isinstance(raw.get("locator"), dict) else {}
    selector = _text(raw.get("selector") or locator.get("xpath") or locator.get("css"), 1000)
    if not selector:
        return None
    alternates = [s for s in [*(raw.get("alternates") or []), locator.get("css"), locator.get("xpath")]
                  if isinstance(s, str) and s.strip() and s.strip() != selector]
    name = _text(raw.get("name") or raw.get("text") or locator.get("text"), 120)
    actions = raw.get("actions") if isinstance(raw.get("actions"), list) else []
    bounds = raw.get("bounds") if isinstance(raw.get("bounds"), dict) else {}
    clean_bounds = None
    try:
        clean_bounds = {
            "x": max(0, min(int(bounds.get("x", 0)), 10000)),
            "y": max(0, min(int(bounds.get("y", 0)), 10000)),
            "width": max(2, min(int(bounds.get("width", 2)), 10000)),
            "height": max(2, min(int(bounds.get("height", 2)), 10000)),
        } if bounds else None
    except (TypeError, ValueError):
        clean_bounds = None
    return {
        "role": _text(raw.get("role") or raw.get("type") or raw.get("tagName"), 40).lower() or None,
        "name": name, "text": _text(raw.get("text") or locator.get("text"), 120) or None,
        "tag": _text(raw.get("tag") or raw.get("tagName"), 20).lower() or None,
        "selector": selector, "alternates": list(dict.fromkeys(alternates))[:4],
        "chrome": bool(raw.get("chrome")), "kind": raw.get("kind") or ("picked" if picked else "control"),
        "picked": picked, "action": _text(raw.get("action") or (actions[0] if actions else ""), 20).lower() or None,
        "assertions": [a for a in (raw.get("assertions") or []) if isinstance(a, str)][:6],
        "bounds": clean_bounds,
    }


def _page(raw: Dict[str, Any], fallback_id: str) -> Dict[str, Any]:
    elements = [e for e in (_element(x) for x in (raw.get("elements") or []) if isinstance(x, dict)) if e]
    picked = [e for e in (_element(x, picked=True) for x in (raw.get("picked") or []) if isinstance(x, dict)) if e]
    if not picked:
        # The page-object layout names every element it lists: they were all chosen by a person.
        named = [e for e in elements if e["name"] and raw.get("pageId")]
        for e in named:
            e["picked"] = True
    viewport = raw.get("viewport") if isinstance(raw.get("viewport"), dict) else {}
    try:
        clean_viewport = {
            "width": max(320, min(int(viewport.get("width", 1366)), 4096)),
            "height": max(240, min(int(viewport.get("height", 768)), 4096)),
        }
    except (TypeError, ValueError):
        clean_viewport = {"width": 1366, "height": 768}
    return {
        "page_id": _text(raw.get("page_id") or raw.get("pageId") or fallback_id, 120),
        "name": _text(raw.get("name") or raw.get("title") or raw.get("pageId"), 120),
        "url": _text(raw.get("url"), 1000) or None,
        "title": _text(raw.get("title"), 200) or None,
        "captured_at": raw.get("captured_at"),
        "screen_id": _text(raw.get("screen_id") or raw.get("screen"), 120) or None,
        "viewport": clean_viewport,
        "elements": (elements + picked)[:MAX_ELEMENTS],
    }


def _pages_from(doc: Any, fallback: str) -> List[Dict[str, Any]]:
    if isinstance(doc, list):
        return [_page(p, f"{fallback}-{i + 1}") for i, p in enumerate(doc) if isinstance(p, dict)]
    if isinstance(doc, dict):
        if isinstance(doc.get("pages"), list):
            return _pages_from(doc["pages"], fallback)
        if "elements" in doc or "picked" in doc:
            return [_page(doc, fallback)]
    return []


def read_bundle(filename: str, data: bytes) -> Dict[str, Any]:
    """{manifest, journey, pages, notes} from a capture zip or a single JSON file."""
    if len(data) > MAX_BYTES:
        raise CaptureError(f"The capture is larger than {MAX_BYTES // (1024 * 1024)} MB.")
    notes: List[str] = []
    manifest: Dict[str, Any] = {}
    journey: Dict[str, Any] = {}
    pages: List[Dict[str, Any]] = []
    if (filename or "").lower().endswith(".json"):
        try:
            doc = json.loads(data.decode("utf-8-sig"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise CaptureError(f"{filename} is not JSON: {exc}") from exc
        if isinstance(doc, dict) and isinstance(doc.get("manifest"), dict):
            manifest = doc["manifest"]
        pages = _pages_from(doc, "page")
    else:
        try:
            archive = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile as exc:
            raise CaptureError("The upload is neither a zip nor a .json file.") from exc
        names = [n for n in archive.namelist() if not n.endswith("/") and "__MACOSX" not in n]
        if len(names) > MAX_FILES:
            raise CaptureError(f"The zip holds more than {MAX_FILES} files.")
        docs: Dict[str, Any] = {}
        for name in sorted(names):
            info = archive.getinfo(name)
            if info.file_size > 5 * 1024 * 1024:
                notes.append(f"{name} is over 5 MB and was skipped.")
                continue
            if name.lower().endswith(".json"):
                try:
                    docs[name] = json.loads(archive.read(name).decode("utf-8-sig"))
                except (UnicodeDecodeError, ValueError):
                    notes.append(f"{name} is not valid JSON and was skipped.")
            elif name.lower().endswith((".html", ".htm")):
                notes.append(f"{name}: saved pages are not read yet; capture that page with the capture tool.")
        base = lambda n: n.rsplit("/", 1)[-1].lower()  # noqa: E731
        manifest_name = next((n for n in docs if base(n) == "manifest.json"), None)
        journey_name = next((n for n in docs if base(n) == "journey.json"), None)
        manifest = docs.pop(manifest_name) if manifest_name else {}
        journey = docs.pop(journey_name) if journey_name else {}
        order = [p.get("file") for p in (manifest.get("pages") or []) if isinstance(p, dict) and p.get("file")]
        ordered = [n for n in order if n in docs] + [n for n in docs if n not in order]
        for name in ordered:
            stem = base(name).rsplit(".", 1)[0]
            pages.extend(_pages_from(docs[name], stem))
    pages = [p for p in pages if p["elements"]]
    if not pages:
        raise CaptureError("No captured page with elements was found in the upload.")
    if len(pages) > MAX_PAGES:
        notes.append(f"Only the first {MAX_PAGES} pages were read.")
        pages = pages[:MAX_PAGES]
    # The page-object layout's journey.json orders the pages. Its step numbers
    # are its own, not the Journey KB's, so which screen a page is still comes
    # from what is on it (assign_screens).
    if isinstance(journey.get("steps"), list):
        order = [s.get("pageId") for s in journey["steps"] if isinstance(s, dict) and s.get("pageId")]
        rank = {page_id: i for i, page_id in enumerate(dict.fromkeys(order))}
        pages.sort(key=lambda page: rank.get(page["page_id"], len(rank)))
    return {"manifest": manifest if isinstance(manifest, dict) else {}, "journey": journey, "pages": pages, "notes": notes}


# --- Matching the capture to the journey ---------------------------------------------------

def _norm(text: Optional[str]) -> str:
    return journey_crawl._norm(text)


def _words(text: Optional[str]) -> set:
    return journey_crawl._words(text)


def _labels(el: Dict[str, Any]) -> List[str]:
    out = [el.get("clean_label"), el.get("label"), *(el.get("aliases") or []), *(el.get("accepted_labels") or [])]
    return [n for n in dict.fromkeys(_norm(x) for x in out if x) if n]


def _name_score(names: List[str], labels: List[str]) -> float:
    best = 0.0
    for name in names:
        if not name:
            continue
        for label in labels:
            if name == label:
                return 3.0
            if len(label) >= 3 and len(name) >= 3 and (label in name or name in label):
                best = max(best, 2.0)
            else:
                a, b = _words(name), _words(label)
                if a and b:
                    overlap = len(a & b) / len(a | b)
                    if overlap >= 0.5:
                        best = max(best, 1.0 + overlap / 2)
    return best


def _literals(selector: Optional[str]) -> List[str]:
    return [_norm(s) for s in re.findall(r"'([^']+)'", selector or "") if s.strip()]


def match_element(el: Dict[str, Any], page: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The captured element that is this design element, with how it was found, or None."""
    kb_target = el.get("kb_target")
    if kb_target:
        for e in page["elements"]:
            if kb_target == e["selector"] or kb_target in e["alternates"]:
                return {**e, "strategy": "kb", "ambiguous": False}
    labels = _labels(el)
    if not labels:
        return None
    roles = set((el.get("hint") or {}).get("roles") or [])
    scored: List[Tuple[float, Dict[str, Any]]] = []
    for e in page["elements"]:
        score = _name_score([_norm(e["name"]), _norm(e.get("text"))], labels)
        if not score:
            continue
        if e["picked"]:
            score += 0.5
        if roles and e.get("role") in roles:
            score += 0.5
        if el.get("is_input") and e.get("role") in ("textbox", "combobox", "password", "searchbox"):
            score += 0.5
        if el.get("type") == "heading" and e.get("kind") == "text":
            score += 0.3
        scored.append((score, e))
    if not scored:
        return None
    scored.sort(key=lambda pair: -pair[0])
    top, best = scored[0]
    ambiguous = sum(1 for s, e in scored if s == top and e["selector"] != best["selector"]) > 0
    # The Automation KB's own selector, by the label it names: still right.
    literals = _literals(kb_target)
    found = _norm(" ".join(filter(None, [best["name"], best.get("text")])))
    strategy = "kb" if kb_target and literals and all(l in found for l in literals) else ("picked" if best["picked"] else "capture")
    return {**best, "strategy": strategy, "selector": kb_target if strategy == "kb" else best["selector"], "ambiguous": ambiguous}


def _path(url: Optional[str]) -> Optional[str]:
    match = re.match(r"https?://[^/?#]+([^?#]*)", url or "")
    return ((match.group(1) if match else "").rstrip("/") or "/") if url else None


def assign_screens(plan: Dict[str, Any], pages: List[Dict[str, Any]]) -> Dict[int, Optional[str]]:
    """page index -> screen id: the page's own screen, else the journey screen it shows most of."""
    screens = plan.get("screens") or {}
    signatures = plan.get("signatures") or {}
    out: Dict[int, Optional[str]] = {}
    for index, page in enumerate(pages):
        if page.get("screen_id") in screens:
            out[index] = page["screen_id"]
            continue
        if page.get("screen_id") == NO_SCREEN:
            out[index] = None  # the reviewer said this page is no screen of the journey
            continue
        best, best_score = None, 0.0
        for sid, elements in screens.items():
            sig = signatures.get(sid) or {}
            score = 0.0
            if sig.get("route") and _path(page.get("url")) == sig["route"].rstrip("/"):
                score += 5
            if sig.get("name") and _norm(sig["name"]) in (_norm(page.get("title")), _norm(page.get("name"))):
                score += 2
            names = [_norm(e["name"]) for e in page["elements"]]
            for el in elements:
                if _name_score(names, _labels(el)) >= 2:
                    score += 1
            if score > best_score:
                best, best_score = sid, score
        out[index] = best if best_score >= 1 else None
    return out


def build_output(plan: Dict[str, Any], pages: List[Dict[str, Any]], assignment: Dict[int, Optional[str]],
                 overrides: Optional[Dict[int, Tuple[int, str]]] = None) -> Dict[str, Any]:
    """What a walk of this plan would have written, from the captured pages.

    `overrides`: step number -> (page index, selector) the reviewer chose for
    that step's element in the flow view; it wins over matching by label.
    """
    overrides = overrides or {}
    by_screen: Dict[str, List[int]] = {}
    for index, sid in assignment.items():
        if sid:
            by_screen.setdefault(sid, []).append(index)

    def find(el: Dict[str, Any], indexes: List[int]) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
        for i in indexes:
            hit = match_element(el, pages[i])
            if hit:
                return hit, pages[i]
        return None, (pages[indexes[0]] if indexes else None)

    def record(el: Dict[str, Any], hit: Optional[Dict[str, Any]], page: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        base = {"screen_id": el["screen_id"], "element_id": el["element_id"], "tried": [], "url": (page or {}).get("url"),
                "page_id": (page or {}).get("page_id")}
        if not hit:
            return {**base, "found": False}
        return {**base, "found": True, "strategy": hit["strategy"], "count": 1, "ambiguous": bool(hit["ambiguous"]),
                "selector": hit["selector"], "tag": hit.get("tag"), "role": hit.get("role") or "", "app_label": hit["name"]}

    sweep = []
    for sid, indexes in by_screen.items():
        for el in (plan.get("screens") or {}).get(sid, []):
            hit, page = find(el, indexes)
            sweep.append(record(el, hit, page))

    steps = []
    # Steps without a screen of their own (recorded ones) are looked for in
    # page order: a step that leads to a page is on a page captured before it,
    # and nothing after it is earlier than the page it reached. Without this,
    # a "click here" on the dashboard answered the sign-in page's CLICK HERE.
    paths = [_path(p.get("url")) for p in pages]
    floor = 0
    for order, item in enumerate(plan.get("items", []), start=1):
        out = {"order": order, "journey_id": item.get("journey_id"), "step_number": item.get("step_number"),
               "kind": item.get("kind"), "screen_id": item.get("screen_id") or None}
        if item.get("kind") == "skip":
            steps.append({**out, "status": "skipped", "reason": item.get("reason")})
            continue
        sid = item.get("screen_id")
        led_to = (item.get("led_to") or "").rstrip("/") or None
        reached = next((i for i, path in enumerate(paths) if led_to and path == led_to and i >= floor), None)
        indexes = by_screen.get(sid, []) if sid else list(range(floor, reached if reached is not None else len(pages)))
        if sid and not indexes:
            name = ((plan.get("signatures") or {}).get(sid) or {}).get("name") or sid
            steps.append({**out, "status": "not_reached", "reason": f"no captured page shows {name}"})
            continue
        el = item.get("element")
        if not el:
            steps.append({**out, "status": "done", "url": pages[indexes[0]].get("url") if indexes else None})
            continue
        hit, page = find(el, indexes)
        chosen = overrides.get(item.get("step_number")) if item.get("step_number") is not None else None
        if chosen and 0 <= chosen[0] < len(pages):
            picked = next((e for e in pages[chosen[0]]["elements"] if e["selector"] == chosen[1]), None)
            if picked:
                hit, page = {**picked, "strategy": "picked", "ambiguous": False}, pages[chosen[0]]
        capture = record(el, hit, page)
        if not sid:
            if hit and page is not None:
                floor = max(floor, pages.index(page))
            if reached is not None:
                floor = max(floor, reached)
        label = el.get("clean_label") or el.get("label")
        if hit:
            status, reason = "done", None
        elif not sid and not indexes and reached is not None:
            status, reason = "not_reached", f"'{label}' is on the page before {led_to}, which was not captured"
        elif item.get("setup") and not sid:
            # A step of the journey run first (signing in): its pages are
            # usually not in a capture of this journey, which is not a miss.
            status, reason = "not_reached", f"'{label}' is on a setup page that was not captured"
        elif item.get("optional"):
            status, reason = "not_applicable", None
        else:
            status, reason = "not_found", f"'{label}' is not on the captured page"
        steps.append({**out, "status": status, "url": capture.get("url"), "capture": capture,
                      **({"reason": reason} if reason else {})})

    routes: Dict[str, str] = {}
    for sid, indexes in by_screen.items():
        path = _path(pages[indexes[0]].get("url"))
        if path and path not in routes.values():
            routes[sid] = path
    first = pages[0]
    return {
        "steps": steps, "sweep": sweep,
        "pages": [{"screen_id": assignment.get(i), "url": p.get("url"),
                   "elements": [{"role": e.get("role"), "name": e["name"], "tag": e.get("tag"), "selector": e["selector"],
                                 "chrome": e["chrome"]} for e in p["elements"]]} for i, p in enumerate(pages)],
        "blockers": [], "final_url": pages[-1].get("url"), "routes": routes, "derailed": None,
        "entry": {"address": plan.get("base_url"), "landed": first.get("url"), "screen": assignment.get(0)},
    }


# --- Importing -----------------------------------------------------------------------------

def _walk(db: Session, *, app_id: str, journey_id: str, application_id: Optional[int], environment: Optional[str],
          pages: List[Dict[str, Any]], overrides: Optional[Dict[int, Tuple[int, str]]] = None) -> Dict[str, Any]:
    """Match `pages` to the journey as a walk would: {plan, output, result, assignment, application, base_url, kb}."""
    from ...models.automation import AutomationApplication

    if (journey_id or "").startswith(crawl_runs.FLOW_PREFIX):
        raise CaptureError("A capture is matched against a journey, not a flow blueprint.")
    if not pages:
        raise CaptureError("No page is left in the capture.")
    kb = crawl_runs._kb(app_id)
    if journey_id not in kb.journeys:
        raise LookupError(f"No journey '{journey_id}'.")
    application = db.get(AutomationApplication, application_id) if application_id else None
    base_url = (application.base_url if application else "") or ""
    if application is not None and environment:
        from ..automation.registry import address_for_crawl

        base_url = address_for_crawl(db, application.app_key, environment) or base_url
    plan = crawl_runs._plan(kb, journey_id, base_url=base_url, profile_id=None, stop_before=None, allow_risky=True)
    plan["source"] = SOURCE
    assignment = assign_screens(plan, pages)
    output = build_output(plan, pages, assignment, overrides)
    result = journey_crawl.evaluate(plan, output)
    return {"plan": plan, "output": output, "result": result, "assignment": assignment,
            "application": application, "base_url": base_url, "kb": kb}


def import_capture(
    db: Session, *, app_id: str, journey_id: str, application_id: Optional[int], environment: Optional[str],
    filename: str, data: bytes, actor: Optional[str],
) -> KbCrawlRun:
    """Store an uploaded capture as a completed walk of `journey_id`, evaluated like one."""
    bundle = read_bundle(filename, data)
    return _store_walk(db, app_id=app_id, journey_id=journey_id, application_id=application_id, environment=environment,
                       pages=bundle["pages"], manifest=bundle["manifest"], notes=bundle["notes"], filename=filename,
                       fmt="page-objects" if bundle["journey"] else "json", actor=actor)


def _store_walk(db: Session, *, app_id: str, journey_id: str, application_id: Optional[int], environment: Optional[str],
                pages: List[Dict[str, Any]], manifest: Dict[str, Any], notes: List[str], filename: str, fmt: str,
                actor: Optional[str], overrides: Optional[Dict[int, Tuple[int, str]]] = None) -> KbCrawlRun:
    walk = _walk(db, app_id=app_id, journey_id=journey_id, application_id=application_id, environment=environment,
                 pages=pages, overrides=overrides)
    plan, result, assignment, application, base_url = (walk["plan"], walk["result"], walk["assignment"],
                                                       walk["application"], walk["base_url"])
    # Which journey steps each page answered. A recorded journey has no named
    # screens, so this -- not a screen -- is how its pages are used.
    used: Dict[int, List[int]] = {}
    urls = [p.get("url") for p in pages]
    for step in result.get("steps", []):
        if step.get("status") == "done" and step.get("url") in urls:
            used.setdefault(urls.index(step["url"]), []).append(step.get("step_number"))
    unassigned = [p["name"] or p["page_id"] for i, p in enumerate(pages) if not assignment.get(i) and not used.get(i)]
    result["capture"] = {
        "file": filename, "format": manifest.get("format") or fmt,
        "host": manifest.get("host"), "started_at": manifest.get("started_at"), "finished_at": manifest.get("finished_at"),
        "uploaded_by": actor, "pages": [{"page_id": p["page_id"], "name": p["name"], "url": p.get("url"),
                                         "screen_id": assignment.get(i), "steps": used.get(i, []), "elements": len(p["elements"])}
                  for i, p in enumerate(pages)],
        "notes": notes + ([f"Not used by any step of this journey: {', '.join(unassigned)}."] if unassigned else []),
    }
    crawl = KbCrawlRun(
        app_id=app_id, journey_id=journey_id, application_id=application.id if application else None,
        environment=environment or (application.environment if application else None), profile_id=None,
        base_url=base_url, run_key=None, status="completed", plan=plan, result=result,
        created_by=actor, finished_at=datetime.utcnow(),
    )
    db.add(crawl)
    db.commit()
    db.refresh(crawl)
    return crawl


# --- Straight from the tool: the captures inbox ----------------------------------------------
#
# The tool's "Send to Knowledge Base" opens the app's receiving page and hands
# it the capture with window.postMessage: no zip, and no call from the
# application's page to our backend (its Content-Security-Policy may forbid
# one, our CORS would, and it has no sign-in for us). The receiving page,
# signed in, stores it here; the Crawl stage shows it as a flow to edit and
# import as a walk.

INBOX_STATUSES = ("inbox", "imported", "discarded")
NO_SCREEN = "__none__"
EDIT_KEYS = ("order", "dropped_pages", "dropped_elements", "names", "screens", "steps")


def guess_application(db: Session, url: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    """(Knowledge Base app id, environment) whose registered address the URL is under; longest wins."""
    from ...models.automation import AutomationDataApp
    from ..automation import registry

    target = (url or "").lower()
    best: Tuple[int, Optional[str], Optional[str]] = (0, None, None)
    for app in db.query(AutomationDataApp).filter(AutomationDataApp.kb_app_id.isnot(None)).all():
        for env, address in registry.addresses(app).items():
            prefix = (address or "").lower().rstrip("/")
            if prefix and target.startswith(prefix) and len(prefix) > best[0]:
                best = (len(prefix), app.kb_app_id, env)
    return best[1], best[2]


def receive(db: Session, payload: Any, *, actor: Optional[str], origin: Optional[str]):
    """Store what the tool sent as an inbox capture."""
    from ...models.kb_changes import KbCapture

    if not isinstance(payload, dict) or payload.get("format") != FORMAT or not isinstance(payload.get("pages"), list):
        raise CaptureError("That is not a capture from the KB capture tool.")
    data = json.dumps(payload).encode("utf-8")
    bundle = read_bundle("capture.json", data)
    pages = bundle["pages"]
    app_id, environment = guess_application(db, pages[0].get("url"))
    host = _text(payload.get("host"), 255) or None
    count = len(pages)
    capture = KbCapture(
        app_id=app_id, environment=environment, host=host, origin=_text(origin, 255) or None,
        name=_text(payload.get("name"), 200) or f"{host or 'Capture'} · {count} page{'s' if count != 1 else ''}",
        status="inbox", pages=pages, edits={},
        manifest={"format": FORMAT, "host": host, "started_at": payload.get("started_at"),
                  "finished_at": payload.get("finished_at") or datetime.utcnow().isoformat(timespec="seconds"),
                  "notes": bundle["notes"]},
        created_by=actor,
    )
    db.add(capture)
    db.commit()
    db.refresh(capture)
    return capture


def apply_edits(pages: List[Dict[str, Any]], edits: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The captured pages as the reviewer left them: order, dropped pages and objects, names, screens."""
    edits = edits or {}
    by_id = {p["page_id"]: p for p in pages}
    order = [pid for pid in (edits.get("order") or []) if pid in by_id]
    order += [p["page_id"] for p in pages if p["page_id"] not in order]
    dropped = set(edits.get("dropped_pages") or [])
    dropped_elements = edits.get("dropped_elements") or {}
    names = edits.get("names") or {}
    screens = edits.get("screens") or {}
    out = []
    for pid in order:
        if pid in dropped:
            continue
        page = dict(by_id[pid])
        gone = set(dropped_elements.get(pid) or [])
        page["elements"] = [e for e in page["elements"] if e["selector"] not in gone]
        if names.get(pid):
            page["name"] = _text(names[pid], 120)
        if pid in screens:
            page["screen_id"] = screens[pid] or NO_SCREEN
        out.append(page)
    return out


def _overrides(pages: List[Dict[str, Any]], edits: Optional[Dict[str, Any]]) -> Dict[int, Tuple[int, str]]:
    index = {p["page_id"]: i for i, p in enumerate(pages)}
    out: Dict[int, Tuple[int, str]] = {}
    for step, choice in ((edits or {}).get("steps") or {}).items():
        if isinstance(choice, dict) and choice.get("page_id") in index and choice.get("selector"):
            try:
                out[int(step)] = (index[choice["page_id"]], str(choice["selector"]))
            except ValueError:
                continue
    return out


def preview(db: Session, capture, *, journey_id: str, application_id: Optional[int], environment: Optional[str]) -> Dict[str, Any]:
    """The capture as a flow, matched to the journey without storing anything.

    pages: in order, each with its screen, the steps it answers and its
    objects, each object with the design element it is (if any) and how it
    compares; steps: every journey step with where it was found.
    """
    if not capture.app_id:
        raise CaptureError("Choose the application this capture belongs to first.")
    edits = capture.edits or {}
    pages = apply_edits(capture.pages or [], edits)
    overrides = _overrides(pages, edits)
    walk = _walk(db, app_id=capture.app_id, journey_id=journey_id, application_id=application_id,
                 environment=environment, pages=pages, overrides=overrides)
    plan, output, result, assignment = walk["plan"], walk["output"], walk["result"], walk["assignment"]
    signatures = plan.get("signatures") or {}
    rows_by_key = {(r["screen_id"], r["element_id"]): r for r in result.get("rows", [])}
    # Which captured object each design element landed on.
    where: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for record in [*output.get("sweep", []), *[s.get("capture") for s in output.get("steps", []) if s.get("capture")]]:
        if record and record.get("found") and record.get("page_id"):
            where[(record["screen_id"], record["element_id"])] = record
    uses: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
    for key, record in where.items():
        row = rows_by_key.get(key) or {}
        uses.setdefault((record["page_id"], record["selector"]), []).append({
            "screen_id": key[0], "element_id": key[1], "design_label": row.get("design_label"),
            "step": row.get("step"), "outcome": row.get("outcome"), "label_differs": bool(row.get("label_differs")),
            "app_label": row.get("app_label"),
        })
    items = plan.get("items", [])
    steps_out = []
    answered: Dict[str, List[int]] = {}
    for step in result.get("steps", []):
        cap = step.get("capture") or {}
        order = step.get("order")
        item = items[order - 1] if isinstance(order, int) and 0 < order <= len(items) else {}
        el = item.get("element") or {}
        row = rows_by_key.get((el.get("screen_id"), el.get("element_id"))) or {}
        found = bool(cap.get("found"))
        if step.get("status") == "done" and found and step.get("step_number") is not None:
            answered.setdefault(cap["page_id"], []).append(step["step_number"])
        steps_out.append({
            "order": order, "step_number": step.get("step_number"), "kind": step.get("kind"),
            "text": item.get("text") or el.get("label"), "setup": bool(item.get("setup")),
            "element_label": el.get("clean_label") or el.get("label"), "has_element": bool(el),
            "status": step.get("status"), "reason": step.get("reason"),
            "page_id": cap.get("page_id") if found else None, "selector": cap.get("selector") if found else None,
            "app_label": cap.get("app_label") if found else None,
            "outcome": row.get("outcome"), "label_differs": bool(row.get("label_differs")),
            "chosen": step.get("step_number") in overrides,
        })
    auto = assign_screens(plan, [{**p, "screen_id": None} for p in pages])
    chosen_screens = edits.get("screens") or {}
    pages_out = []
    for i, page in enumerate(pages):
        sid = assignment.get(i)
        pages_out.append({
            "page_id": page["page_id"], "name": page["name"], "url": page.get("url"), "path": _path(page.get("url")),
            "title": page.get("title"), "screen_id": sid,
            "screen_name": (signatures.get(sid) or {}).get("name") if sid else None,
            "screen_chosen": page["page_id"] in chosen_screens, "auto_screen": auto.get(i),
            "steps": sorted(set(answered.get(page["page_id"], []))),
            "elements": [{
                "selector": e["selector"], "name": e["name"], "role": e.get("role"), "tag": e.get("tag"),
                "kind": "picked" if e.get("picked") else (e.get("kind") or "control"), "action": e.get("action"),
                "chrome": bool(e.get("chrome")), "uses": uses.get((page["page_id"], e["selector"]), []),
            } for e in page["elements"]],
        })
    dropped = set(edits.get("dropped_pages") or [])
    return {
        "capture": view(capture), "journey_id": journey_id, "pages": pages_out, "steps": steps_out,
        "screens": [{"screen_id": sid, "name": (signatures.get(sid) or {}).get("name") or sid} for sid in (plan.get("screens") or {})],
        "dropped_pages": [{"page_id": p["page_id"], "name": p["name"]} for p in (capture.pages or []) if p["page_id"] in dropped],
        "summary": result.get("summary", {}),
        "notes": (capture.manifest or {}).get("notes") or [],
    }


def import_inbox(db: Session, capture, *, journey_id: str, application_id: Optional[int], environment: Optional[str],
                 actor: Optional[str]) -> KbCrawlRun:
    """Import the capture, as edited, as a completed walk; the inbox entry records which."""
    if capture.status == "imported" and capture.crawl_run_id:
        raise CaptureError(f"Already imported as capture #{capture.crawl_run_id}.")
    if not capture.app_id:
        raise CaptureError("Choose the application this capture belongs to first.")
    pages = apply_edits(capture.pages or [], capture.edits)
    manifest = capture.manifest or {}
    crawl = _store_walk(db, app_id=capture.app_id, journey_id=journey_id, application_id=application_id,
                        environment=environment or capture.environment, pages=pages, manifest=manifest,
                        notes=manifest.get("notes") or [], filename=f"sent from the tool (inbox #{capture.id})",
                        fmt=FORMAT, actor=actor, overrides=_overrides(pages, capture.edits))
    capture.status, capture.crawl_run_id, capture.journey_id = "imported", crawl.id, journey_id
    db.commit()
    return crawl


def view(capture) -> Dict[str, Any]:
    pages = capture.pages or []
    return {
        "id": capture.id, "app_id": capture.app_id, "environment": capture.environment, "journey_id": capture.journey_id,
        "name": capture.name, "host": capture.host, "origin": capture.origin, "status": capture.status,
        "pages": len(pages), "elements": sum(len(p.get("elements") or []) for p in pages),
        "first_url": pages[0].get("url") if pages else None, "crawl_run_id": capture.crawl_run_id,
        "edits": capture.edits or {}, "created_by": capture.created_by,
        "created_at": capture.created_at.isoformat() if capture.created_at else None,
    }


def update(db: Session, capture, *, app_id: Optional[str] = None, environment: Optional[str] = None,
           name: Optional[str] = None, edits: Optional[Dict[str, Any]] = None, status: Optional[str] = None):
    if capture.status == "imported" and (edits is not None or app_id is not None):
        raise CaptureError("This capture was imported; its walk is reviewed on the Crawl stage.")
    if app_id is not None:
        capture.app_id = app_id or None
    if environment is not None:
        capture.environment = environment or None
    if name is not None:
        capture.name = _text(name, 200) or capture.name
    if edits is not None:
        capture.edits = {k: v for k, v in edits.items() if k in EDIT_KEYS}
    if status is not None:
        if status not in ("inbox", "discarded"):
            raise CaptureError("A capture can only be discarded or put back in the inbox.")
        capture.status = status
    db.commit()
    db.refresh(capture)
    return capture
