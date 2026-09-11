import {
  request,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

export const E2E_EMAIL = process.env.E2E_EMAIL ?? "e2e@openbooks.test";
export const E2E_PASSWORD = process.env.E2E_PASSWORD ?? "e2e-test-password-123";

/** Interactive login through the real login form. */
export async function loginViaForm(
  page: Page,
  email = E2E_EMAIL,
  password = E2E_PASSWORD,
) {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.locator('form button[type="submit"]').click();
}

/**
 * Session without the UI round-trip: POST /api/login, lift the ob_session
 * cookie into a browser context. Used by specs that test authed pages, not
 * the login flow itself.
 */
export async function authedContext(
  browser: Browser,
  baseURL?: string,
): Promise<{ context: BrowserContext; page: Page }> {
  if (!baseURL) throw new Error("e2e baseURL is required for API login");
  const origin = new URL(baseURL).origin;
  const api = await request.newContext({ baseURL });
  try {
    const res = await api.post("/api/login", {
      data: { email: E2E_EMAIL, password: E2E_PASSWORD },
      headers: { Origin: origin },
    });
    if (!res.ok()) {
      throw new Error(
        `e2e login failed: ${res.status()} ${await res.text()}`,
      );
    }
    const state = await api.storageState();
    const context = await browser.newContext({ baseURL, storageState: state });
    const page = await context.newPage();
    return { context, page };
  } finally {
    await api.dispose();
  }
}

/**
 * Dismiss the first-run setup wizard if this org still shows it.
 *
 * A freshly bootstrapped org opens every page behind a fixed, full-screen
 * overlay, which silently swallows every click a spec makes — the failure
 * reads as "element is not stable", never as "something is covering it". Four
 * specs had each grown their own copy of this before it was worth naming.
 *
 * Deliberately waits for the POST rather than just the overlay disappearing:
 * the wizard hides optimistically, so a spec that raced on for the next click
 * could beat the deferral to the server and meet the overlay again on the
 * following navigation.
 */
export async function dismissSetupWizard(page: Page) {
  const wizard = page.getByTestId("setup-wizard");
  if (!(await wizard.isVisible().catch(() => false))) return;
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/admin/setup/wizard") &&
        response.request().method() === "POST",
    ),
    wizard.getByRole("button", { name: "Skip for now", exact: true }).click(),
  ]);
  await wizard.waitFor({ state: "hidden" });
}
