from __future__ import annotations

import argparse
from datetime import datetime
from pprint import pprint

from app.services.oslc_rqm_rtc import (
    create_module_with_existing_login,
    estimate_rqm_api_calls,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="RQM/RTC OSLC chatbot helper module")

    parser.add_argument("--qm-base-url", required=True, help="QM application base URL, e.g. https://host:9443/qm")
    parser.add_argument("--jts-base-url", required=True, help="JTS base URL, e.g. https://host:9443/jts")
    parser.add_argument("--username", required=True, help="Jazz username (reuse existing login username)")
    parser.add_argument("--password", required=True, help="Jazz password (reuse existing login password)")
    parser.add_argument("--insecure", action="store_true", help="Disable SSL verification")

    sub = parser.add_subparsers(dest="command", required=True)

    p_tc = sub.add_parser("test-case", help="Get test case by identifier")
    p_tc.add_argument("--id", required=True, help="Test case identifier")

    p_owner = sub.add_parser("owner-in-plan", help="List test cases owned by a user in a test plan")
    p_owner.add_argument("--owner", required=True, help="Owner display name")
    p_owner.add_argument("--plan", required=True, help="Test plan identifier")

    p_executed = sub.add_parser("executed-today", help="List test cases executed on a date")
    p_executed.add_argument(
        "--date",
        default=datetime.utcnow().strftime("%Y-%m-%d"),
        help="Execution date in YYYY-MM-DD (default: today UTC)",
    )

    p_failed = sub.add_parser("failed-in-plan", help="List failed test cases in a test plan")
    p_failed.add_argument("--plan", required=True, help="Test plan identifier")

    p_est = sub.add_parser("estimate-calls", help="Estimate OSLC REST calls for bulk retrieval")
    p_est.add_argument("--test-cases", type=int, default=0)
    p_est.add_argument("--test-plans", type=int, default=0)
    p_est.add_argument("--test-results", type=int, default=0)
    p_est.add_argument("--page-size", type=int, default=200)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "estimate-calls":
        estimate = estimate_rqm_api_calls(
            test_case_count=args.test_cases,
            test_plan_count=args.test_plans,
            test_result_count=args.test_results,
            page_size=args.page_size,
        )
        pprint(estimate)
        return

    module = create_module_with_existing_login(
        qm_base_url=args.qm_base_url,
        jts_base_url=args.jts_base_url,
        username=args.username,
        password=args.password,
        verify_ssl=not args.insecure,
    )
    module.initialize()

    if args.command == "test-case":
        result = module.get_test_case(args.id)
        pprint(result)
        return

    if args.command == "owner-in-plan":
        result = module.list_test_cases_owned_by_user_in_plan(args.owner, args.plan)
        pprint(result)
        return

    if args.command == "executed-today":
        execution_day = datetime.strptime(args.date, "%Y-%m-%d").date()
        result = module.list_test_cases_executed_on(execution_day)
        pprint(result)
        return

    if args.command == "failed-in-plan":
        result = module.list_failed_test_cases_in_plan(args.plan)
        pprint(result)
        return


if __name__ == "__main__":
    main()
