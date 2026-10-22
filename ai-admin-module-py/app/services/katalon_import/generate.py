"""Per data row: one built step list -> manual test case, Playwright spec, Katalon script.

The three are renderings of the same list, so they cannot disagree. Every
step carries a marker in both scripts ("// [TC 12] dashboard_menu.3"), and
`conformance` reads the markers back -- from the scripts generated here or
from a script someone edited and uploaded -- and lists every difference.

Data conditions are decided here, per row: a case holds exactly the steps
its row takes. A branch the export does not contain (the converter's "Not
run with this test data") makes the case incomplete rather than silently
shorter.
"""
from __future__ import annotations

import json
import re
from typing import Optional

from .model import Undecidable, evaluate

SYNTHETIC = {"email": "automation.test@example.com", "number": "0500000000"}
EXCLUDE_REVIEW = re.compile(r"not\s+yet\s+implement|duplicate", re.I)
_PH = re.compile(r"\{(?:(vault|env|runtime|gen|synthetic|expr):)?([^{}]+)\}")


# --- Deciding a row -------------------------------------------------------------------

def _env_for(bindings: dict, row: dict) -> dict:
    env = {}
    for name, b in (bindings or {}).items():
        if b.get("kind") == "data":
            env[name] = row.get(b["column"], "")
        elif b.get("kind") == "literal":
            env[name] = b.get("value")
    return env


def _decide(cond: dict, row: dict) -> Optional[bool]:
    """True/False for a data condition; None when it stays a run-time check."""
    if cond.get("kind") != "data":
        return None
    try:
        return evaluate(cond["expr"], _env_for(cond.get("bindings"), row))
    except Undecidable:
        return None


def row_key(row: dict, key_column: Optional[str]) -> str:
    if key_column and row.get(key_column):
        return row[key_column]
    return next((v for v in row.values() if v), "row")


def build_case(model: dict, row: dict, *, key_column: Optional[str], title: str, profile_values: dict) -> dict:
    conds = model["conditions"]
    steps: list[dict] = []
    problems: list[dict] = []
    columns_used: set[str] = set()

    def live(cond_ids: list[str]) -> tuple[bool, list[str]]:
        kept = []
        for cid in cond_ids:
            decision = _decide(conds[cid], row)
            if decision is False:
                return False, []
            if decision is None:
                kept.append(cid)
        return True, kept

    for comp in model["components"]:
        on, comp_conds = live(comp.get("when") or [])
        if not on:
            continue
        for gap in comp.get("gaps") or []:
            gap_on, _ = live(gap.get("conds") or [])
            if not gap_on:
                continue
            try:
                takes = evaluate(gap["expr"], _env_for(gap.get("bindings"), row))
            except Undecidable:
                takes = None
            if takes:
                problems.append({"severity": "high", "component": comp["id"],
                                 "text": f"This row takes the branch '{gap['expr']}' ({gap['steps_skipped']} steps), "
                                         "which the export does not contain. Export the test case for a row that takes it."})
            elif takes is None:
                problems.append({"severity": "info", "component": comp["id"],
                                 "text": f"Could not decide '{gap['expr']}' for this row; check it takes the exported path."})
        for step in comp["steps"]:
            on, kept = live(step.get("conds") or [])
            if not on:
                continue
            columns_used.update(re.findall(r"\{(\w+)\}", json.dumps([step.get("target"), (step.get("value") or {}).get("template"),
                                                                      step.get("action")])))
            steps.append({**step, "n": len(steps) + 1, "component": comp["id"], "live_conds": comp_conds + kept})

    for col in sorted(columns_used):
        if col in row and not row.get(col):
            problems.append({"severity": "high", "component": None, "text": f"Column '{col}' is empty for this row but a step needs it."})
    review = row.get("Review") or row.get("review") or ""
    status = "ready"
    if EXCLUDE_REVIEW.search(review):
        status = "excluded"
        problems.insert(0, {"severity": "info", "component": None, "text": f"The data sheet marks this row: '{review}'."})
    elif any(p["severity"] == "high" for p in problems):
        status = "incomplete"
    key = row_key(row, key_column)
    return {
        "case_id": key, "title": row.get("TestCaseName") or f"{title} - {key}", "status": status,
        "problems": problems, "row": row, "steps": steps, "profile_values": profile_values,
    }


