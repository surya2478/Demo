"""Background KB verification crawl: check every KB component on the live site, find what the KB lacks.

    python scripts/kb_verify_crawl.py [--app eand_ae] [--gaps compose_report.json]
        [--plan-only] [--no-draft] [--browser chrome|chromium]

Writes report.json and report.md under storage/automation/kb_verify/<app>-<time>/
(screenshots of failed checks beside them). With --gaps (a kb_compose_brd.py
report), the agent step maps unknown objects to the report's open gaps and
drafts a change set per valid proposed component, for approval on the
Knowledge Base page. Meant to run unattended (nightly, or before a demo):
    docker exec -i <backend> python - --gaps <file> < scripts/kb_verify_crawl.py
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

_here = globals().get("__file__") or ""
ROOT = Path(_here).resolve().parent.parent if _here.endswith(".py") else Path.cwd()
sys.path.insert(0, str(ROOT))

from app.database.connection import SessionLocal  # noqa: E402
from app.models.automation import AutomationApplication  # noqa: E402
from app.services.automation import kb_compose, kb_verify  # noqa: E402
from app.services.automation import workspace as ws  # noqa: E402


def gaps_from(report_path: str | None) -> list[dict]:
    if not report_path:
        return []
    report = json.loads(Path(report_path).read_text(encoding="utf-8"))
    return [r for r in report.get("requirements") or []
            if r["status"] == "kb_gap" or (r["status"] == "covered" and "not covered" in (r.get("reason") or ""))]


def markdown(report: dict) -> str:
    c = report["counts"]
    lines = [f"# KB verification crawl -- {report['app_key']}", "",
             f"{report['started_at']} -> {report['finished_at']} on {report['base_url']}", "",
             f"**{c['verified']} verified, {c['ambiguous']} ambiguous, {c['failed']} failed** "
             f"({len(report['skipped'])} combinations the KB itself rules out were not tried)", ""]
    failed = [x for x in report["checks"] if x["status"] != "verified"]
    if failed:
        lines += ["## Needs attention", "", "| Check | Status | Step | Error | Candidate |", "|---|---|---|---|---|"]
        for x in failed:
            lines.append(f"| {x['id']} | {x['status']} | {x.get('failed_step') or ''} | "
                         f"{(x.get('error') or '').replace('|', '/')[:120]} | {', '.join(x.get('candidates') or [])[:120]} |")
        lines.append("")
    lines += ["## Objects the KB does not know", ""]
    for kind, s in report["screens"].items():
        lines.append(f"- **{kind}**: {s['objects']} objects swept, {len(s['new'])} unknown to the KB")
    if report.get("corrections"):
        lines += ["", "## KB corrections proposed from the evidence", ""]
        for c in report["corrections"]:
            lines.append(f"- `{c['file']}` {c['path']}: {c['note']}")
    if report.get("gap_findings"):
        lines += ["", "## Gaps mapped by the agent", ""]
        for f in report["gap_findings"]:
            comp = f.get("component") or {}
            verdict = ("proposed " + comp.get("id", "") + (" (valid)" if f.get("component_valid") else
                       f" (rejected: {'; '.join(f.get('component_errors') or [])})")) if comp else "no proposal"
            lines.append(f"- **{f['requirement']}** {f['evidence']}: {f['explanation']} -- {verdict}")
    if report.get("change_sets"):
        lines += ["", f"Draft change sets for approval: {', '.join('#' + str(i) for i in report['change_sets'])}"]
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", default="eand_ae")
    parser.add_argument("--gaps")
    parser.add_argument("--plan-only", action="store_true")
    parser.add_argument("--no-draft", action="store_true")
    parser.add_argument("--browser", default="chrome")
    parser.add_argument("--from", dest="from_dir", help="re-analyse a finished crawl folder instead of crawling")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        app = db.query(AutomationApplication).filter(AutomationApplication.app_key == args.app).first()
        if app is None or not app.base_url:
            print(f"No Automation application with app_key {args.app!r} and an address.")
            return 1
        parts = urlsplit(app.base_url)
        base = f"{parts.scheme}://{parts.netloc}"
        lib = kb_compose.load_library(args.app)
        if args.plan_only:
            plan = kb_verify.build_plan(lib, base)
            print(f"{len(plan['probes'])} pages, {sum(len(p['checks']) for p in plan['probes'])} checks, "
                  f"{len(plan['skipped'])} ruled out by the KB")
            for p in plan["probes"]:
                print(f"  {p['screen']:40} {len(p['checks']):3} checks  sweep={p['sweep']}")
            return 0
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        workdir = Path(args.from_dir) if args.from_dir else ws.storage_root() / "kb_verify" / f"{args.app}-{stamp}"
        stamp = workdir.name.split(f"{args.app}-")[-1]
        report = kb_verify.run(args.app, base_url=base, workdir=workdir, gaps=gaps_from(args.gaps),
                               browser=args.browser, reuse=bool(args.from_dir))
        if not args.no_draft and (report.get("gap_findings") or report.get("corrections")):
            report["change_sets"] = kb_verify.draft_change_sets(
                db, args.app, report.get("gap_findings") or [], report.get("corrections") or [],
                actor="kb-verify-crawl", run_ref=f"{args.app}-{stamp}")
        (workdir / "report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
        (workdir / "report.md").write_text(markdown(report), encoding="utf-8")
        print(markdown(report))
        print(f"Report: {workdir / 'report.md'}")
        return 0 if not report["counts"]["failed"] else 2
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
