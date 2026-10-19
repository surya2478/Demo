"""
--- Recording a journey: a person does it, the Knowledge Base keeps what they did ---------

A journey's steps written from a BRD describe the application the BRD
imagined; where it differs from the running one (a "Password tab" that is a
"CLICK HERE" link) a walk can only fail. A recording starts from the other end:
a browser opens at the environment's address, someone signs in and clicks
through the journey themselves -- OTP, captcha and all -- and every click,
field, choice and key press is kept as a step, with the selector it was done
with (checked to match that one element), the address it happened at and a
screenshot.

Nothing typed is kept: a field records what kind of field it is (username,
password, OTP...), and replaying it reads that value from Test Data. Filled
fields are painted over in screenshots and live frames.

The browser work is an ordinary AutomationRun with a visible browser (only
where the server can show one, crawl_runs.headed_available), stored as a
KbCrawlRun whose plan says source "record", so the Walk page lists, watches and
shows it like a walk. It ends when the person presses Finish (a stop file in
the run's workspace), closes the window, or reaches the time limit.

recording_steps turns what was recorded into journey steps; save drafts them
through the Journey Map as the journey's new steps, with the flow blueprint
regenerated from them, as one pair of change sets for review.
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit

from sqlalchemy.orm import Session

from ...config import settings
from ...models.automation import AutomationApplication, AutomationRun
from ...models.kb_changes import KbChangeSet, KbCrawlRun
from . import changesets, journey_crawl, journey_map, store

SPEC_FILE = "journey_record.spec.ts"
OUTPUT_FILE = "journey_record.json"
STOP_FILE = "journey_record.stop"
SOURCE = "record"

# What a recorded field is, in words a step can use and Test Data can match.
FIELD_WORDS = {
    "username": "username", "email": "email address", "password": "password", "otp": "one-time password",
    "mobile": "mobile number", "search": "search text", "text": "value",
}


class RecordError(ValueError):
    """The recording cannot be started or saved; the message says why."""


def _path(url: Optional[str]) -> Optional[str]:
    if not url:
        return None
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    return parts.path or "/"


def _quote(label: Optional[str]) -> str:
    label = re.sub(r"\s+", " ", (label or "")).strip().rstrip("*").strip()
    return f"'{label[:60]}'" if label else ""


def _merge_otp(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Consecutive single-character boxes of one group become one OTP entry."""
    out: List[Dict[str, Any]] = []
    for ev in events:
        last = out[-1] if out else None
        if (ev.get("kind") == "fill" and ev.get("group_target") and last is not None and last.get("kind") == "otp"
                and last.get("target") == ev["group_target"]):
            last["boxes"] = max(last.get("boxes") or 0, ev.get("group_size") or 0)
            last["led_to"] = ev.get("led_to") or last.get("led_to")
            last["screenshot"] = ev.get("screenshot") or last.get("screenshot")
            continue
        if ev.get("kind") == "fill" and ev.get("group_target"):
            out.append({**ev, "kind": "otp", "target": ev["group_target"], "field": "otp", "boxes": ev.get("group_size")})
            continue
        out.append(dict(ev))
    return out


