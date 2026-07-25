import { request, type Browser, type BrowserContext, type Page } from "@playwright/test";

export const E2E_EMAIL = process.env.E2E_EMAIL ?? "e2e@openbooks.test";
export const E2E_PASSWORD = process.env.E2E_PASSWORD ?? "e2e-test-password-123";

/** Interactive login through the real login form. */
export async function loginViaForm(page: Page, email = E2E_EMAIL, password = E2E_PASSWORD) {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
}

/**
 * Session without the UI round-trip: POST /api/login, lift the ob_session
 * cookie into a browser context. Used by specs that test authed pages, not
 * the login flow itself.
 */
export async function authedContext(
  browser: Browser,
  baseURL: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const api = await request.newContext({ baseURL });
  const res = await api.post("/api/login", { data: { email: E2E_EMAIL, password: E2E_PASSWORD } });
  if (!res.ok()) throw new Error(`e2e login failed: ${res.status()} ${await res.text()}`);
  const state = await api.storageState();
  await api.dispose();
  const context = await browser.newContext({ baseURL, storageState: state });
  const page = await context.newPage();
  return { context, page };
}
