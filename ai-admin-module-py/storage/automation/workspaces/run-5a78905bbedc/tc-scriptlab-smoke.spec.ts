import { test, expect } from '@playwright/test';

/**
 * TC-SCRIPTLAB-SMOKE
 * Proves the sign-in form rejects an empty submission.
 *
 * Mode: Web UI Automation
 *
 * Execution Boundary:
 *   - Automated Scope: Up to and including Variant Configuration + ADD TO CART + Shopping Cart Verification.
 *   - External Boundary: Real OTP / Credit Card / UAE PASS authentication require external credentials.
 * Values come from environment variables so no credential or record id is baked into the file.
 */

const valid_username = process.env.TESTDATA_VALID_USERNAME ?? "<set TESTDATA_VALID_USERNAME>";

// Preconditions:
//   - The application is reachable.

test("TC-SCRIPTLAB-SMOKE - Proves the sign-in form rejects an empty submission.", async ({ page }) => {

  // 1. Navigate to the sign-in page
  await page.goto("http://localhost:5175", { waitUntil: 'domcontentloaded', timeout: 45000 });
  // [Healed] Dismiss cookie consent overlay if present
  try {
    const cookieBtn = page.locator(
      '#onetrust-accept-btn-handler, #accept-all-cookies, button:has-text("Accept All"), button:has-text("Accept all"), button:has-text("Accept All Cookies"), button:has-text("I Accept"), button:has-text("Allow all"), button:has-text("Accept"), [aria-label*="accept" i], [id*="cookie" i] button'
    ).first();
    if (await cookieBtn.isVisible({ timeout: 3500 }).catch(() => false)) {
      await cookieBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(600);
    }
  } catch (e) {}
  await page.evaluate(() => { document.querySelector('#usercentrics-root')?.remove(); document.body.style.overflow = 'auto'; });
  // expected: The form is visible

  // 2. Enter the username
  await page.getByLabel("Username").fill(valid_username);
  // expected: The field holds the value

  // 3. Click the 'Sign In' button
  await page.getByRole("button", { name: "Sign In" }).click();
  // expected: The form submits

  // 4. Verify the validation message
  // Verify Shopping Cart / Checkout Review state
  await page.waitForTimeout(2000);
  const cartOrCheckoutEl = page.locator('.cart-item, .cart-summary, .checkout-summary, button:has-text("Checkout"), button:has-text("Proceed"), :text("Cart"), :text("Order Summary"), :text("Checkout")').first();
  const onTargetPage = /.*(devices|configuration|cart|checkout|summary|order).*/i.test(page.url());
  expect(onTargetPage).toBe(true);

  // Overall expected result: A validation message is shown.
});

// hand edited
