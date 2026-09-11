import { expect, test, type Page } from "@playwright/test";
import { authedContext, dismissSetupWizard } from "./auth";

/**
 * Page Layouts — the admin screen that makes a stored layout something a
 * person can see, change and undo.
 *
 * Worth a browser rather than a request test. Everything this screen does that
 * could plausibly break is client-side: the editor lives in a dialog, the
 * outline is derived in the browser after every edit, and the value of the
 * whole feature is that hiding a block here changes what the actual page
 * renders. A server-rendered assertion would see the dialog's markup and prove
 * none of it.
 *
 * The test drives the real round trip — customize, observe the page change,
 * remove, observe it change back — because the failure this guards against is
 * a customization that saves but does not take, or one that cannot be undone.
 * Both would strand an org on a layout nobody can fix from the UI.
 */

const LIST = "/admin/page-layouts";
/** A cockpit with a deep, named outline, so hiding one block is observable. */
const ROUTE = "/banking";

/**
 * Drop any layout this org has for the route under test.
 *
 * A stored layout outlives the run that stored it, so a test that failed
 * halfway would leave the page customized and every later run would start
 * from a page that no longer matches its own first assertion — a red suite
 * that stays red for a reason nobody can see in the diff. Cleaning up on the
 * way IN rather than only on the way out survives the crash case too.
 */
async function resetLayout(page: Page) {
  const response = await page.request.delete(
    `/api/page-specs?route=${encodeURIComponent(ROUTE)}`,
    { headers: { Origin: new URL(page.url()).origin } },
  );
  // 404 means there was nothing stored, which is the state we wanted anyway.
  expect([200, 404]).toContain(response.status());
}

test.describe("page layouts", () => {
  test.describe.configure({ mode: "serial" });

  test("the list names every customizable route and its status", async ({ browser, baseURL }) => {
    const { context, page } = await authedContext(browser, baseURL);
    try {
      await page.goto(LIST);
      await dismissSetupWizard(page);
      await expect(page.locator("main")).toBeVisible();
      await expect(page.getByRole("link", { name: ROUTE, exact: true })).toBeVisible();
      // The count is the honest headline: most routes are NOT customized, and
      // the screen should say so rather than implying everything is bespoke.
      await expect(page.getByText(/of \d+ pages customized/)).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("customizing a page changes what that page renders, and removing it restores the built-in", async ({
    browser,
    baseURL,
  }) => {
    test.slow();
    const { context, page } = await authedContext(browser, baseURL);
    try {
      // What the built-in page shows, so the change is measured against it
      // rather than against an assumption. Scoped to `main` throughout: the
      // sidebar repeats many of these words, and a match there would prove
      // nothing about the page's own content.
      const content = page.locator("main");
      await page.goto(ROUTE);
      await dismissSetupWizard(page);
      await resetLayout(page);
      await page.reload();
      await expect(content.getByText("Cash trend")).toBeVisible();

      await page.goto(`${LIST}?route=${encodeURIComponent(ROUTE)}`);
      await dismissSetupWizard(page);
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      // The warning is not decoration: a stored layout replaces the page, and
      // an author who does not know that will not understand why the page
      // stops improving.
      await expect(dialog.getByText(/replaces the built-in page/)).toBeVisible();

      // The outline is derived from the page's real spec, so it names blocks
      // that page actually has, and shows a BOUND title as its field path
      // rather than pretending the page says "trendTitle".
      await expect(dialog.getByText("Page header").first()).toBeVisible();
      await expect(dialog.getByText("banking-roster").first()).toBeVisible();

      // Hiding a block is the headline operation. Address the panel's own
      // ROW — children nest inside their parent's list item, so filtering list
      // items by text would match every ancestor too.
      const panel = dialog
        .locator("[data-block-path]")
        .filter({ hasText: "trendTitle" });
      await expect(panel).toHaveCount(1);
      await panel.getByRole("button", { name: /hide/i }).click();
      await expect(dialog.getByText("trendTitle")).toHaveCount(0);

      await dialog.getByRole("button", { name: /save layout/i }).click();
      await expect(dialog.getByText(/replaces the built-in page/)).toBeVisible();

      await page.goto(ROUTE);
      await expect(content).toBeVisible();
      // The hidden block is gone from the real page; the rest of it is not.
      await expect(content.getByText("Cash trend")).toHaveCount(0);
      await expect(content.getByText("Needs attention").first()).toBeVisible();

      await page.goto(`${LIST}?route=${encodeURIComponent(ROUTE)}`);
      await dismissSetupWizard(page);
      const reopened = page.getByRole("dialog");
      await expect(reopened).toBeVisible();
      // Reopening shows the STORED layout, not the built-in one: the block
      // stays hidden across a reload, which is what "saved" has to mean.
      await expect(reopened.getByText("trendTitle")).toHaveCount(0);
      await expect(reopened.getByText("banking-roster").first()).toBeVisible();

      await reopened.getByRole("button", { name: /remove customization/i }).click();
      await expect(page.getByRole("link", { name: ROUTE, exact: true })).toBeVisible();

      // Restored, not merely deactivated in the database.
      await page.goto(ROUTE);
      await expect(content.getByText("Cash trend")).toBeVisible();
    } finally {
      await resetLayout(page).catch(() => {});
      await context.close();
    }
  });

  test("a layout the renderer would refuse is reported, not stored", async ({ browser, baseURL }) => {
    const { context, page } = await authedContext(browser, baseURL);
    try {
      await page.goto(`${LIST}?route=${encodeURIComponent(ROUTE)}`);
      await dismissSetupWizard(page);
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("tab", { name: /advanced/i }).click();

      const editor = dialog.getByRole("textbox", { name: /advanced/i });
      await editor.fill(
        JSON.stringify({
          specVersion: 1,
          route: ROUTE,
          layout: "list",
          header: [],
          body: [{ kind: "widget", widget: "no-such-widget" }],
        }),
      );
      await dialog.getByRole("button", { name: /^check$/i }).click();

      // The offending widget is NAMED. "Invalid" is not a message anyone can
      // act on, and an author who cannot see which widget is wrong will guess.
      await expect(dialog.getByText(/no-such-widget/)).toBeVisible();

      // And it really was a dry run. Checking a draft must not store it, or
      // "Check" would be a save with extra steps and an author would have no
      // safe way to ask whether a layout is acceptable.
      const stored = await page.request.get("/api/page-specs");
      expect(await stored.json()).toEqual({ rows: [] });
    } finally {
      await context.close();
    }
  });
});
