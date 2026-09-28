"""
--- Journey-guided crawl ---------------------------------------------------------

Discovery walks an application page by page and catalogues what it finds; it
cannot know which of forty controls is the "RECEIVE OTP" button of a sign-in
journey, so the catalogue and the Journey KB never met. This crawl starts
from the other end: it walks a Journey KB journey step by step -- the same
steps test cases are written from -- and, for every design element on the way,
tries to find it in the running application:

  1. the Automation KB's selector for it, when there is one (confirming it),
  2. the element's locator hint (role + accessible name),
  3. its label, placeholder and exact text, then its aliases.

Whatever resolves is turned into a unique XPath built from the live DOM and
counted before it is recorded, so a captured selector is known to exist and
to match exactly one element. The walk performs each step's action (fill,
enter the OTP, click) with values from the test-data vault, read through
process.env.TESTDATA_* so the runner's existing resolution, blocking and
redaction apply unchanged; no value passes through this module.

The result is not written anywhere. It becomes a pair of change sets -- the
captured selectors for the Automation KB (source "crawl", the only source
allowed to change it) and the matching automation_ref links for the Journey
KB -- which a reviewer approves like any other.
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional

from . import diff, store

OUTPUT_FILE = "journey_crawl.json"
SPEC_FILE = "journey_crawl.spec.ts"

INPUT_TYPES = {"text_input", "password_input", "search_input"}
CLICK_TYPES = {"button", "link", "tab", "nav_link", "menu_item", "menu_trigger", "icon_button", "control", "card_list"}
_VERIFY = re.compile(r"^\s*(verify|check|confirm|ensure|observe|validate)\b", re.IGNORECASE)
_NAVIGATE = re.compile(r"\b(navigate|go to|open the .*page|launch)\b", re.IGNORECASE)


# --- Locator hints ----------------------------------------------------------------

_HINT = re.compile(r'^\s*(?P<roles>[a-z/]+)\s+(?:(?P<contains>containing)\s+)?(?:"(?P<name>[^"]*)"|/(?P<regex>[^/]+)/|(?P<rest>.+))?\s*$', re.IGNORECASE)
ROLE_WORDS = {"button", "link", "tab", "textbox", "checkbox", "heading", "searchbox", "listitem", "menuitem", "radio", "combobox", "alert", "dialog"}


def parse_hint(hint: Optional[str]) -> Dict[str, Any]:
    """'button "CONTINUE"' -> {"roles": ["button"], "name": "CONTINUE"}; see the tests."""
    match = _HINT.match(hint or "")
    if not match:
        return {}
    roles = [r for r in match.group("roles").lower().split("/") if r in ROLE_WORDS]
    out: Dict[str, Any] = {"roles": roles}
    name = match.group("name")
    if match.group("regex"):
        out["regex"] = match.group("regex")
    elif name is not None:
        if "<" in name:
            out["placeholder_name"] = True  # e.g. "<organization name>": filled from test data
        elif match.group("contains"):
            out["contains"] = name
        else:
            out["name"] = name
    return out


def _clean(label: Optional[str]) -> str:
    label = re.sub(r"\([^)]*\)", "", label or "").strip().rstrip("*.:").strip()
    return "" if "<" in label else label


# --- The plan ---------------------------------------------------------------------

def _profile_variable(profile: Dict[str, Any], *words: str) -> Optional[str]:
    # The display name only: variable names carry the profile's own words
    # (TESTDATA_MULTI_ORG_EMAIL contains "org") and would match the wrong field.
    for field in profile.get("fields", []):
        tokens = set(re.findall(r"[a-z]+", str(field.get("name", "")).lower()))
        if tokens & set(words):
            return field.get("variable")
    return None


def _descriptor(kb: store.JourneyKB, screen: Dict[str, Any], element: Dict[str, Any], automation: Dict[str, Any]) -> Dict[str, Any]:
    ref = element.get("automation_ref")
    target = diff._resolve_ref(automation, ref) if ref else None
    etype = element.get("type")
    return {
        "screen_id": screen["screen_id"],
        "element_id": element["element_id"],
        "label": element.get("label"),
        "clean_label": _clean(element.get("label")),
        "aliases": [a for a in element.get("aliases", []) if a and "<" not in a],
        # Labels a Reconcile decision accepted ("both"); aliases only help matching.
        "accepted_labels": list(element.get("accepted_labels", [])),
        "type": etype,
        "hint": parse_hint(element.get("locator_hint")),
        "kb_ref": ref,
        # A selector the Automation KB already holds is tried first: finding
        # it confirms it; missing it is itself a finding.
        # Routes ("/b2bportal/home.html") are not selectors; XPaths ("//a") are.
        "kb_target": target if target and not (target.startswith("/") and not target.startswith("//")) else None,
        "group": etype == "otp_input_group",
        "is_input": etype in INPUT_TYPES,
    }


def build_plan(
    kb: store.JourneyKB,
    journey_id: str,
    *,
    automation_profile: Dict[str, Any],
    base_url: str,
    profile_id: Optional[str] = None,
) -> Dict[str, Any]:
    """What the crawl will do, step by step. Pure data; also shown to the user."""
    journey = kb.journeys.get(journey_id)
    if journey is None:
        raise ValueError(f"'{journey_id}' has no authored journey file to walk.")
    profiles = {k: v for k, v in ((kb.roles or {}).get("test_data_profiles") or {}).items() if isinstance(v, dict)}
    if not profile_id:
        profile_id = next((pid for pid, p in profiles.items() if "Journey Crawl sign-in" in p.get("extra_users", [])), None)
    data_profile = profiles.get(profile_id or "", {})

    scope = store.journey_scope(kb, journey)
    items: List[Dict[str, Any]] = []
    for walked in scope:
        # Steps of journeys after the chosen one are optional: the landing
        # screen depends on the account (a default organization skips the
        # chooser), and a step that cannot apply is skipped, not failed.
        optional = walked not in store.journey_chain(kb, journey)
        for step in walked.get("steps", []):
            if step.get("branch") == "negative_only":
                items.append({"journey_id": walked["journey_id"], "step_number": step["step_number"], "text": step["action"],
                              "kind": "skip", "reason": "error path only; the crawl follows the success path"})
                continue
            # "A|B" means the account decides which screen appears; the plan
            # cannot know, so that step sweeps nothing -- the screen is swept
            # on its first unambiguous visit instead.
            options = [s.strip() for s in str(step.get("screen_id") or "").split("|") if s.strip()]
            screen_id = options[0] if len(options) == 1 else ""
            screen = kb.screens.get(screen_id) or {}
            element = next((e for e in screen.get("elements", []) if e.get("element_id") == step.get("element_id")), None)
            item: Dict[str, Any] = {
                "journey_id": walked["journey_id"], "journey_name": walked["name"], "step_number": step["step_number"],
                "text": step["action"], "screen_id": screen_id or None, "optional": optional,
            }
            if len(options) > 1:
                item["screen_options"] = options
            if element is None:
                route = None
                if screen.get("route_ref"):
                    route = diff._resolve_ref(automation_profile, screen["route_ref"])
                route = route or screen.get("route")
                if _NAVIGATE.search(step["action"]) and route:
                    item.update(kind="goto", route=route)
                else:
                    item.update(kind="screen")
                items.append(item)
                continue
            desc = _descriptor(kb, screen, element, automation_profile)
            item["element"] = desc
            etype = element.get("type")
            if _VERIFY.match(step["action"]):
                item["kind"] = "capture"
            elif desc["group"]:
                item.update(kind="otp", variable=_profile_variable(data_profile, "otp"))
            elif etype in INPUT_TYPES:
                words = ("password",) if etype == "password_input" else ("email", "username", "user")
                item.update(kind="fill", variable=_profile_variable(data_profile, *words))
            elif etype == "card_list":
                item.update(kind="click", text_variable=_profile_variable(data_profile, "organization", "org"))
            elif etype in CLICK_TYPES:
                item["kind"] = "click"
            else:
                item["kind"] = "capture"
            if item["kind"] in ("fill", "otp") and not item.get("variable"):
                item["kind"] = "capture"
                item["reason"] = f"the data profile '{profile_id}' names no value for this field"
            items.append(item)

    screens = {
        sid: [_descriptor(kb, kb.screens[sid], e, automation_profile) for e in kb.screens[sid].get("elements", [])]
        for walked in scope for sid in walked.get("screens", []) if sid in kb.screens
    }
    return {
        "app_id": kb.app_id, "journey_id": journey_id, "journey_name": journey["name"],
        "scope": [j["journey_id"] for j in scope], "base_url": base_url, "profile_id": profile_id,
        "variables": sorted({i[k] for i in items for k in ("variable", "text_variable") if i.get(k)}),
        "items": items, "screens": screens,
    }


# --- The spec ----------------------------------------------------------------------

_SPEC = r"""import { test } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// --- Journey-guided crawl ---------------------------------------------------
// Walks one Journey KB journey and records, for each design element, whether
// the running application has it and a selector verified to match it alone.
// Values are read from TESTDATA_* only; nothing typed is recorded.