def recording_steps(output: Dict[str, Any], *, app_name: str = "the application") -> List[Dict[str, Any]]:
    """Journey steps from a recording: [{action, expected_result, recorded}].

    `recorded` is what a replay needs: kind (goto, click, fill, otp, select,
    check, press), the selector (target) or address (route), what kind of
    field a fill was, the label the person saw, where it happened and where it led.
    """
    steps: List[Dict[str, Any]] = []
    landed = output.get("landed") or output.get("entry")
    steps.append({
        "action": f"Open {app_name} at the environment's address",
        "expected_result": f"The page {_path(landed)} opens" if _path(landed) else "",
        "recorded": {"kind": "goto", "route": _path(landed), "url": _path(landed), "screenshot": output.get("entry_shot")},
    })
    for ev in _merge_otp([e for e in output.get("events", []) if isinstance(e, dict)]):
        kind = ev.get("kind")
        label = _quote(ev.get("label"))
        field = ev.get("field") or "text"
        if kind == "click":
            what = "link" if ev.get("tag") == "a" else "tab" if ev.get("role") == "tab" else ""
            action = f"Click {label}{(' ' + what) if what and label else ''}" if label else "Click the element"
        elif kind == "check":
            action = f"Tick {label}" if label else "Tick the box"
        elif kind == "select":
            action = f"Choose {_quote(ev.get('option')) or 'an option'} in {label or 'the list'}"
        elif kind == "press":
            action = f"Press {ev.get('key') or 'Enter'}" + (f" in {label}" if label else "")
        elif kind == "otp":
            action = f"Enter the one-time password{f' ({ev['boxes']} boxes)' if ev.get('boxes') else ''}"
        elif kind == "fill":
            action = f"Enter the {FIELD_WORDS.get(field, 'value')}" + (f" in {label}" if label else "")
        else:
            continue
        led = _path(ev.get("led_to"))
        here = _path(ev.get("url"))
        recorded = {k: v for k, v in {
            "kind": kind, "target": ev.get("target"), "field": field if kind in ("fill", "otp") else None,
            "label": (ev.get("label") or "").strip()[:120] or None, "option": ev.get("option") if kind == "select" else None,
            "key": ev.get("key") if kind == "press" else None, "url": here, "led_to": led if led and led != here else None,
            "boxes": ev.get("boxes"), "screenshot": ev.get("screenshot"), "unique": ev.get("unique"),
            "at": ev.get("at") if kind in ("click", "check") else None,
        }.items() if v not in (None, "")}
        steps.append({"action": action, "expected_result": f"The page {led} opens" if led and led != here else "",
                      "recorded": recorded})
    return with_check(steps, output.get("final_url"), output.get("final_shot"))


def with_check(steps: List[Dict[str, Any]], final_url: Optional[str], screenshot: Optional[str] = None) -> List[Dict[str, Any]]:
    """The recording's last step: check the page the journey ended on is showing.

    A person looks at the landing screen; a recording only sees what they do,
    so the check is added from where the recording ended. Added once.
    """
    end = _path(final_url)
    if not end or not steps or steps[-1]["recorded"].get("kind") == "verify":
        return steps
    return [*steps, {"action": f"Verify the landing page {end} is shown", "expected_result": f"The page {end} is showing",
                     "recorded": {k: v for k, v in {"kind": "verify", "route": end, "url": end, "screenshot": screenshot}.items() if v}}]