# --- Placeholders -----------------------------------------------------------------------

def _parts(template: Optional[str], columns: set[str]) -> list[tuple[str, str, str]]:
    """'Plan {planName}' -> [('lit','Plan ',''), ('data','planName','')]."""
    if template is None:
        return []
    out, pos = [], 0
    for m in _PH.finditer(template):
        kind, name = m.group(1), m.group(2)
        if kind is None and name not in columns:
            continue
        if m.start() > pos:
            out.append(("lit", template[pos:m.start()], ""))
        out.append((kind or "data", name, ""))
        pos = m.end()
    if pos < len(template):
        out.append(("lit", template[pos:], ""))
    return out


def render_text(template: Optional[str], row: dict, profile_values: dict) -> str:
    if template is None:
        return ""
    out = []
    for kind, name, _ in _parts(template, set(row)):
        if kind == "lit":
            out.append(name)
        elif kind == "data":
            out.append(row.get(name, "") or f"<{name}>")
        elif kind == "vault":
            out.append(f"<{name} from the vault>")
        elif kind == "env":
            out.append(profile_values.get(name) or f"<{name}>")
        elif kind == "runtime":
            out.append(f"<{name} captured at run time>")
        elif kind == "gen":
            out.append(_gen_text(name))
        elif kind == "synthetic":
            out.append(SYNTHETIC.get(name, f"<{name}>"))
        else:
            out.append(f"<{name}>")
    return "".join(out)


def _gen_text(spec: str) -> str:
    kind, _, rest = spec.partition(":")
    if kind == "digits":
        prefix, _, n = rest.partition(":")
        return f"<'{prefix}' + {n} random digits>"
    if kind == "date":
        return f"<today {rest} days, dd/MM/yyyy>"
    return f"<{spec}>"


