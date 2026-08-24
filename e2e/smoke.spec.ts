import { expect, test } from "@playwright/test";
import { authedContext, loginViaForm } from "./auth";

/**
 * Smoke tier: the app boots, the session gate holds, login works, and the
 * core accounting surfaces render against a real database. Deeper workflow
 * coverage belongs in additional spec files next to this one.
 */

test("unauthenticated visitors are redirected to /login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
});

test("login rejects bad credentials", async ({ page }) => {
  await loginViaForm(page, "nobody@example.com", "wrong-password");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("login succeeds and lands on the app shell", async ({ page }) => {
  await loginViaForm(page);
  await expect(page).not.toHaveURL(/\/login/);
  // The authenticated shell renders the primary sidebar navigation.
  await expect(page.locator("nav").first()).toBeVisible();
});

test("reports hub links to the financial statements", async ({ browser, baseURL }) => {
  const { context, page } = await authedContext(browser, baseURL);
  try {
    await page.goto("/reports");
    await expect(page.locator('a[href="/reports/balance-sheet"]').first()).toBeVisible();
    await expect(page.locator('a[href="/reports/pnl"]').first()).toBeVisible();
  } finally {
    await context.close();
  }
});

test("balance sheet renders a statement table", async ({ browser, baseURL }) => {
  const { context, page } = await authedContext(browser, baseURL);
  try {
    await page.goto("/reports/balance-sheet");
    await expect(page.locator("table").first()).toBeVisible();
  } finally {
    await context.close();
  }
});

test("AR workspace renders", async ({ browser, baseURL }) => {
  const { context, page } = await authedContext(browser, baseURL);
  try {
    const res = await page.goto("/ar");
    expect(res?.status()).toBe(200);
    await expect(page.locator("main")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("indirect cash flow page renders", async ({ browser, baseURL }) => {
  const { context, page } = await authedContext(browser, baseURL);
  try {
    const res = await page.goto("/reports/cash-flow-indirect");
    expect(res?.status()).toBe(200);
    await expect(page.locator("table").first()).toBeVisible();
  } finally {
    await context.close();
  }
});

test("income tax provisions page renders", async ({ browser, baseURL }) => {
  const { context, page } = await authedContext(browser, baseURL);
  try {
    const res = await page.goto("/tax/provisions");
    expect(res?.status()).toBe(200);
    await expect(page.locator("table").first()).toBeVisible();
  } finally {
    await context.close();
  }
});