const PLAN = __PLAN__;
const T = { action: 8000, settle: 8000 };

// Which values the crawl reads -- listed literally so the runner can resolve
// them from the test-data vault before starting:
__ENV_READS__

const env = (name) => (name ? process.env[name] || '' : '');

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: T.settle }).catch(() => {});
}

function candidates(page, el, textValue) {
  const out = [];
  const h = el.hint || {};
  if (el.kb_target) out.push({ strategy: 'kb', make: () => page.locator(el.kb_target.startsWith('//') || el.kb_target.startsWith('(//') ? `xpath=${el.kb_target}` : el.kb_target) });
  for (const role of h.roles || []) {
    if (h.name) {
      out.push({ strategy: 'role', make: () => page.getByRole(role, { name: h.name, exact: true }) });
      out.push({ strategy: 'role~', make: () => page.getByRole(role, { name: h.name }) });
    }
    if (h.regex) out.push({ strategy: 'role/re', make: () => page.getByRole(role, { name: new RegExp(h.regex, 'i') }) });
  }
  if (textValue) out.push({ strategy: 'data-text', make: () => page.getByText(textValue, { exact: false }) });
  const labels = [el.clean_label, ...(el.aliases || [])].filter(Boolean);
  for (const label of labels) {
    if (el.is_input) {
      out.push({ strategy: 'label', make: () => page.getByLabel(label) });
      out.push({ strategy: 'placeholder', make: () => page.getByPlaceholder(label) });
    }
    out.push({ strategy: 'text', make: () => page.getByText(label, { exact: true }) });
  }
  if (h.contains) out.push({ strategy: 'contains', make: () => page.getByText(h.contains) });
  return out;
}

