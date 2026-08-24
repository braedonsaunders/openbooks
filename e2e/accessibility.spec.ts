import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { authedContext } from "./auth";

const wcagTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

test("login has no automatically detectable WCAG A/AA violations", async ({
  page,
}) => {
  await page.goto("/login");
  await expect(page.locator("main")).toBeVisible();

  const results = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
  expect(
    results.violations,
    JSON.stringify(results.violations, null, 2),
  ).toEqual([]);
});

test("authenticated reports hub has no automatically detectable WCAG A/AA violations", async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await authedContext(browser, baseURL);
  try {
    await page.goto("/reports");
    await expect(page.locator("main")).toBeVisible();
    const setupWizard = page.getByTestId("setup-wizard");
    if (await setupWizard.isVisible()) {
      await expect(setupWizard).toHaveCSS("opacity", "1");
    }

    const results = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
    expect(
      results.violations,
      JSON.stringify(results.violations, null, 2),
    ).toEqual([]);
  } finally {
    await context.close();
  }
});
