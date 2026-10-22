"""What the uploads contain, what is missing, and what is fragile or wrong -- as findings.

Every finding says what to do next. Severity: high (blocks a correct test or
leaks something), medium (works today, breaks easily), info (worth knowing).
"""
from __future__ import annotations

import collections
import re
from typing import Any, Optional

INPUT_KINDS = {
    "converter_md": ("Converted test case (.md)", "The steps. Required: one file per Katalon test case."),
    "object_repository": ("Object Repository (.rs or the export's locator section)", "The locator behind every object."),
    "test_data": ("Test data (.dat, .csv, .xlsx)", "One test case per row; decides each row's branches."),
    "keywords": ("Keywords (.groovy)", "What the database steps really run, and on which system."),
    "profile": ("Execution profile (.glbl)", "Application URL, environment and database hosts. Secrets are dropped on read."),
    "scripts": ("Test case scripts (.groovy)", "Optional; kept for reference."),
}


def _issue(code: str, text: str, severity: str) -> dict:
    return {"code": code, "text": text, "severity": severity}


def locator_issues(xpath: Optional[str]) -> list[dict]:
    if not xpath:
        return [_issue("no_locator", "No locator: the object is not in the export or the uploaded .rs files.", "high")]
    out = []
    if re.search(r"@text\(\)", xpath):
        out.append(_issue("dead_clause", "'@text()' never matches anything; that alternative is dead (the others still work).", "medium"))
    if re.search(r"@style\s*=", xpath):
        out.append(_issue("style", "Matches an inline style ('display: block;'); breaks if the style string changes. Match the class and check visibility instead.", "medium"))
    if re.search(r"\)\[\d+\]|/\w+\[\d+\]", xpath):
        out.append(_issue("position", "Depends on element position; breaks when the layout changes.", "medium"))
    if re.search(r"text\(\)\s*=\s*'", xpath):
        out.append(_issue("exact_text", "Exact text() match; extra whitespace breaks it. normalize-space() is safer.", "info"))
    if re.search(r"@class\s*=\s*'[^']*\s[^']*'", xpath):
        out.append(_issue("exact_class", "Matches the whole class attribute; a change in class order or an added class breaks it.", "info"))
    if re.search(r"//[A-Z]\w*\[", xpath):
        out.append(_issue("upper_tag", "Upper-case tag name; works in HTML pages, fails in XHTML/XML documents.", "info"))
    return out