async function resolve(page, el, textValue) {
  const tried = [];
  let multi = null;
  for (const c of candidates(page, el, textValue)) {
    const loc = c.make();
    const n = await loc.count().catch(() => 0);
    tried.push({ strategy: c.strategy, count: n });
    if (n === 1 || (el.group && n > 1)) {
      if (await loc.first().isVisible().catch(() => false)) return { loc, strategy: c.strategy, count: n, tried };
    }
    if (n > 1 && !multi) multi = { loc, strategy: c.strategy, count: n };
  }
  if (multi && await multi.loc.first().isVisible().catch(() => false)) return { ...multi, tried, ambiguous: true };
  return { loc: null, tried };
}

// Runs in the page: a selector for this element, verified to match only it.
function uniqueXPath(el) {
  const tag = el.tagName.toLowerCase();
  const count = (xp) => { try { return document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength; } catch (e) { return 0; } };
  const ok = (v) => v && !v.includes("'") && v.length <= 80;
  const out = [];
  for (const a of ['data-testid', 'data-test', 'id', 'name', 'formcontrolname', 'aria-label', 'placeholder']) {
    const v = el.getAttribute(a);
    if (ok(v) && !(a === 'id' && /\d{5,}|[a-f0-9]{10,}/i.test(v))) out.push(`//${tag}[@${a}='${v}']`);
  }
  const text = (el.innerText || '').trim().replace(/\s+/g, ' ');
  if (ok(text) && text.length <= 60) {
    out.push(`//${tag}[normalize-space(.)='${text}']`);
    out.push(`//${tag}[contains(normalize-space(.),'${text}')]`);
  }
  for (const xp of out) if (count(xp) === 1) return xp;
  return null;
}

