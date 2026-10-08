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


def snippet_js() -> str:
    """The capture tool, self-contained, for a bookmarklet or the DevTools console."""
    return (
        _SNIPPET.replace("__UNIQUE_XPATH__", _js_function("uniqueXPath"))
        .replace("__SWEEP_PAGE__", _js_function("sweepPage"))
        .replace("__FORMAT__", FORMAT)
    )


_SNIPPET = r"""(() => {
// Knowledge Base capture tool (__FORMAT__). Records what pages show -- never what is typed.
if (window.__kbCaptureOpen) { window.__kbCaptureOpen(); return; }
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
const pathOf = () => location.pathname.replace(/\/+$/, '') || '/';
const slug = (s) => clean(s, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page';
const current = () => state.pages.length ? state.pages[state.pages.length - 1] : null;
const capturePage = (name) => {
  const label = clean(name || document.title || pathOf(), 80);
  const controls = sweepPage().map((e) => ({ ...e, kind: 'control' }));
  const page = {
    page_id: `${String(state.pages.length + 1).padStart(2, '0')}-${slug(label)}`, name: label,
    url: cleanUrl(location.href), title: clean(document.title, 120), captured_at: new Date().toISOString(),
    elements: controls.concat(sweepText()), picked: [],
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
  button.m{background:#B71920;color:#fff;border-color:#B71920} .s{margin-top:8px;color:#4B5563;font-size:12px} .n{color:#6B7280;font-size:11.5px;margin-top:6px}
</style><div class="p"><div class="h"><span>KB capture</span><button class="x" id="kb-close" title="Hide">×</button></div>
  <input id="kb-name" placeholder="Page name (default: the page title)">
  <div class="r"><button class="b m" id="kb-capture">Capture page</button><button class="b" id="kb-pick">Pick element</button></div>
  <select id="kb-action" title="What a test does with the next picked element"><option value="auto">Picked element: guess the action</option><option value="click">click</option><option value="fill">fill</option><option value="select">select</option><option value="assert">check (assert)</option></select>
  <div class="r"><button class="b m" id="kb-zip">Download zip</button><button class="b" id="kb-clear">Start over</button></div>
  <div class="s" id="kb-status"></div><div class="n">Nothing you type is recorded. Open each page of the journey (and each dialog), then Capture page.</div></div>`;
const render = (msg) => {
  const n = state.pages.length; const picks = state.pages.reduce((k, p) => k + p.picked.length, 0);
  ui.querySelector('#kb-status').textContent = `${msg ? msg + ' ' : ''}${n} page(s), ${picks} picked so far.`;
  ui.querySelector('#kb-pick').textContent = picking ? 'Stop picking' : 'Pick element';
};
ui.querySelector('#kb-capture').onclick = () => { capturePage(ui.querySelector('#kb-name').value); ui.querySelector('#kb-name').value = ''; };
ui.querySelector('#kb-pick').onclick = () => setPicking(!picking);
ui.querySelector('#kb-zip').onclick = download;
ui.querySelector('#kb-clear').onclick = () => { if (confirm('Discard everything captured so far?')) { state = fresh(); save(); render('Started over.'); } };
ui.querySelector('#kb-close').onclick = () => { setPicking(false); host.style.display = 'none'; };
window.__kbCaptureOpen = () => { host.style.display = 'block'; render(''); };
document.body.appendChild(host);
render(state.pages.length ? 'Continuing the capture started earlier.' : 'Open a page of the journey and press Capture page.');
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
    return {
        "role": _text(raw.get("role") or raw.get("type") or raw.get("tagName"), 40).lower() or None,
        "name": name, "text": _text(raw.get("text") or locator.get("text"), 120) or None,
        "tag": _text(raw.get("tag") or raw.get("tagName"), 20).lower() or None,
        "selector": selector, "alternates": list(dict.fromkeys(alternates))[:4],
        "chrome": bool(raw.get("chrome")), "kind": raw.get("kind") or ("picked" if picked else "control"),
        "picked": picked, "action": _text(raw.get("action") or (actions[0] if actions else ""), 20).lower() or None,
        "assertions": [a for a in (raw.get("assertions") or []) if isinstance(a, str)][:6],
    }


def _page(raw: Dict[str, Any], fallback_id: str) -> Dict[str, Any]:
    elements = [e for e in (_element(x) for x in (raw.get("elements") or []) if isinstance(x, dict)) if e]
    picked = [e for e in (_element(x, picked=True) for x in (raw.get("picked") or []) if isinstance(x, dict)) if e]
    if not picked:
        # The page-object layout names every element it lists: they were all chosen by a person.
        named = [e for e in elements if e["name"] and raw.get("pageId")]
        for e in named:
            e["picked"] = True
    return {
        "page_id": _text(raw.get("page_id") or raw.get("pageId") or fallback_id, 120),
        "name": _text(raw.get("name") or raw.get("title") or raw.get("pageId"), 120),
        "url": _text(raw.get("url"), 1000) or None,
        "title": _text(raw.get("title"), 200) or None,
        "captured_at": raw.get("captured_at"),
        "screen_id": _text(raw.get("screen_id") or raw.get("screen"), 120) or None,
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


def build_output(plan: Dict[str, Any], pages: List[Dict[str, Any]], assignment: Dict[int, Optional[str]]) -> Dict[str, Any]:
    """What a walk of this plan would have written, from the captured pages."""
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
        base = {"screen_id": el["screen_id"], "element_id": el["element_id"], "tried": [], "url": (page or {}).get("url")}
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

def import_capture(
    db: Session, *, app_id: str, journey_id: str, application_id: Optional[int], environment: Optional[str],
    filename: str, data: bytes, actor: Optional[str],
) -> KbCrawlRun:
    """Store an uploaded capture as a completed walk of `journey_id`, evaluated like one."""
    from ...models.automation import AutomationApplication

    if (journey_id or "").startswith(crawl_runs.FLOW_PREFIX):
        raise CaptureError("A capture is uploaded against a journey, not a flow blueprint.")
    bundle = read_bundle(filename, data)
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
    pages = bundle["pages"]
    assignment = assign_screens(plan, pages)
    result = journey_crawl.evaluate(plan, build_output(plan, pages, assignment))
    # Which journey steps each page answered. A recorded journey has no named
    # screens, so this -- not a screen -- is how its pages are used.
    used: Dict[int, List[int]] = {}
    urls = [p.get("url") for p in pages]
    for step in result.get("steps", []):
        if step.get("status") == "done" and step.get("url") in urls:
            used.setdefault(urls.index(step["url"]), []).append(step.get("step_number"))
    unassigned = [p["name"] or p["page_id"] for i, p in enumerate(pages) if not assignment.get(i) and not used.get(i)]
    manifest = bundle["manifest"]
    result["capture"] = {
        "file": filename, "format": manifest.get("format") or ("page-objects" if bundle["journey"] else "json"),
        "host": manifest.get("host"), "started_at": manifest.get("started_at"), "finished_at": manifest.get("finished_at"),
        "uploaded_by": actor, "pages": [{"page_id": p["page_id"], "name": p["name"], "url": p.get("url"),
                                         "screen_id": assignment.get(i), "steps": used.get(i, []), "elements": len(p["elements"])}
                  for i, p in enumerate(pages)],
        "notes": bundle["notes"] + ([f"Not used by any step of this journey: {', '.join(unassigned)}."] if unassigned else []),
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