def start(db: Session, *, app_id: str, journey_id: str, application_id: int, environment: Optional[str] = None,
          actor: Optional[str] = None) -> KbCrawlRun:
    """Open a browser at the environment's address for someone to do the journey in."""
    from ..automation.job_manager import job_manager, new_run_key
    from ..automation.preflight import is_ready, runtime_status
    from ..automation.registry import address_for_crawl
    from .crawl_runs import Unavailable, _kb, blocked_environments, headed_available

    if not settings.AUTOMATION_ENABLED:
        raise Unavailable("The Automation Module is disabled on this deployment (AUTOMATION_ENABLED=false).", 503)
    if not headed_available():
        raise RecordError("Recording needs a browser window someone can use, and this server cannot show one. "
                          "Record from a backend running on your own machine.")
    if not is_ready():
        detail = "; ".join(f"{n}: {s.detail}" for n, s in runtime_status().items() if not s.available)
        raise Unavailable(f"The browser runtime is not available. {detail}", 503)
    permitted, reason = job_manager.capacity()
    if not permitted:
        raise Unavailable(reason, 429)
    application = db.get(AutomationApplication, application_id)
    if application is None:
        raise LookupError("No such registered application.")
    kb = _kb(app_id)
    if application.app_key != kb.app_id:
        raise RecordError(f"{application.name} is registered as '{application.app_key}', not '{kb.app_id}'.")
    journey = kb.journeys.get(journey_id)
    if journey is None:
        raise LookupError(f"'{journey_id}' has no authored journey file to record into.")
    environment = (environment or application.environment or "SIT").strip()
    if environment.upper() in blocked_environments():
        raise RecordError(f"Recordings do not run against {environment}. Use SIT, QA, UAT or RC.")
    base_url = (address_for_crawl(db, application.app_key, environment) or application.base_url or "").strip()
    if not base_url:
        raise RecordError(f"{application.name} has no address for {environment}. Add one in AI Test Automation > Test Data.")

    minutes = max(2, int(settings.AUTOMATION_RECORD_MAX_MINUTES or 20))
    plan = {"source": SOURCE, "app_id": kb.app_id, "journey_id": journey_id, "journey_name": journey.get("name") or journey_id,
            "entry": journey_crawl.entry_address(base_url), "base_url": base_url, "max_minutes": minutes,
            "app_name": application.name, "items": [], "scope": [journey_id], "variables": []}
    run_key = new_run_key()
    db.add(AutomationRun(
        run_key=run_key, framework="playwright", environment=environment, status="queued",
        # A person drives it: no slowMo, no self-healing, and as long as the recording may last.
        run_config={"headless": False, "slow_mo_ms": 0, "mode": "journey_record", "auto_heal": False,
                    "timeout_seconds": minutes * 60 + 120},
        run_metadata={"code": build_spec(plan), "base_url": base_url, "file_name": SPEC_FILE, "journey_id": journey_id},
        triggered_by=actor,
    ))
    crawl = KbCrawlRun(app_id=app_id, journey_id=journey_id, application_id=application.id, environment=environment,
                       profile_id=None, base_url=base_url, run_key=run_key, status="running", plan=plan, created_by=actor)
    db.add(crawl)
    db.commit()
    db.refresh(crawl)
    job_manager.submit(run_key)
    return crawl


def _workspace(db: Session, crawl: KbCrawlRun):
    from ..automation import workspace as ws
    from pathlib import Path

    run = db.query(AutomationRun).filter(AutomationRun.run_key == crawl.run_key).first() if crawl.run_key else None
    if run is None:
        return None, None
    return run, (Path(run.workspace_path) if run.workspace_path else ws.workspace_dir_for_run(run.run_key))


def finish(db: Session, crawl: KbCrawlRun) -> None:
    """Ask a running recording to end; it saves what it has and closes the browser."""
    if (crawl.plan or {}).get("source") != SOURCE:
        raise RecordError("This is a walk, not a recording.")
    run, folder = _workspace(db, crawl)
    if run is None or folder is None or not folder.exists():
        raise RecordError("The recording has not started yet.")
    (folder / STOP_FILE).write_text("finish", encoding="utf-8")