def _ts_string(template: Optional[str], row: dict, profile_values: dict) -> str:
    if template is None:
        return "''"
    pieces = []
    for kind, name, _ in _parts(template, set(row)):
        if kind == "lit":
            pieces.append(name.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${"))
        elif kind == "data":
            pieces.append("${row[" + json.dumps(name) + "]}")
        elif kind == "vault":
            pieces.append("${k.secret(" + json.dumps(name) + ")}")
        elif kind == "env":
            pieces.append("${k.env(" + json.dumps(name) + ", " + json.dumps(profile_values.get(name, "")) + ")}")
        elif kind == "runtime":
            pieces.append("${k.vars[" + json.dumps(name) + "] ?? ''}")
        elif kind == "gen":
            g, _, rest = name.partition(":")
            if g == "digits":
                prefix, _, n = rest.partition(":")
                pieces.append("${k.genDigits(" + json.dumps(prefix) + ", " + (n or "7") + ")}")
            else:
                pieces.append("${k.genDate(" + str(int(rest or 0)) + ")}")
        elif kind == "synthetic":
            pieces.append(SYNTHETIC.get(name, name))
        else:
            pieces.append("${k.expr(" + json.dumps(name) + ")}")
    return "`" + "".join(pieces) + "`"


def _groovy_string(template: Optional[str], row: dict, profile_values: dict) -> str:
    if template is None:
        return "''"
    pieces, dynamic = [], False
    for kind, name, _ in _parts(template, set(row)):
        if kind == "lit":
            pieces.append(name.replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$"))
            continue
        dynamic = True
        if kind == "data":
            pieces.append("${row['" + name + "']}")
        elif kind in ("vault", "env"):
            pieces.append("${GlobalVariable." + name + "}")
        elif kind == "runtime":
            pieces.append("${vars['" + name + "'] ?: ''}")
        elif kind == "gen":
            g, _, rest = name.partition(":")
            if g == "digits":
                prefix, _, n = rest.partition(":")
                pieces.append("${'" + prefix + "' + CustomKeywords.'dbUtil.dbutility.generateRandomNumber'(" + (n or "7") + ")}")
            else:
                pieces.append("${CustomKeywords.'dbUtil.dbutility.currentDate'(" + str(int(rest or 0)) + ")}")
        elif kind == "synthetic":
            pieces.append(SYNTHETIC.get(name, name))
        else:
            pieces.append("${/* " + name.replace("*/", "") + " */ ''}")
    body = "".join(pieces)
    return f'"{body}"' if dynamic else "'" + body.replace("\\$", "$").replace('\\"', '"').replace("'", "\\'") + "'"


# --- Manual test case -------------------------------------------------------------------

def cond_text(cond: dict, row: dict, profile_values: dict) -> str:
    kind = cond.get("kind")
    label = render_text(_shown_label(cond), row, profile_values)
    if kind == "ui":
        verb = "is displayed" if cond.get("state") == "visible" else "is present"
        return f"If {label} {verb.replace('is ', 'is not ') if cond.get('negate') else verb}"
    if kind == "ui_empty":
        return f"If {label} is {'not ' if cond.get('negate') else ''}empty"
    if kind == "ui_not_selected":
        return f"If {label or 'the field'} is not already selected"
    if kind == "try":
        return "Optional (continue if this fails)"
    if kind == "fallback":
        return "If the previous block failed"
    if kind == "loop":
        return "Repeat until done"
    return f"If {cond.get('expr') or cond.get('text')} (decided at run time)"


def _shown_label(cond: dict) -> str:
    params = cond.get("params") or {}
    value = next(iter(params.values()), None) if params else None
    label = cond.get("label") or ""
    return f"{label} '{value}'" if value else label


def manual_rows(case: dict, model: dict) -> list[dict]:
    rows, pv = [], case["profile_values"]
    for s in case["steps"]:
        when = [cond_text(model["conditions"][c], case["row"], pv) for c in s["live_conds"]]
        data = render_text((s.get("value") or {}).get("template"), case["row"], pv) if s.get("value") else ""
        rows.append({
            "n": s["n"], "component": s["component"], "key": s["id"], "source": s.get("source"),
            "when": when, "action": render_text(s["action"], case["row"], pv), "data": data,
            "expected": render_text(s.get("expected") or "", case["row"], pv), "type": s["type"],
            "target": render_text(s.get("target"), case["row"], pv) if s.get("target") else None,
        })
    return rows


# --- Playwright ------------------------------------------------------------------------------

def _common_prefix(a: list[str], b: list[str]) -> int:
    n = 0
    while n < len(a) and n < len(b) and a[n] == b[n]:
        n += 1
    return n


def _ts_cond(cond: dict, row: dict, pv: dict) -> tuple[str, str]:
    """(opening line, closing line) for a condition block."""
    kind = cond.get("kind")
    target = _ts_string(cond.get("target"), row, pv) if cond.get("target") else None
    if kind == "ui" and target:
        call = f"await k.isVisible({target})" if cond.get("state") == "visible" else f"await k.isPresent({target})"
        return f"if ({'!' if cond.get('negate') else ''}{call}) {{", "}"
    if kind == "ui_empty" and target:
        return f"if ({'!' if cond.get('negate') else ''}await k.isEmpty({target})) {{", "}"
    if kind == "ui_not_selected" and target:
        return f"if (!(await k.isChecked({target}))) {{", "}"
    if kind == "try":
        return "await k.optional(async () => {", "});"
    if kind == "fallback":
        return "if (k.lastOptionalFailed) {", "}"
    if kind == "loop":
        return "{ // repeat: the export shows one pass", "}"
    return f"if (await k.when({json.dumps(cond.get('expr') or cond.get('text'))})) {{", "}"


def _ts_step(s: dict, row: dict, pv: dict) -> list[str]:
    t = s["type"]
    target = _ts_string(s.get("target"), row, pv) if s.get("target") else None
    value = _ts_string((s.get("value") or {}).get("template"), row, pv) if s.get("value") else "''"
    secs = s.get("seconds") or 0
    if t == "navigate":
        return [f"await k.navigate({value});"]
    if t in ("assert_visible", "assert_present") and target:
        return [f"await k.assertVisible({target});" if t == "assert_visible" else f"await k.assertPresent({target});"]
    if t == "fill" and target:
        return [f"await k.fill({target}, {value});"]
    if t == "select" and target:
        return [f"await k.select({target}, {value});"]
    if t == "clear" and target:
        return [f"await k.clear({target});"]
    if t == "check" and target:
        return [f"await k.check({target});"]
    if t == "scroll" and target:
        return [f"await k.scrollTo({target});"]
    if t == "click" and target:
        return [f"await k.click({target});"]
    if t == "wait":
        return [f"await k.wait({secs});"]
    if t == "wait_visible" and target:
        return [f"await k.waitVisible({target}, {secs});"]
    if t == "wait_hidden" and target:
        # Only the "still visible after N s: fail" pattern fails; a plain wait does not.
        if s.get("note"):
            return [f"await k.waitHidden({target}, {secs}, {json.dumps(s['note'])});"]
        return [f"await k.waitGone({target}, {secs});"]
    if t == "frame" and target:
        return [f"await k.switchToFrame({target});"]
    if t == "reload":
        return ["await k.reload();"]
    if t == "press" and target:
        return [f"await k.press({target}, {json.dumps(s.get('key') or 'Tab')});"]
    if t == "fail":
        return [f"k.fail({json.dumps(s.get('label') or 'Stopped')});"]
    if t == "capture":
        return [f"k.vars['requestId'] = await k.captureOrder({target}, {_ts_string(s.get('error_target'), row, pv)}, {secs});"]
    if t in ("db_prep", "db_check"):
        db = s.get("db") or {}
        payload = {"step": s["id"], "name": s.get("label"), "keyword": s.get("keyword"),
                   "connections": db.get("connections"), "statements": [x["sql"] for x in db.get("statements") or []],
                   "requireRows": bool(db.get("count_guard_missing"))}
        inputs = ", ".join(f"{json.dumps(k_)}: {_ts_string(v, row, pv)}" for k_, v in (db.get("inputs") or {}).items() if v)
        fn = "prep" if t == "db_prep" else "check"
        return [f"await k.db.{fn}({json.dumps(payload)}, {{ {inputs} }});"]
    if t == "manual":
        return [f"await k.manual({json.dumps(s.get('action'))});"]
    return [f"await k.manual({json.dumps('Not scriptable from the export: ' + (s.get('action') or ''))});"]


def playwright_spec(case: dict, model: dict, meta: dict) -> str:
    row, pv = case["row"], case["profile_values"]
    safe_row = {k_: v for k_, v in row.items()}
    lines = [
        "// Generated by Katalon Import from the QA team's Katalon export -- do not edit by hand.",
        f"// Source test case: {meta.get('katalon_test_case') or meta.get('title')}",
        f"// Data row: {case['case_id']} ({meta.get('data_sheet') or 'test data'})",
        "// Every step carries a [TC n] marker matching the manual test case; edit the KB, then regenerate.",
        "import { test } from '@playwright/test';",
        "import { Katalon } from '../support/katalon-shim';",
        "",
        f"const row: Record<string, string> = {json.dumps(safe_row, ensure_ascii=False, indent=2)};",
        "",
        f"test({json.dumps(case['case_id'] + ' ' + case['title'])}, async ({{ page }}, testInfo) => {{",
        "  const k = new Katalon(page, testInfo);",
    ]
    open_stack: list[tuple[str, str]] = []
    for s in case["steps"]:
        want = s["live_conds"]
        keep = _common_prefix([c for c, _ in open_stack], want)
        while len(open_stack) > keep:
            _, closing = open_stack.pop()
            lines.append("  " * (len(open_stack) + 1) + closing)
        for cid in want[keep:]:
            opening, closing = _ts_cond(model["conditions"][cid], row, pv)
            lines.append("  " * (len(open_stack) + 1) + opening)
            open_stack.append((cid, closing))
        pad = "  " * (len(open_stack) + 1)
        title = f"TC {s['n']} · " + render_text(s["action"], row, pv)
        lines.append(f"{pad}// [TC {s['n']}] {s['id']}")
        body = _ts_step(s, row, pv)
        lines.append(f"{pad}await k.step({json.dumps(title[:180], ensure_ascii=False)}, async () => {{ {' '.join(body)} }});")
    while open_stack:
        _, closing = open_stack.pop()
        lines.append("  " * (len(open_stack) + 1) + closing)
    lines.append("});")
    return "\n".join(lines) + "\n"


# --- Katalon -------------------------------------------------------------------------------

def _k_obj(s_or_c: dict, row: dict, pv: dict) -> Optional[str]:
    path = s_or_c.get("object")
    if not path:
        return None
    params = s_or_c.get("params") or {}
    if not params:
        return f"findTestObject('{path}')"
    key = next(iter(params))
    name = "value" if key in ("?0", "_") else key
    return f"findTestObject('{path}', [('{name}') : {_groovy_string(params[key], row, pv)}])"


def _groovy_cond(cond: dict, row: dict, pv: dict) -> tuple[str, str]:
    kind = cond.get("kind")
    obj = _k_obj(cond, row, pv)
    if kind == "ui" and obj:
        call = (f"WebUI.waitForElementVisible({obj}, condTimeout, FailureHandling.OPTIONAL)" if cond.get("state") == "visible"
                else f"WebUI.waitForElementPresent({obj}, condTimeout, FailureHandling.OPTIONAL)")
        return f"if ({'!' if cond.get('negate') else ''}{call}) {{", "}"
    if kind == "ui_empty" and obj:
        call = f"WebUI.getAttribute({obj}, 'value').isEmpty()"
        return f"if ({'!' if cond.get('negate') else ''}{call}) {{", "}"
    if kind == "try":
        return "try {", "} catch (Exception e) { lastOptionalFailed = true }"
    if kind == "fallback":
        return "if (lastOptionalFailed) {", "}"
    if kind == "loop":
        return "{ // repeat: the export shows one pass", "}"
    if kind == "ui_not_selected":
        return "if (true) { // the source checks element.isSelected() on the field above", "}"
    return f"if (false) {{ // decided at run time in the source: {(cond.get('expr') or cond.get('text') or '').replace('*/', '')}", "}"


def _groovy_step(s: dict, row: dict, pv: dict) -> list[str]:
    t = s["type"]
    obj = _k_obj(s, row, pv)
    value = _groovy_string((s.get("value") or {}).get("template"), row, pv) if s.get("value") else "''"
    secs = s.get("seconds") or 0
    if t == "navigate":
        return [f"CustomKeywords.'utilities.browserUtil.launchChrome'({value})"]
    if t == "assert_visible" and obj:
        return [f"WebUI.verifyElementVisible({obj})"]
    if t == "assert_present" and obj:
        return [f"WebUI.verifyElementPresent({obj}, waitTime)"]
    if t == "fill" and obj:
        return [f"WebUI.setText({obj}, {value})"]
    if t == "select" and obj:
        return [f"WebUI.selectOptionByLabel({obj}, {value}, false)"]
    if t == "clear" and obj:
        return [f"WebUI.clearText({obj})"]
    if t == "check" and obj:
        return [f"WebUI.check({obj})"]
    if t == "scroll" and obj:
        return [f"WebUI.scrollToElement({obj}, waitTime)"]
    if t == "click" and obj:
        return [f"WebUI.click({obj})"]
    if t == "wait":
        return [f"WebUI.delay({secs})"]
    if t == "wait_visible" and obj:
        return [f"WebUI.waitForElementVisible({obj}, {secs}, FailureHandling.OPTIONAL)"]
    if t == "wait_hidden" and obj:
        if s.get("note"):
            return [f"if (!WebUI.waitForElementNotVisible({obj}, {secs}, FailureHandling.OPTIONAL)) {{ KeywordUtil.markFailedAndStop({json.dumps(s['note'])}) }}"]
        return [f"WebUI.waitForElementNotVisible({obj}, {secs}, FailureHandling.OPTIONAL)"]
    if t == "frame" and obj:
        return [f"WebUI.switchToFrame({obj}, waitTime)"]
    if t == "reload":
        return ["WebUI.refresh()"]
    if t == "press" and obj:
        return [f"WebUI.sendKeys({obj}, Keys.chord(Keys.{(s.get('key') or 'Tab').upper()}))"]
    if t == "fail":
        return [f"KeywordUtil.markFailedAndStop({json.dumps(s.get('label') or 'Stopped')})"]
    if t == "capture":
        return [f"vars['requestId'] = CustomKeywords.'{s.get('keyword') or 'gui.OrderCreated.confirmOrderCreated'}'({secs})"]
    if t in ("db_prep", "db_check"):
        ref = s.get("keyword") or ""
        inputs = (s.get("db") or {}).get("inputs") or {}
        if s.get("katalon_kind") == "test case":
            args = ", ".join(f"('{k_}') : {_groovy_string(v, row, pv)}" for k_, v in inputs.items() if v) or ":"
            return [f"WebUI.callTestCase(findTestCase('{ref}'), [{args}], FailureHandling.STOP_ON_FAILURE)"]
        args = ", ".join(_groovy_string(v, row, pv) for v in inputs.values() if v)
        return [f"CustomKeywords.'{ref}'({args})"]
    if t == "manual":
        return [f"KeywordUtil.markWarning({json.dumps('Manual step: ' + (s.get('action') or ''))})"]
    return [f"KeywordUtil.markWarning({json.dumps('Not scriptable from the export: ' + (s.get('action') or ''))})"]


def katalon_script(case: dict, model: dict, meta: dict) -> str:
    row, pv = case["row"], case["profile_values"]
    row_literal = ", ".join(f"('{k_}') : {_groovy_string(v, {}, pv)}" for k_, v in row.items())
    lines = [
        "// Generated by Katalon Import -- runs inside the QA team's Katalon project (its Object Repository,",
        "// Keywords and profiles). Every step carries a [TC n] marker matching the manual test case.",
        f"// Source test case: {meta.get('katalon_test_case') or meta.get('title')}",
        f"// Data row: {case['case_id']}",
        "import static com.kms.katalon.core.testobject.ObjectRepository.findTestObject",
        "import static com.kms.katalon.core.testcase.TestCaseFactory.findTestCase",
        "import com.kms.katalon.core.model.FailureHandling",
        "import com.kms.katalon.core.util.KeywordUtil",
        "import com.kms.katalon.core.webui.keyword.WebUiBuiltInKeywords as WebUI",
        "import internal.GlobalVariable",
        "import org.openqa.selenium.Keys",
        "",
        f"Map row = [{row_literal or ':'}]",
        "Map vars = [:]",
        "int condTimeout = 2",
        "int waitTime = GlobalVariable.waitTime ?: 5",
        "boolean lastOptionalFailed = false",
        "",
    ]
    open_stack: list[tuple[str, str]] = []
    for s in case["steps"]:
        want = s["live_conds"]
        keep = _common_prefix([c for c, _ in open_stack], want)
        while len(open_stack) > keep:
            _, closing = open_stack.pop()
            lines.append("    " * len(open_stack) + closing)
        for cid in want[keep:]:
            opening, closing = _groovy_cond(model["conditions"][cid], row, pv)
            lines.append("    " * len(open_stack) + opening)
            open_stack.append((cid, closing))
        pad = "    " * len(open_stack)
        lines.append(f"{pad}// [TC {s['n']}] {s['id']} :: {render_text(s['action'], row, pv)[:140]}")
        lines.extend(pad + line for line in _groovy_step(s, row, pv))
    while open_stack:
        _, closing = open_stack.pop()
        lines.append("    " * len(open_stack) + closing)
    return "\n".join(lines) + "\n"


# --- Conformance ----------------------------------------------------------------------------

_MARKER = re.compile(r"//\s*\[TC\s+(\d+)\]\s+([\w.]+)")


def conformance(case: dict, script: str, framework: str) -> dict:
    """Does the script do exactly the case's steps, in order, on the case's targets?"""
    found = [(int(m.group(1)), m.group(2), m.end()) for m in _MARKER.finditer(script)]
    expected = [(s["n"], s["id"]) for s in case["steps"]]
    issues: list[dict] = []
    got = [(n, key) for n, key, _ in found]
    if got != expected:
        exp_set, got_set = set(expected), set(got)
        for n, key in expected:
            if (n, key) not in got_set:
                issues.append({"n": n, "key": key, "problem": "missing from the script"})
        for n, key in got:
            if (n, key) not in exp_set:
                issues.append({"n": n, "key": key, "problem": "in the script but not in the test case"})
        if not issues:
            issues.append({"n": None, "key": None, "problem": "the steps are in a different order"})
    row, pv = case["row"], case["profile_values"]
    by_key = {s["id"]: s for s in case["steps"]}
    for i, (n, key, end) in enumerate(found):
        step = by_key.get(key)
        if not step:
            continue
        chunk = script[end: found[i + 1][2] if i + 1 < len(found) else len(script)]
        if framework == "katalon":
            needle = step.get("object")
        else:
            needle = _ts_string(step.get("target"), row, pv) if step.get("target") else None
        if needle and needle not in chunk:
            issues.append({"n": n, "key": key, "problem": "the step does not use the test case's locator"})
    return {"framework": framework, "ok": not issues, "tc_steps": len(expected), "script_steps": len(found), "issues": issues[:50]}


# --- Shared Playwright support ------------------------------------------------------------

PLAYWRIGHT_SHIM = r"""// Katalon semantics on Playwright, so generated specs read like the source test case.
// Frames: switchToFrame() stays in force for later steps, as WebUI.switchToFrame does.
// Secrets come from the environment (KATALON_<name>), never from the generated files.
import { expect, type Page, type FrameLocator, type Locator, type TestInfo, test } from '@playwright/test';
import { DbHooks } from './db';

const COND_TIMEOUT_MS = Number(process.env.KATALON_COND_TIMEOUT_MS ?? 2000);
const STEP_TIMEOUT_MS = Number(process.env.KATALON_STEP_TIMEOUT_MS ?? 30000);

export class Katalon {
  vars: Record<string, string> = {};
  lastOptionalFailed = false;
  db: DbHooks;
  private scope: Page | FrameLocator;

  constructor(private page: Page, private info: TestInfo) {
    this.scope = page;
    this.db = new DbHooks(info, this.vars);
  }

  loc(xpath: string): Locator { return this.scope.locator(`xpath=${xpath}`).first(); }
  step(title: string, body: () => Promise<void>) { return test.step(title, body); }

  secret(name: string): string {
    const v = process.env[`KATALON_${name}`];
    if (!v) throw new Error(`Set KATALON_${name} in the environment (it is never written into generated files).`);
    return v;
  }
  env(name: string, fallback: string): string { return process.env[`KATALON_${name}`] ?? fallback; }
  expr(text: string): string { throw new Error(`Expression not translated from the export: ${text}`); }
  genDigits(prefix: string, n: number): string {
    let s = prefix; for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10); return s;
  }
  genDate(offsetDays: number): string {
    const d = new Date(Date.now() + offsetDays * 86400000);
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  }

  async navigate(url: string) { await this.page.goto(url); this.scope = this.page; }
  async reload() { await this.page.reload(); this.scope = this.page; }
  async switchToFrame(xpath: string) { this.scope = this.scope.frameLocator(`xpath=${xpath}`); }
  async defaultContent() { this.scope = this.page; }

  async click(x: string) { await this.loc(x).click({ timeout: STEP_TIMEOUT_MS }); }
  async fill(x: string, v: string) { await this.loc(x).fill(v, { timeout: STEP_TIMEOUT_MS }); }
  async clear(x: string) { await this.loc(x).fill('', { timeout: STEP_TIMEOUT_MS }); }
  async check(x: string) { await this.loc(x).check({ timeout: STEP_TIMEOUT_MS }); }
  async press(x: string, key: string) { await this.loc(x).press(key); }
  async scrollTo(x: string) { await this.loc(x).scrollIntoViewIfNeeded({ timeout: STEP_TIMEOUT_MS }); }
  async select(x: string, v: string) {
    const el = this.loc(x);
    try { await el.selectOption({ label: v }, { timeout: STEP_TIMEOUT_MS }); }
    catch { await el.selectOption({ value: v }, { timeout: STEP_TIMEOUT_MS }); }
  }
  async assertVisible(x: string) { await expect(this.loc(x)).toBeVisible({ timeout: STEP_TIMEOUT_MS }); }
  async assertPresent(x: string) { await expect(this.loc(x)).toBeAttached({ timeout: STEP_TIMEOUT_MS }); }
  async wait(seconds: number) { await this.page.waitForTimeout(seconds * 1000); }
  async waitVisible(x: string, s: number) { await this.loc(x).waitFor({ state: 'visible', timeout: s * 1000 }).catch(() => {}); }
  async waitGone(x: string, s: number) { await this.loc(x).waitFor({ state: 'hidden', timeout: s * 1000 }).catch(() => {}); }
  async waitHidden(x: string, s: number, failMessage: string) {
    try { await this.loc(x).waitFor({ state: 'hidden', timeout: s * 1000 }); }
    catch { throw new Error(failMessage); }
  }

  async isVisible(x: string) { return this.loc(x).waitFor({ state: 'visible', timeout: COND_TIMEOUT_MS }).then(() => true, () => false); }
  async isPresent(x: string) { return this.loc(x).waitFor({ state: 'attached', timeout: COND_TIMEOUT_MS }).then(() => true, () => false); }
  async isEmpty(x: string) { return (await this.loc(x).inputValue().catch(() => '')) === ''; }
  async isChecked(x: string) { return this.loc(x).isChecked().catch(() => false); }
  /** A condition the export could only describe; the team decides it in support/runtime-conditions. */
  async when(expression: string) {
    this.info.annotations.push({ type: 'runtime-condition', description: `${expression}: not decided here, block skipped` });
    return false;
  }
  async optional(body: () => Promise<void>) {
    try { await body(); this.lastOptionalFailed = false; } catch { this.lastOptionalFailed = true; }
  }
  fail(message: string): never { throw new Error(message); }
  async manual(text: string) { this.info.annotations.push({ type: 'manual-step', description: text }); }

  async captureOrder(successX: string, errorX: string, seconds: number) {
    const ok = this.loc(successX), err = this.loc(errorX);
    await Promise.race([
      ok.waitFor({ state: 'visible', timeout: seconds * 1000 }),
      err.waitFor({ state: 'attached', timeout: seconds * 1000 }),
    ]);
    if (await ok.isVisible()) {
      const text = (await ok.textContent()) ?? '';
      if (/request id/i.test(text) && text.includes('=')) return text.split('=')[1].trim();
      throw new Error(`Success message without a Request Id: ${text}`);
    }
    const message = (await err.textContent()) ?? 'unknown error';
    throw new Error(/request id/i.test(message) ? `Order created with an error (failed to submit to Wincash): ${message}` : `Order failed: ${message}`);
  }
}
"""

PLAYWRIGHT_DB = r"""// Database steps from the Katalon keywords, as data. Nothing runs unless KATALON_DB_MODE says so.
//   KATALON_DB_MODE=off    (default) prep and checks are recorded as annotations only
//   KATALON_DB_MODE=check  run read-only checks; data preparation stays off
//   KATALON_DB_MODE=all    run checks and data preparation (writes to the test databases)
// Connect with the team's own driver (e.g. oracledb / mssql) in `run` below; connection
// strings and credentials come from the environment, named after the profile variables.
import type { TestInfo } from '@playwright/test';

export interface DbStep {
  step: string; name: string; keyword?: string | null;
  connections: string[]; statements: string[]; requireRows: boolean;
}

export class DbHooks {
  private mode = (process.env.KATALON_DB_MODE ?? 'off').toLowerCase();
  constructor(private info: TestInfo, private vars: Record<string, string>) {}

  async prep(step: DbStep, inputs: Record<string, string>) {
    if (this.mode !== 'all') return this.note('db-prep-skipped', step, inputs);
    await this.run(step, inputs, false);
  }
  async check(step: DbStep, inputs: Record<string, string>) {
    if (this.mode === 'off') return this.note('db-check-pending', step, inputs);
    const rows = await this.run(step, inputs, true);
    if (step.requireRows && rows === 0) throw new Error(`${step.name}: no rows -- the request was not found, so it cannot be closed.`);
  }
  private note(type: string, step: DbStep, inputs: Record<string, string>) {
    this.info.annotations.push({ type, description: `${step.step} ${step.name} ${JSON.stringify(inputs)}` });
  }
  /** Implement with the team's driver. Returns the number of rows the checks read. */
  protected async run(step: DbStep, inputs: Record<string, string>, readOnly: boolean): Promise<number> {
    throw new Error(`KATALON_DB_MODE=${this.mode} but support/db.ts has no driver yet (${step.connections.join(', ')}).`);
  }
}
"""

PLAYWRIGHT_CONFIG = """import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 15 * 60 * 1000,
  retries: 0,
  use: {
    channel: process.env.KATALON_BROWSER_CHANNEL ?? 'chrome',
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  reporter: [['html', { open: 'never' }], ['list']],
});
"""
