"""--- Test cases composed from the Automation KB (kb_compose) ---------------------

Against the repository's real e& UAE Knowledge Base (components.json and the
Tablets flow), with no model call:

  1. A valid composition assembles into steps whose targets are the KB's
     verified selectors, and whose prices come from the KB record.
  2. Validation rejects, with a reason: a case that does not open a page
     first, an unknown component, a value outside the allowed list, a
     component on the wrong page, the breadcrumb on a deep-linked product
     page, an out-of-stock check on a product whose stock varies, and a case
     that asserts nothing.
  3. The compiled script uses the assembled selectors as written.

Run from ai-admin-module-py:

    .venv312/Scripts/python.exe tests/automation/smoke_kb_compose.py
"""
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
work = Path(tempfile.mkdtemp())
os.environ["DATABASE_URL"] = f"sqlite:///{(work / 'compose.db').as_posix()}"
os.environ["AUTOMATION_KB_PATH"] = str(ROOT / "knowledge_base")

from app.services.automation import compiler  # noqa: E402
from app.services.automation import kb_compose as k  # noqa: E402

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(("PASS " if condition else "FAIL ") + label + ("" if condition else f" -- {detail}"))
    if not condition:
        failures.append(label)


lib = k.load_library("eand_ae")
C, S = k.ComposedCase, k.ComposedStep

good = k.build_case(lib, "BR-09", C(title="plans", steps=[
    S(component="open_tablets_listing"),
    S(component="open_product_from_listing", params={"listed_product": "iPad Pro M4, 13-inch"}),
    S(component="assert_plan_price", params={"plan": "24 months"}),
    S(component="assert_out_of_stock"),
    S(component="breadcrumb_to_tablets"),
]))
check("a valid composition has no errors", not good.errors, str(good.errors))
targets = [s["target"] for s in good.steps]
check("the product card is targeted by its KB productId",
      "//app-d-device-card//a[contains(@href,'productId=prod2450056')]" in targets, str(targets))
check("the plan price is read from the KB record, not chosen",
      any("'370.00'" in t for t in targets), str(targets))
check("every non-navigation step carries a selector",
      all(s["target"].startswith(("//", "(//", "/", "#")) for s in good.steps))


def errors(*steps) -> str:
    return " ".join(k.build_case(lib, "BR", C(title="x", steps=list(steps))).errors)


check("a case must open a page first",
      "must start by opening a page" in errors(S(component="select_storage", params={"storage": "512GB"})))
check("an unknown component is rejected",
      "is not a component" in errors(S(component="open_tablets_listing"), S(component="compare_products")))
check("a value outside the allowed list is rejected",
      "not an allowed value" in errors(S(component="open_product_page", params={"product": "iPad Pro M4, 11-inch"}),
                                       S(component="select_storage", params={"storage": "3TB"})))
check("a component on the wrong page is rejected",
      "needs the listing page" in errors(S(component="open_cart"), S(component="load_more")))
check("the breadcrumb is refused on a deep-linked product page (DEV-TAB-03)",
      "product_from_listing" in errors(S(component="open_product_page", params={"product": "iPad Pro M4, 11-inch"}),
                                       S(component="breadcrumb_to_tablets")))
check("out-of-stock is refused for a product whose stock varies",
      "stock is 'out'" in errors(S(component="open_product_page", params={"product": '11" New iPad Pro, Wi-Fi'}),
                                 S(component="assert_out_of_stock")))
check("display glass is refused after 256GB storage (1TB/2TB only)",
      "only possible when storage" in errors(S(component="open_product_page", params={"product": "iPad Pro M4, 11-inch"}),
                                             S(component="select_storage", params={"storage": "256GB"}),
                                             S(component="select_display_glass", params={"display_glass": "Standard glass"})))
check("display glass is allowed after 1TB storage",
      not errors(S(component="open_product_page", params={"product": "iPad Pro M4, 11-inch"}),
                 S(component="select_storage", params={"storage": "1TB"}),
                 S(component="select_display_glass", params={"display_glass": "Standard glass"})))
dflt = k.build_case(lib, "BR", C(title="d", steps=[
    S(component="open_product_page", params={"product": "iPad Pro M4, 11-inch"}),
    S(component="select_storage", params={"storage": "1TB"}),
    S(component="select_storage", params={"storage": "512GB"}),
]))
acts = [s["action"] for s in dflt.steps]
check("asking for the default option keeps only its assertion (no click on the active pill)",
      "Click storage option '1TB'" not in acts and "Verify '1TB' is the active storage option" in acts, str(acts))
check("a different option is still clicked", "Click storage option '512GB'" in acts, str(acts))
check("a case that asserts nothing is rejected",
      "checks nothing" in errors(S(component="open_cart")))

case = SimpleNamespace(
    display_id="KBC-T", objective="plans", description="plans", preconditions="", steps_raw="",
    test_data="", expected_result="", steps_structured=good.steps, application_id=None,
    application_url="https://devnew.eand.ae/en", recorded_flow_objects=None, environment="UAT",
)
code = compiler.compile_playwright(case).code
check("the compiled script uses the assembled selectors as written",
      "productId=prod2450056" in code and "370.00" in code and "try {\n    const opt" not in code, code[:300])
check("the out-of-stock steps assert the disabled state", "toBeDisabled" in code)

print()
print("ALL PASSED" if not failures else f"{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)