// Runs in the page: a selector matching exactly this group (the OTP boxes).
function groupXPath(els) {
  const names = els.map(e => e.getAttribute('name') || '').filter(Boolean);
  if (names.length !== els.length || !names.length) return null;
  let prefix = names[0];
  for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
  prefix = prefix.replace(/[-_\d]+$/, '');
  if (prefix.length < 3 || prefix.includes("'")) return null;
  const tag = els[0].tagName.toLowerCase();
  const xp = `//${tag}[contains(@name,'${prefix}')]`;
  const n = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength;
  return n === els.length ? xp : null;
}

// Runs in the page: what the user sees this element called. Never a value.
function describe(el) {
  const label = el.labels && el.labels[0] ? el.labels[0].innerText : '';
  const text = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  return {
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role') || '',
    app_label: (['input', 'textarea', 'select'].includes(el.tagName.toLowerCase())
      ? (el.getAttribute('aria-label') || label || el.getAttribute('placeholder') || '')
      : (text || el.getAttribute('aria-label') || '')).trim(),
  };
}

async function capture(page, el, textValue) {
  const r = await resolve(page, el, textValue);
  const record = { screen_id: el.screen_id, element_id: el.element_id, tried: r.tried, url: page.url() };
  if (!r.loc) return { ...record, found: false };
  const handle = await r.loc.first().elementHandle().catch(() => null);
  let selector = null;
  let info = {};
  if (handle) {
    info = await handle.evaluate(describe).catch(() => ({}));
    selector = el.group
      ? await r.loc.evaluateAll(groupXPath).catch(() => null)
      : await handle.evaluate(uniqueXPath).catch(() => null);
  }
  return { ...record, found: true, strategy: r.strategy, count: r.count, ambiguous: !!r.ambiguous, selector, ...info, _loc: r.loc };
}