def analyse(*, inputs: list[dict], mds: list[dict], models: list[dict], repository: list[dict], tables: list[dict],
            profile: Optional[dict], keyword_classes: list[dict], cases: list[dict], secrets_dropped: dict) -> dict:
    findings: list[dict] = []

    def add(severity: str, category: str, title: str, detail: str, action: str, **extra: Any) -> None:
        findings.append({"id": f"F{len(findings) + 1}", "severity": severity, "category": category,
                         "title": title, "detail": detail, "action": action, **extra})

    kinds = collections.Counter(i["kind"] for i in inputs if i.get("kind"))
    has_locators = bool(repository) or any(md.get("locators") for md in mds)
    checklist = []
    for key, (label, why) in INPUT_KINDS.items():
        present = kinds.get(key, 0) > 0 or (key == "object_repository" and has_locators)
        checklist.append({"key": key, "label": label, "why": why, "present": present,
                          "count": kinds.get(key, 0) if key != "object_repository" else len(repository) or sum(len(m.get("locators") or []) for m in mds)})

    # --- inputs
    if not mds:
        add("high", "inputs", "No converted test case", "Nothing to build from: upload the converter's .md export of a Katalon test case.",
            "Upload at least one converted test case (.md).")
    for md in mds:
        if md.get("format") == "v1" and not repository:
            add("high", "inputs", f"{md['title']}: no locators",
                "This export is the older format without the 'Element locators' section, so the objects have no XPath.",
                "Re-export with the newer converter, or upload the Object Repository .rs files.")
    if mds and not tables:
        add("medium", "inputs", "No test data sheet", "Only the export's own data row is known; no other rows can be built.",
            "Upload the Katalon data file (.dat) or the sheet as .csv/.xlsx.")
    if mds and not keyword_classes:
        add("medium", "inputs", "No keyword sources", "Database steps are known only by the SQL the converter printed (truncated) and not by the system they run on.",
            "Upload the Keywords folder (.groovy).")
    if mds and not profile:
        add("info", "inputs", "No execution profile", "The application URL and database hosts are unknown; scripts read them from the environment.",
            "Upload the profile (.glbl). Secrets in it are dropped on read.")

    # --- secrets
    if secrets_dropped.get("secret") or secrets_dropped.get("user"):
        add("high", "security", "The profile holds plaintext credentials",
            f"{secrets_dropped.get('secret', 0)} secret values (passwords, card numbers) and {secrets_dropped.get('user', 0)} user names "
            f"were in {secrets_dropped.get('file') or 'the profile'}. They were not stored, shown or put into any output.",
            "Keep the profile inside the QA team. If it was shared beyond them, ask for the passwords to be rotated. Scripts read secrets from the environment (KATALON_<name>).")
    sensitive_cols = []
    for t in tables:
        for col in t["columns"]:
            values = [r.get(col, "") for r in t["rows"] if r.get(col)]
            if values and sum(1 for v in values if re.fullmatch(r"\d{9,22}", v)) >= max(1, len(values) * 0.8):
                sensitive_cols.append(f"{t['name']}.{col}")
    if sensitive_cols:
        add("info", "security", "Test data holds live test-pool numbers",
            f"Columns {', '.join(sensitive_cols)} hold MSISDN/ICCID-like numbers. They stay in this import's test data and are not written into the Knowledge Base.",
            "Treat the generated test data files as internal.")

    # --- locators
    locator_rows = []
    used: dict[str, list[str]] = collections.defaultdict(list)
    for model in models:
        for comp in model["components"]:
            for s in comp["steps"]:
                if s.get("object"):
                    used[s["object"]].append(s["id"])
        for cond in model["conditions"].values():
            if cond.get("object"):
                used[cond["object"]].append(f"condition {cond['id']}")
    all_locators: dict[str, dict] = {}
    for md in mds:
        for loc in md.get("locators") or []:
            all_locators[loc["path"]] = loc
    for loc in repository:
        all_locators[loc["path"]] = {**all_locators.get(loc["path"], {}), **loc}
    issue_counter = collections.Counter()
    for path in sorted(set(all_locators) | set(used)):
        loc = all_locators.get(path) or {}
        xpath = (loc.get("active") or {}).get("value")
        issues = locator_issues(xpath)
        for i in issues:
            issue_counter[i["code"]] += 1
        locator_rows.append({
            "path": path, "label": loc.get("label") or path.rsplit("/", 1)[-1], "xpath": xpath,
            "method": (loc.get("active") or {}).get("method"), "params": loc.get("params") or [],
            "source": loc.get("source") or ("converter" if loc else None), "used_by": used.get(path, [])[:20],
            "uses": len(used.get(path, [])), "issues": issues, "status": "unverified",
        })
    for code, title, action in [
        ("dead_clause", "Locators with a clause that never matches", "Remove '@text() = ...' from the XPath (keep the id alternatives)."),
        ("style", "Locators that depend on an inline style", "Match on the class and let the step check visibility."),
        ("position", "Locators that depend on position", "Anchor on an id, label or text instead of an index."),
        ("no_locator", "Objects with no locator", "Upload the Object Repository .rs files for these objects."),
    ]:
        if issue_counter.get(code):
            rows = [r for r in locator_rows if any(i["code"] == code for i in r["issues"])]
            add("high" if code == "no_locator" else "medium", "locators", f"{title} ({issue_counter[code]})",
                ", ".join(f"{r['label']} ({r['path']})" for r in rows[:8]) + (" ..." if len(rows) > 8 else ""), action,
                refs=[r["path"] for r in rows])

    # --- the source scripts
    grouped: dict[str, list[dict]] = collections.defaultdict(list)
    for md in mds:
        for issue in md.get("issues") or []:
            grouped[re.sub(r"'[^']*'", "'...'", issue["text"].split(".")[0])].append(issue)
    for title, items in grouped.items():
        sev = "medium" if re.search(r"malformed|hard-coded date", title, re.I) else "info"
        where = ", ".join(f"{i['file']}:{i['line']}" for i in items)
        add(sev, "source", f"{title} ({len(items)})" if len(items) > 1 else title, f"{items[0]['text']} At {where}.",
            "Fix in the Katalon source; the generated tests already avoid it." if sev == "medium" else "No action needed in generated tests.")

    # --- keywords
    used_keywords = {s.get("keyword") for m in models for c in m["components"] for s in c["steps"] if s.get("keyword")}
    methods = {f"{c['class']}.{m['name']}": m for c in keyword_classes for m in c["methods"]}
    swallow = [k for k, m in methods.items() if m["swallows_sql_errors"]]
    if swallow:
        in_tc = [k for k in swallow if k in used_keywords]
        add("medium", "keywords", f"Database errors are swallowed ({len(swallow)} methods)",
            f"These catch SQLException, print it and carry on, so a failed data reset surfaces later as an unrelated UI failure. Used by this test: {', '.join(in_tc) or 'none directly'}.",
            "Let the SQLException fail the step (KeywordUtil.markFailedAndStop).", refs=swallow[:30])
    for m in [s for mod in models for c in mod["components"] for s in c["steps"] if (s.get("db") or {}).get("count_guard_missing")]:
        add("high", "keywords", f"'{m['label']}' can pass for a request that does not exist",
            "It compares the number of subrequests with the number at status 90. If the Request Id is not found both are 0, they match, and the check passes.",
            "Require at least one subrequest before comparing. The generated database check does (requireRows).", refs=[m["id"]])
    dml_query = [k for k, m in methods.items() if m["uses_execute_query_for_dml"]]
    if dml_query:
        add("info", "keywords", f"Data changes run through executeQuery ({len(dml_query)} methods)",
            "UPDATE/INSERT/DELETE are sent with executeQuery rather than executeUpdate; it works with the Oracle driver but hides the row count.",
            "Use executeUpdate and check the count.", refs=dml_query[:30])

    # --- the model
    systems = {}
    for v in (profile or {}).get("variables") or []:
        if v.get("kind") == "connection":
            systems[v["name"]] = v.get("connection") or {}
    db_steps = []
    for model in models:
        for comp in model["components"]:
            for s in comp["steps"]:
                if s["type"] in ("db_prep", "db_check"):
                    db = s.get("db") or {}
                    db_steps.append({
                        "id": s["id"], "component": comp["id"], "type": s["type"], "name": s["label"],
                        "keyword": s.get("keyword"), "statements": [x["sql"][:400] for x in db.get("statements") or []][:12],
                        "systems": [{"variable": c, **(systems.get(c) or {})} for c in db.get("connections") or []],
                        "source_known": db.get("source_known"), "count_guard_missing": db.get("count_guard_missing"),
                    })
    preps = [d for d in db_steps if d["type"] == "db_prep"]
    if preps:
        touched = sorted({(x.get("service") or x["variable"]) for d in preps for x in d["systems"]})
        add("info", "database", f"{len(preps)} data-preparation steps write to test databases",
            f"They reset numbers and SIMs before the run ({', '.join(touched) or 'systems unknown'}). In generated Playwright tests they are off unless KATALON_DB_MODE=all; in Katalon they call the team's own keywords.",
            "Keep them gated; run them only against the test environment.")
    gap_rows = collections.Counter()
    for case in cases:
        exprs = set()
        for p in case["problems"]:
            m = re.search(r"branch '(.*?)' \(", p["text"])
            if p["severity"] == "high" and m:
                exprs.add(m.group(1))
        gap_rows.update(exprs)
    for expr, n in gap_rows.most_common():
        add("high", "coverage", f"{n} rows need the branch '{expr}', which the export does not contain",
            "The converter printed this export for one data row, so branches that row skipped have no steps.",
            f"Export the same Katalon test case for a row where {expr} and upload it; its steps fill this branch.")
    frames = sorted({c.get("target") for m in models for c in m["conditions"].values() if c.get("kind") == "ui" and "iframe" in (c.get("target") or "")})
    frames += sorted({s.get("target") for m in models for c in m["components"] for s in c["steps"] if s["type"] == "frame" and s.get("target")})
    if frames:
        add("info", "model", "Steps run inside iframes",
            f"After the dashboard the steps run inside {', '.join(sorted(set(frames)))}. Generated scripts switch frames exactly where the source does.",
            "No action; keep this in mind when reading screenshots.")
    runtime = sum(1 for m in models for c in m["conditions"].values() if c["kind"] == "runtime")
    if runtime:
        add("info", "model", f"{runtime} conditions are decided only at run time",
            "They depend on database values or page text the export cannot know (e.g. number-pool status). Katalon keeps the team's logic; Playwright skips the block and records it.",
            "Review these blocks in the test case before relying on them.")
    manual = [s for m in models for c in m["components"] for s in c["steps"] if s["type"] in ("manual", "unparsed", "call")]
    if manual:
        add("info", "model", f"{len(manual)} steps cannot be scripted from the export",
            "; ".join(f"{s['id']}: {s['action']}" for s in manual[:6]), "They appear in the test case and as annotated manual steps in the scripts.")

    statuses = collections.Counter(c["status"] for c in cases)
    data_summary = []
    for t in tables:
        dist = {}
        for col in t["columns"]:
            values = collections.Counter(r.get(col, "") for r in t["rows"])
            if 1 < len(values) <= 40 and f"{t['name']}.{col}" not in sensitive_cols:
                dist[col] = dict(values.most_common(12))
        data_summary.append({"name": t["name"], "columns": t["columns"], "rows": len(t["rows"]), "distribution": dist,
                             "sensitive_columns": [c.split(".", 1)[1] for c in sensitive_cols if c.startswith(t["name"] + ".")]})
    order = {"high": 0, "medium": 1, "info": 2}
    findings.sort(key=lambda f: order.get(f["severity"], 3))
    env_values = {v["name"]: v.get("value") for v in (profile or {}).get("variables") or [] if v.get("kind") in ("url", "setting")}
    return {
        "checklist": checklist,
        "findings": findings,
        "summary": {
            "findings": dict(collections.Counter(f["severity"] for f in findings)),
            "test_cases": len(mds), "components": sum(len(m["components"]) for m in models),
            "steps": sum(len(c["steps"]) for m in models for c in m["components"]),
            "locators": len(locator_rows), "locators_with_issues": sum(1 for r in locator_rows if r["issues"]),
            "db_steps": len(db_steps), "rows": sum(len(t["rows"]) for t in tables), "cases": dict(statuses),
        },
        "locators": locator_rows,
        "db_steps": db_steps,
        "data": data_summary,
        "environment": {
            "app_url": env_values.get("appUrl"), "env": env_values.get("env"), "grid": env_values.get("RemoteHubURL"),
            "systems": [{"variable": k, **v} for k, v in systems.items()],
            "settings": {k: v for k, v in env_values.items() if v and k not in ("appUrl",)},
        },
    }
