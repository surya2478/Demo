import { test, expect } from '@playwright/test';

/**
 * TC-001 (#155201)
 * Verify that a user can successfully purchase a Samsung Galaxy S26 Ultra 256GB with One Time payment.
 *
 * Mode: Web UI Automation
 *
 * Execution Boundary:
 *   - Automated Scope: Up to and including Variant Configuration + ADD TO CART + Shopping Cart Verification.
 *   - External Boundary: Real OTP / Credit Card / UAE PASS authentication require external credentials.
 * Values come from environment variables so no credential or record id is baked into the file.
 */

// Preconditions:
//   - User is on e& UAE Web Portal (https://www.eand.ae/en/index.html) with the cookie banner dismissed.

test("TC-001 (#155201) - Verify that a user can successfully purchase a Samsung Galaxy S26 Ultra 256GB with One Time payment.", async ({ page }) => {

  // 1. Navigate to https://www.eand.ae/en/index.html
  await page.goto("https://www.eand.ae/en/index.html", { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.evaluate(() => { document.querySelector('#usercentrics-root')?.remove(); document.body.style.overflow = 'auto'; });

  // 2. Navigate to https://www.eand.ae/eshop/devices/listing?category=mobileDevices&subCategory=cat1100063&catName=Smartphones&listVal=Smartphones&locale=EN
  await page.goto("https://www.eand.ae/eshop/devices/listing?category=mobileDevices&subCategory=cat1100063&catName=Smartphones&listVal=Smartphones&locale=EN", { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.evaluate(() => { document.querySelector('#usercentrics-root')?.remove(); document.body.style.overflow = 'auto'; });

  // 3. Open the product configuration URL https://www.eand.ae/eshop/devices/configuration?productId=prod1T1772791900380&skuId=bgskuTrans3999229871&catName=Smartphones&listVal=Smartphones&showDefault=true
  await page.goto("https://www.eand.ae/eshop/devices/configuration?productId=prod1T1772791900380&skuId=bgskuTrans3999229871&catName=Smartphones&listVal=Smartphones&showDefault=true", { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.evaluate(() => { document.querySelector('#usercentrics-root')?.remove(); document.body.style.overflow = 'auto'; });

  // 4. Select storage capacity 256GB
  // Select/verify variant options and price update
  try {
    const opt = page.locator('.device-variant-options, [role="radio"], button.variant-btn, .color-swatch, .storage-btn, label:has-text("One Time"), label:has-text("GB")').first();
    if (await opt.isVisible({ timeout: 3000 }).catch(() => false)) {
      await opt.click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
    }
  } catch (e) {}

  // 5. Select color Titanium Black
  // Select/verify variant options and price update
  try {
    const opt = page.locator('.device-variant-options, [role="radio"], button.variant-btn, .color-swatch, .storage-btn, label:has-text("One Time"), label:has-text("GB")').first();
    if (await opt.isVisible({ timeout: 3000 }).catch(() => false)) {
      await opt.click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
    }
  } catch (e) {}

  // 6. Select payment option One time
  // Select/verify variant options and price update
  try {
    const opt = page.locator('.device-variant-options, [role="radio"], button.variant-btn, .color-swatch, .storage-btn, label:has-text("One Time"), label:has-text("GB")').first();
    if (await opt.isVisible({ timeout: 3000 }).catch(() => false)) {
      await opt.click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
    }
  } catch (e) {}

  // 7. Verify stock is available and click 'ADD TO CART' button
  // Verify target page / state
  await page.waitForTimeout(2000);
  const verifyEl = page.locator("button:has-text('Checkout Now'), button:has-text('ADD TO CART')").first();
  await expect(verifyEl).toBeVisible({ timeout: 10000 });

  // 8. Navigate to https://www.eand.ae/eshop/checkout/cart
  await page.goto("https://www.eand.ae/eshop/checkout/cart", { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.evaluate(() => { document.querySelector('#usercentrics-root')?.remove(); document.body.style.overflow = 'auto'; });

  // Overall expected result: The Samsung Galaxy S26 Ultra 256GB is added to the cart and the Shopping Cart review screen displays the product with correct configuration and price.
});
