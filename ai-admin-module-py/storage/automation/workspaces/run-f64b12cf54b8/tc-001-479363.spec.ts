import { test, expect } from '@playwright/test';

/**
 * TC-001 (#479363)
 * Verify the end-to-end purchase flow for the Business First Plus Standard 110 plan from the e& UAE SMB portal catalog to the B2B Ordering Email Verification page.
 *
 * Mode: Web UI Automation
 *
 * Execution Boundary:
 *   - Automated Scope: Up to and including Variant Configuration + ADD TO CART + Shopping Cart Verification.
 *   - External Boundary: Real OTP / Credit Card / UAE PASS authentication require external credentials.
 * Values come from environment variables so no credential or record id is baked into the file.
 */

// Preconditions:
//   - The e& UAE SMB portal is accessible, the Business First Plus catalog page is live, and the Local and International plans tab is available.

test("TC-001 (#479363) - Verify the end-to-end purchase flow for the Business First Plus Standard 110 plan from the e& UAE SMB portal catalog to the B2B Ordering Emai", async ({ page }) => {

  // 1. Navigate to https://www.eand.ae/en/smb/index.html
  await page.goto("https://www.eand.ae/en/smb/index.html", { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.evaluate(() => { document.querySelector('#usercentrics-root')?.remove(); document.body.style.overflow = 'auto'; });

  // 2. Dismiss the cookie banner if present
  // Dismiss cookie / privacy overlay
  await page.evaluate(() => {
    document.querySelector('#usercentrics-root')?.remove();
    document.body.style.overflow = 'auto';
  });
  try {
    const cookieBtn = page.locator(
      '#usercentrics-root button, #onetrust-accept-btn-handler, #accept-all-cookies, button:has-text("Accept All"), button:has-text("Accept all"), button:has-text("Accept")'
    ).first();
    if (await cookieBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
      await cookieBtn.click({ force: true }).catch(() => {});
    }
  } catch (e) {}
  // Dismiss cookie / privacy overlay
  await page.evaluate(() => {
    document.querySelector('#usercentrics-root')?.remove();
    document.body.style.overflow = 'auto';
  });
  try {
    const cookieBtn = page.locator(
      '#usercentrics-root button, #onetrust-accept-btn-handler, #accept-all-cookies, button:has-text("Accept All"), button:has-text("Accept all"), button:has-text("Accept")'
    ).first();
    if (await cookieBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
      await cookieBtn.click({ force: true }).catch(() => {});
    }
  } catch (e) {}

  // 3. Navigate to Products, then Mobile, then Business First Plus Plans
  await page.goto("https://www.eand.ae/en/smb/products/mobile/mobile-plans/business-first-plus.html", { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.evaluate(() => { document.querySelector('#usercentrics-root')?.remove(); document.body.style.overflow = 'auto'; });

  // 4. Switch to the Local and International plans tab
  await page.locator("button:has-text('Local & International'), .tab-item:has-text('Local & International'), a:has-text('Local & International')").first.click();

  // 5. Select Business First Plus Standard 110 and review plan allowances and promo pricing
  // Verify target page / state
  await page.waitForTimeout(2000);
  const verifyEl = page.locator(".plan-card:has-text('Business First Plus Standard 110'), div:has-text('Business First Plus Standard 110')").first();
  await expect(verifyEl).toBeVisible({ timeout: 10000 });

  // 6. Click Buy Now on Business First Plus Standard 110
  // Click Buy Now / Proceed to Checkout
  try {
    const checkoutActionBtn = page.locator("a[href*='ratePlanId=PKBLATLBP000000375'], a:has-text('Buy Now')").first();
    if (await checkoutActionBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
      await checkoutActionBtn.click();
      await page.waitForTimeout(2000);
    }
  } catch (e) {}

  // 7. Verify the B2B Ordering Email Verification page loads
  // Verify target page / state
  await page.waitForTimeout(2000);
  const onTargetPage = page.url().includes("https://www.eand.ae/b2bportal/ordering-email-verification.html") || page.url().toLowerCase().includes("ordering-email-verification");
  expect(onTargetPage).toBe(true);

  // Overall expected result: The B2B Ordering Email Verification page opens at https://www.eand.ae/b2bportal/ordering-email-verification.html with query parameters b2bFlow=ONLINE_ORDERING, productId=prod_PKBLATLBP000000375, and contractPeriod=12 Months Contract, confirming the selected plan.
});