test('journey-guided crawl', async ({ page }) => {
  test.setTimeout(240000);
  const steps = [];
  const sweep = [];
  const swept = new Set();
  const blockers = [];
  const shoot = async (name) => {
    const file = `shot-${name}.png`;
    await page.screenshot({ path: path.join(process.cwd(), file), fullPage: false }).catch(() => {});
    return file;
  };
  try {
    await page.goto(PLAN.base_url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await settle(page);
    for (const [index, item] of PLAN.items.entries()) {
      const out = { order: index + 1, journey_id: item.journey_id, step_number: item.step_number, kind: item.kind, screen_id: item.screen_id || null };
      try {
        if (item.kind === 'skip') { steps.push({ ...out, status: 'skipped', reason: item.reason }); continue; }
        if (item.kind === 'goto') {
          await page.goto(new URL(item.route, PLAN.base_url).toString(), { waitUntil: 'domcontentloaded', timeout: 35000 });
          await settle(page);
          steps.push({ ...out, status: 'done', url: page.url() });
        }
        // First visit to a screen: look for every element it should have.
        if (item.screen_id && !swept.has(item.screen_id) && PLAN.screens[item.screen_id]) {
          swept.add(item.screen_id);
          for (const el of PLAN.screens[item.screen_id]) {
            const r = await capture(page, el, null);
            delete r._loc;
            sweep.push(r);
          }
        }
        if (item.kind === 'goto') continue;
        if (item.kind === 'screen') { steps.push({ ...out, status: 'done', url: page.url(), screenshot: await shoot(index + 1) }); continue; }
        const el = item.element;
        const textValue = env(item.text_variable);
        const r = await capture(page, el, textValue);
        const loc = r._loc;
        delete r._loc;
        const before = page.url();
        if (!r.found) {
          steps.push({ ...out, status: item.optional ? 'not_applicable' : 'not_found', capture: r, screenshot: await shoot(index + 1) });
          continue;
        }
        if (item.kind === 'fill') await loc.first().fill(env(item.variable), { timeout: T.action });
        if (item.kind === 'otp') {
          const digits = env(item.variable).replace(/\D/g, '').split('');
          const n = await loc.count();
          if (n > 1) { for (let i = 0; i < Math.min(n, digits.length); i++) await loc.nth(i).fill(digits[i], { timeout: T.action }); }
          else await loc.first().fill(digits.join(''), { timeout: T.action });
        }
        if (item.kind === 'click') await loc.first().click({ timeout: T.action });
        // An OTP form submits itself once the last box is filled: give it
        // time to leave the page before the next screen is swept.
        if (item.kind === 'otp') await page.waitForURL((u) => u.toString() !== before, { timeout: T.settle }).catch(() => {});
        if (['fill', 'otp', 'click'].includes(item.kind)) await settle(page);
        steps.push({ ...out, status: 'done', capture: r, url: page.url(), screenshot: await shoot(index + 1) });
      } catch (err) {
        steps.push({ ...out, status: 'error', error: String(err && err.message || err).split('\n')[0].slice(0, 300) });
      }
    }
  } catch (err) {
    blockers.push(String(err && err.message || err).split('\n')[0].slice(0, 300));
  } finally {
    fs.writeFileSync(path.join(process.cwd(), '__OUTPUT__'), JSON.stringify({ steps, sweep, blockers, final_url: page.url() }, null, 2));
  }
});
"""


def build_spec(plan: Dict[str, Any]) -> str:
    # Literal process.env.NAME reads, so test_data.required_names finds them.
    reads = "\n".join(f"void process.env.{name};" for name in plan["variables"]) or "// none"
    return (
        _SPEC.replace("__PLAN__", json.dumps(plan, ensure_ascii=False))
        .replace("__ENV_READS__", reads)
        .replace("__OUTPUT__", OUTPUT_FILE)
    )


# --- Reading the result ------------------------------------------------------------------

def _norm(text: Optional[str]) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip().rstrip("*.:").strip().lower()


def evaluate(plan: Dict[str, Any], output: Dict[str, Any]) -> Dict[str, Any]:
    """One row per design element the crawl looked for, with what it means.

    outcome: confirmed (the Automation KB selector still resolves), new
    (captured, no Automation KB entry yet), healed (the Automation KB selector
    failed, another way found it), kb_failed (neither), not_found, or
    not_applicable (an optional step whose screen was not shown).
    """
    descriptors = {(el["screen_id"], el["element_id"]): el for els in plan["screens"].values() for el in els}
    for item in plan["items"]:
        if item.get("element"):
            descriptors[(item["element"]["screen_id"], item["element"]["element_id"])] = item["element"]
    captures: Dict[tuple, Dict[str, Any]] = {}
    step_status: Dict[tuple, str] = {}
    for record in output.get("sweep", []):
        captures.setdefault((record["screen_id"], record["element_id"]), record)
    for step in output.get("steps", []):
        cap = step.get("capture")
        if cap:
            key = (cap["screen_id"], cap["element_id"])
            if cap.get("found") or key not in captures:
                captures[key] = cap
            step_status[key] = step["status"]

    rows = []
    for key, el in descriptors.items():
        cap = captures.get(key)
        status = step_status.get(key)
        if cap is None:
            outcome = "not_reached"
        elif not cap.get("found"):
            outcome = "not_applicable" if status == "not_applicable" else ("kb_failed" if el.get("kb_target") else "not_found")
        elif cap.get("strategy") == "kb":
            outcome = "confirmed"
        elif el.get("kb_target"):
            outcome = "healed"
        else:
            outcome = "new"
        app_label = (cap or {}).get("app_label") or ""
        drift = bool(app_label and el.get("clean_label") and _norm(app_label) != _norm(el["clean_label"])
                     and _norm(el["clean_label"]) not in _norm(app_label)
                     and not any(_norm(a) == _norm(app_label) for a in el.get("accepted_labels", [])))
        rows.append({
            "screen_id": key[0], "element_id": key[1], "design_label": el.get("label"), "type": el.get("type"),
            "outcome": outcome, "strategy": (cap or {}).get("strategy"), "selector": (cap or {}).get("selector"),
            "ambiguous": bool((cap or {}).get("ambiguous")), "app_label": app_label or None, "label_differs": drift,
            # Found through a test-data value (an organization's name): right
            # for walking the journey, wrong as a lasting selector.
            "data_dependent": (cap or {}).get("strategy") == "data-text",
            "kb_ref": el.get("kb_ref"), "kb_target": el.get("kb_target"), "url": (cap or {}).get("url"),
            "tried": (cap or {}).get("tried", []),
        })
    summary: Dict[str, int] = {}
    for row in rows:
        summary[row["outcome"]] = summary.get(row["outcome"], 0) + 1
    return {
        "rows": sorted(rows, key=lambda r: (r["screen_id"], r["element_id"])),
        "steps": output.get("steps", []),
        "blockers": output.get("blockers", []),
        "final_url": output.get("final_url"),
        "summary": summary,
    }


# --- Proposing change sets ------------------------------------------------------------------

def proposal(evaluated: Dict[str, Any], automation_profile: Dict[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
    """The Automation KB and Journey KB changes a crawl result supports.

    Only elements the crawl captured with an unambiguous selector are
    proposed. A new selector goes into a selectors group named after its
    screen (selectors.scr_login.tab_otp) and the Journey KB element is linked
    to it. A healed one replaces the failing selector where it lives, so every
    reference to it heals together; when its group is gone (a broken
    reference), it is placed like a new one and the link is moved.
    """
    selectors = automation_profile.get("selectors") or {}
    groups: Dict[str, Dict[str, Any]] = {}
    automation: List[Dict[str, Any]] = []
    journey: List[Dict[str, Any]] = []
    for row in evaluated["rows"]:
        if row["outcome"] not in ("new", "healed") or not row["selector"] or row["ambiguous"] or row["data_dependent"]:
            continue
        ref = row.get("kb_ref") or ""
        parts = ref.split(".")
        if row["outcome"] == "healed" and len(parts) >= 3 and parts[0] == "selectors" and isinstance(selectors.get(parts[1]), dict):
            automation.append({"file": "app_profile.json", "op": "set", "path": ref, "value": row["selector"],
                               "note": f"was {row['kb_target']}; the crawl found {row['screen_id']} · {row['element_id']} with {row['strategy']}"})
            continue
        group = row["screen_id"].lower()
        groups.setdefault(group, {})[row["element_id"]] = row["selector"]
        new_ref = f"selectors.{group}.{row['element_id']}"
        journey.append({"file": "screens.json", "op": "set",
                        "path": f"screens[screen_id={row['screen_id']}].elements[element_id={row['element_id']}].automation_ref",
                        "value": new_ref, "note": f"captured by the crawl ({row['strategy']})"})
    for group, entries in groups.items():
        existing = selectors.get(group) if isinstance(selectors.get(group), dict) else {}
        automation.append({"file": "app_profile.json", "op": "set", "path": f"selectors.{group}",
                           "value": {**existing, **entries}, "note": f"{len(entries)} selector(s) captured by the crawl"})
    return {"automation": automation, "journey": journey}
