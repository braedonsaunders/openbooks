import { expect, test } from "@playwright/test";
import { authedContext, dismissSetupWizard } from "../auth";

/**
 * E2E workflow: dashboard quick-actions customization.
 *
 * Owner-reported production defect (v0.1.0-alpha.5): customizing Quick
 * Actions — delete one tile, Save — rendered every other widget as
 * "Unknown widget" and left a blank dashboard after refresh, because the
 * save persisted an empty widget grid for tenants with no stored layout.
 * This suite drives the exact owner path on its own pristine tenant and
 * asserts the grid survives the save and the reload.
 */
test.describe("dashboard workflows", () => {
  test("quick-actions delete keeps every widget on the board", async ({ browser, baseURL }) => {
    const { context, page } = await authedContext(browser, baseURL);
    try {
      await page.goto("/dashboard");
      await dismissSetupWizard(page);
      // Dismissal can land on the setup confirmation page; return to the board.
      await page.goto("/dashboard");
      // The shipped default board: greeting, Quick actions, real widgets.
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByText("Quick actions", { exact: true })).toBeVisible();
      await expect(page.getByText("Unknown widget:")).toHaveCount(0);

      // Delete one quick action through the widget's own customizer.
      await page.getByRole("button", { name: "Customize", exact: true }).click();
      const drawer = page.getByRole("dialog");
      await expect(drawer.getByText("Customize quick actions")).toBeVisible();
      const remove = drawer.getByRole("button", { name: "Remove" });
      expect(await remove.count()).toBeGreaterThan(1);
      await remove.first().click();
      await drawer.getByRole("button", { name: "Save", exact: true }).click();
      await expect(drawer.getByText("Customize quick actions")).toHaveCount(0);

      // The board survives the save: Quick actions still renders and no
      // tile degrades to Unknown — before the fix every other widget did.
      await expect(page.getByText("Quick actions", { exact: true })).toBeVisible();
      await expect(page.getByText("Unknown widget:")).toHaveCount(0);

      // And it survives the reload: the stored layout is a full grid, not
      // the empty one the old save persisted (blank board before the fix).
      await page.reload();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByText("Quick actions", { exact: true })).toBeVisible();
      await expect(page.getByText("Unknown widget:")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