def absorb(db: Session, crawl: KbCrawlRun) -> KbCrawlRun:
    """A finished recording's events, as journey steps, folded into the crawl record once."""
    from datetime import datetime

    if crawl.status in ("completed", "failed") or not crawl.run_key:
        return crawl
    run, folder = _workspace(db, crawl)
    if run is None or run.status in ("queued", "running"):
        return crawl
    output_file = folder / OUTPUT_FILE if folder is not None else None
    output: Dict[str, Any] = {}
    if output_file is not None and output_file.exists():
        try:
            output = json.loads(output_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            output = {}
    # A recording stopped from the run page still keeps what was recorded: the
    # spec saves after every action.
    if output.get("events"):
        steps = recording_steps(output, app_name=(crawl.plan or {}).get("app_name") or "the application")
        crawl.result = {"recording": steps, "events": len(output.get("events") or []), "final_url": output.get("final_url"),
                        "ended": output.get("reason"), "entry": {"address": output.get("entry"), "landed": output.get("landed")},
                        "steps": [], "rows": [], "summary": {}, "blockers": []}
        crawl.status = "completed"
        crawl.error = None
    else:
        crawl.status = "failed"
        crawl.error = (run.error_message or "Nothing was recorded: no click or field was used before the recording ended.")
    crawl.finished_at = datetime.utcnow()
    db.commit()
    db.refresh(crawl)
    return crawl


def save(db: Session, crawl_id: int, steps: List[Dict[str, Any]], *, link_flow: Optional[str],
         actor: Optional[str]) -> Dict[str, Optional[KbChangeSet]]:
    """The reviewed recording as the journey's steps, with its flow regenerated: one pair of change sets."""
    crawl = db.get(KbCrawlRun, crawl_id)
    if crawl is None:
        raise LookupError("No such recording.")
    if (crawl.plan or {}).get("source") != SOURCE or crawl.status != "completed":
        raise RecordError("Only a finished recording can be saved as the journey's steps.")
    if not steps:
        raise RecordError("Keep at least one recorded step.")
    kb = store.load(crawl.app_id)
    if kb is None:
        raise LookupError(f"No Journey KB for '{crawl.app_id}'.")
    journey = kb.journeys.get(crawl.journey_id)
    if journey is None:
        raise LookupError(f"No journey '{crawl.journey_id}'.")
    clean = []
    for step in steps:
        recorded = step.get("recorded") if isinstance(step.get("recorded"), dict) else None
        if recorded is not None:
            recorded = {**recorded, "recording": crawl.id, "environment": crawl.environment}
        # A recorded step is done by its own selector: it names no design screen or element.
        clean.append({"from_step": None, "action": step.get("action") or "", "expected_result": step.get("expected_result") or "",
                      "recorded": recorded})
    has_flow = any(f in journey_map._flows(kb) for f in journey.get("automation_flow_ids") or [])
    created = journey_map.propose(db, kb, crawl.journey_id, steps=clean, link_flow=None if has_flow else (link_flow or "new"),
                                  actor=actor)
    for half in (created["journey"], created["automation"]):
        if half is not None:
            half.origin = {**(half.origin or {}), "recording": {"crawl_run_id": crawl.id, "environment": crawl.environment}}
    if created["journey"] is not None:
        crawl.journey_change_set_id = created["journey"].id
    if created["automation"] is not None:
        crawl.automation_change_set_id = created["automation"].id
    db.commit()
    return created


# --- The recorder -------------------------------------------------------------------------------

_SPEC = r"""import { test } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// --- Journey recorder ---------------------------------------------------------
// Opens the application for a person to do the journey in, and keeps each
// click, field, choice and key press with a selector checked to match that one
// element. Never a typed value: a field is recorded by what kind of field it is.

const PLAN = __PLAN__;
const STOP = path.join(process.cwd(), '__STOP__');

function writeAtomic(name, data) {
  const target = path.join(process.cwd(), name);
  const tmp = target + '.tmp';
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, target); } catch (e) { /* the recording goes on without it */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs in every page the person opens. Sends what they do to __kbRecord.
function recorder() {
  if (window.top !== window || window.__kbRecorder) return;
  window.__kbRecorder = true;
  const send = (ev) => { try { if (window.__kbRecord) window.__kbRecord(ev); } catch (e) { /* page leaving */ } };
  const INTERACTIVE = 'a,button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=option],[role=menuitem],[role=switch],[role=combobox],[onclick],[tabindex]:not([tabindex="-1"])';
  const TEXTISH = ['', 'text', 'email', 'password', 'tel', 'number', 'search', 'url'];
  const isText = (el) => (el.tagName === 'INPUT' && TEXTISH.includes((el.getAttribute('type') || '').toLowerCase())) || el.tagName === 'TEXTAREA';
  const squash = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const count = (xp) => { try { return document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength; } catch (e) { return 0; } };
  const ok = (v) => v && !v.includes("'") && v.length <= 80;
  const dynamic = (v) => /\d{5,}|[a-f0-9]{10,}|^(ember|react|mat-|ng-|cdk-|mui-|radix-|headlessui-)/i.test(v);
  const labelOf = (el) => {
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = squash(by.split(/\s+/).map((id) => (document.getElementById(id) || {}).innerText || '').join(' ')); if (t) return t; }
    if (el.id) { try { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l && squash(l.innerText)) return squash(l.innerText); } catch (e) {} }
    const wrap = el.closest('label');
    if (wrap && squash(wrap.innerText)) return squash(wrap.innerText);
    return '';
  };
  const nameOf = (el) => squash(el.getAttribute('aria-label') || labelOf(el) || el.getAttribute('placeholder') || el.getAttribute('title')
    || el.getAttribute('alt') || (isText(el) ? '' : (el.innerText || el.textContent || el.getAttribute('value') || '')) || el.getAttribute('name') || '').slice(0, 120);
  // An XPath for this element that matches it alone; the QA team's selectors are XPath too.
  const xpathFor = (el) => {
    const tag = el.tagName.toLowerCase();
    const tries = [];
    for (const a of ['data-testid', 'data-test', 'data-qa', 'data-cy', 'id', 'name', 'formcontrolname', 'aria-label', 'placeholder', 'title']) {
      const v = el.getAttribute(a);
      if (ok(v) && !(a === 'id' && dynamic(v))) tries.push(`//${tag}[@${a}='${v}']`);
    }
    const text = squash(el.innerText || el.textContent);
    if (!isText(el) && ok(text) && text.length <= 60) {
      tries.push(`//${tag}[normalize-space(.)='${text}']`);
      tries.push(`//${tag}[contains(normalize-space(.),'${text}')]`);
    }
    const type = el.getAttribute('type');
    const lab = labelOf(el);
    if (isText(el) && ok(lab) && lab.length <= 60) tries.push(`//label[normalize-space(.)='${lab}']/following::${tag}[1]`);
    for (const xp of tries) if (count(xp) === 1) return { target: xp, unique: true };
    // The same, within the nearest container with a usable id: two SIGN IN
    // buttons on one page (one per sign-in form) are told apart by their form.
    for (let n = el.parentElement, depth = 0; n && n.nodeType === 1 && depth < 12; n = n.parentElement, depth++) {
      if (!n.id || !ok(n.id) || dynamic(n.id)) continue;
      for (const xp of tries) {
        const scoped = `//${n.tagName.toLowerCase()}[@id='${n.id}']${xp.replace(/^\/\//, '//')}`;
        if (count(scoped) === 1) return { target: scoped, unique: true };
      }
      break;
    }
    // From the nearest ancestor with a usable id, down by position.
    const parts = [];
    let n = el;
    for (let depth = 0; n && n.nodeType === 1 && depth < 8; depth++, n = n.parentElement) {
      const t = n.tagName.toLowerCase();
      if (n !== el && n.id && ok(n.id) && !dynamic(n.id)) {
        const xp = `//${t}[@id='${n.id}']/` + parts.join('/');
        if (count(xp) === 1) return { target: xp, unique: true };
        break;
      }
      const same = n.parentElement ? Array.from(n.parentElement.children).filter((c) => c.tagName === n.tagName) : [n];
      parts.unshift(same.length > 1 ? `${t}[${same.indexOf(n) + 1}]` : t);
    }
    const tail = `//${parts.join('/')}`;
    if (count(tail) === 1) return { target: tail, unique: true };
    return { target: tries[0] || tail || (type ? `//${tag}[@type='${type}']` : `//${tag}`), unique: false };
  };
  // The OTP boxes: one character each, several side by side.
  const otpGroup = (el) => {
    if (el.getAttribute('maxlength') !== '1') return null;
    let box = el.parentElement;
    for (let i = 0; box && i < 4; i++, box = box.parentElement) {
      const els = Array.from(box.querySelectorAll('input[maxlength="1"]'));
      if (els.length >= 4) {
        const tag = el.tagName.toLowerCase();
        const cls = (el.getAttribute('class') || '').split(/\s+/).find((c) => c && c.length > 3 && !c.includes("'") && els.every((e) => e.classList.contains(c)));
        const tries = [];
        const names = els.map((e) => e.getAttribute('name') || e.id || '');
        if (names.every(Boolean)) {
          let prefix = names[0];
          for (const nm of names) while (!nm.startsWith(prefix)) prefix = prefix.slice(0, -1);
          prefix = prefix.replace(/[-_\d]+$/, '');
          if (prefix.length >= 3 && !prefix.includes("'")) tries.push(`//${tag}[contains(@${el.getAttribute('name') ? 'name' : 'id'},'${prefix}')]`);
        }
        if (cls) tries.push(`//${tag}[contains(@class,'${cls}')]`);
        tries.push(`//${tag}[@maxlength='1']`);
        const target = tries.find((xp) => count(xp) === els.length);
        return target ? { group_target: target, group_size: els.length } : null;
      }
    }
    return null;
  };
  const fieldOf = (el) => {
    const type = (el.getAttribute('type') || '').toLowerCase();
    const words = [el.getAttribute('name'), el.id, el.getAttribute('placeholder'), el.getAttribute('autocomplete'), el.getAttribute('aria-label'), labelOf(el)].join(' ').toLowerCase();
    if (type === 'password' || /pass(word|code)?\b/.test(words)) return 'password';
    if (el.getAttribute('maxlength') === '1') return 'otp';
    // Before the OTP words: "Enter your email to receive OTP" is the email box.
    if (type === 'email' || /e-?mail/.test(words)) return /user/.test(words) ? 'username' : 'email';
    if (/\b(otp|one[- ]?time|verification code|pin)\b|otp/.test(words)) return 'otp';
    if (/user|login/.test(words)) return 'username';
    if (type === 'tel' || /mobile|phone|msisdn/.test(words)) return 'mobile';
    if (type === 'search' || /search/.test(words)) return 'search';
    return 'text';
  };
  const describe = (el) => ({ ...xpathFor(el), label: nameOf(el), tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || null });
  // A field is sent once the person moves on, so a word typed is one step, not one per key.
  let pending = null;
  const flush = () => {
    if (!pending) return;
    const el = pending; pending = null;
    if (!el.isConnected && !el.value) return;
    send({ kind: 'fill', ...describe(el), field: fieldOf(el), ...(otpGroup(el) || {}) });
  };
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!(el instanceof Element) || !isText(el)) return;
    if (pending && pending !== el) flush();
    pending = el;
    el.setAttribute('data-walk-filled', '');
  }, true);
  document.addEventListener('focusout', (e) => { if (pending && e.target === pending) flush(); }, true);
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el instanceof HTMLSelectElement) {
      flush();
      const opt = el.options[el.selectedIndex];
      send({ kind: 'select', ...describe(el), option: opt ? squash(opt.text).slice(0, 80) : null });
    }
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !(e.target instanceof Element) || !isText(e.target)) return;
    const el = e.target;
    if (pending === el) flush();
    send({ kind: 'press', key: 'Enter', ...describe(el) });
  }, true);
  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    const el = e.target.closest(INTERACTIVE) || e.target;
    if (isText(el) || el.tagName === 'SELECT' || el.tagName === 'OPTION') return;  // focusing a field is not a step
    if (el.tagName === 'LABEL') { const c = el.control; if (c && (isText(c) || c.tagName === 'SELECT')) return; }
    // Plain text the page does not treat as clickable (no control, no pointer)
    // is a stray click -- on a notice, to focus the window -- not a step.
    if (!e.target.closest(INTERACTIVE) && getComputedStyle(el).cursor !== 'pointer') return;
    flush();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const kind = (el.tagName === 'INPUT' && (type === 'checkbox' || type === 'radio')) || ['checkbox', 'radio', 'switch'].includes(el.getAttribute('role') || '') ? 'check' : 'click';
    // Where on it, when it holds other controls (a card with a link inside):
    // its centre may be one of those, so a replay clicks the same spot.
    let at = null;
    if (el.querySelector('a,button,input,select,[role=button],[role=link],[onclick]')) {
      const r = el.getBoundingClientRect();
      at = [Math.round(e.clientX - r.left), Math.round(e.clientY - r.top)];
    }
    send({ kind, ...describe(el), href: el.getAttribute('href') || null, at });
  }, true);
  window.addEventListener('pagehide', flush, true);
}

const masked = (page) => ({ mask: [page.locator('[data-walk-filled]'), page.locator('input[type=password]')], maskColor: '#8a8f98' });

test('record a journey', async ({ page }) => {
  test.setTimeout(PLAN.max_minutes * 60000 + 60000);
  const events = [];
  let finished = false;
  let reason = null;
  let landed = null;
  let entryShot = null;
  let finalShot = null;
  // The last address seen, kept even if the person closes the window.
  let lastUrl = null;
  const save = () => {
    if (!page.isClosed()) lastUrl = page.url();
    writeAtomic('__OUTPUT__', JSON.stringify({ entry: PLAN.entry, landed, entry_shot: entryShot, events, finished, reason,
      final_url: lastUrl, final_shot: finalShot }, null, 2));
  };
  const progress = () => writeAtomic('__PROGRESS__', JSON.stringify({
    total: events.length, current: null, finished,
    steps: events.map((e) => ({ order: e.order, step_number: e.order, kind: e.kind, label: e.label, field: e.field || null,
      option: e.option || null, url: e.url, unique: e.unique, screenshot: e.screenshot || null, status: 'done' })),
  }));
  const shoot = async (name) => {
    if (page.isClosed()) return null;
    const file = `shot-${name}.png`;
    try { await page.screenshot({ path: path.join(process.cwd(), file), timeout: 4000, ...masked(page) }); return file; } catch (e) { return null; }
  };

  await page.exposeBinding('__kbRecord', async (source, ev) => {
    if (finished || !ev || source.frame !== page.mainFrame()) return;
    const last = events[events.length - 1];
    let event;
    // Typing more into the same field is the same step.
    if (ev.kind === 'fill' && last && last.kind === 'fill' && last.target === ev.target) { event = Object.assign(last, ev, { order: last.order }); }
    else { event = { order: events.length + 1, ...ev, url: source.page.url() }; events.push(event); }
    save(); progress();
    await sleep(700);
    event.screenshot = await shoot(event.order);
    save(); progress();
  });
  await page.addInitScript(recorder);
  // Where each action led: the address the page moved to after it.
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    lastUrl = frame.url();
    const last = events[events.length - 1];
    if (last && !last.led_to && last.url !== frame.url()) { last.led_to = frame.url(); save(); }
  });

  await page.goto(PLAN.entry, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  landed = page.url();
  entryShot = await shoot(0);
  save(); progress();

  const until = Date.now() + PLAN.max_minutes * 60000;
  let frameAt = 0;
  while (!finished) {
    if (fs.existsSync(STOP)) { finished = true; reason = 'finished'; break; }
    if (page.isClosed()) { finished = true; reason = 'window closed'; break; }
    if (Date.now() > until) { finished = true; reason = `time limit (${PLAN.max_minutes} min)`; break; }
    if (Date.now() - frameAt > 1000) {
      frameAt = Date.now();
      try { writeAtomic('__FRAME__', await page.screenshot({ timeout: 3000, ...masked(page) })); } catch (e) { /* between pages */ }
    }
    await sleep(400);
  }
  // A field still being typed in when the recording ended counts too.
  if (!page.isClosed()) await page.evaluate(() => document.activeElement && document.activeElement.blur()).catch(() => {});
  await sleep(300);
  finalShot = await shoot('end');
  save(); progress();
});
"""


def build_spec(plan: Dict[str, Any]) -> str:
    return (
        _SPEC.replace("__PLAN__", json.dumps({"entry": plan["entry"], "max_minutes": plan["max_minutes"]}))
        .replace("__STOP__", STOP_FILE)
        .replace("__OUTPUT__", OUTPUT_FILE)
        .replace("__PROGRESS__", journey_crawl.PROGRESS_FILE)
        .replace("__FRAME__", journey_crawl.FRAME_FILE)
    )
