import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import shell from "../web/messages/en/shell.json";
import common from "../web/messages/en/common.json";
import { authedContext, dismissSetupWizard } from "./auth";

/**
 * Workspace switching: production ⇄ sandbox from anywhere in the app.
 *
 * The active workspace is a session cookie, so a switch changes what every
 * request in every tab acts on. These specs pin the guarantees around that:
 * a switch lands in the chosen workspace from any page, it survives a tab
 * rendered by an earlier deployment, nothing rendered for the previous
 * workspace stays interactive (history, other tabs), and refusals leave the
 * session where it was.
 */

interface Workspaces {
  productionOrgId: string;
  productionName: string;
  sandboxOrgId: string;
  sandboxName: string;
}

let workspaces: Workspaces;

test.beforeAll(() => {
  const output = execFileSync("node", ["--import", "tsx", "e2e/support/ensure-sandbox.ts"], {
    encoding: "utf8",
    timeout: 240_000,
  });
  workspaces = JSON.parse(output.trim().split("\n").at(-1)!) as Workspaces;
});

/** Pages from different modules and shells: cockpits, lists, reports, settings, gated pages. */
const PAGES = [
  "/dashboard",
  "/customers",
  "/journal",
  "/reports/pnl",
  "/admin/setup",
  "/settings/security",
  "/payroll/separations",
];

const accountMenu = (page: Page) =>
  page.getByRole("button", { name: shell.accountMenu.menuAriaLabel });
const sandboxBanner = (page: Page) => page.getByText(shell.sandboxBanner.exit, { exact: true });
const errorBoundary = (page: Page) =>
  page.getByRole("button", { name: common.actions.retry, exact: true });

async function activeEnvCookie(context: BrowserContext): Promise<string | undefined> {
  return (await context.cookies()).find((cookie) => cookie.name === "ob_active_env")?.value;
}

async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await dismissSetupWizard(page);
  await expect(accountMenu(page)).toBeVisible();
}

async function pickWorkspace(page: Page, row: RegExp): Promise<void> {
  await accountMenu(page).click();
  await page.getByText(shell.accountMenu.organizations, { exact: true }).click();
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/", { waitUntil: "load" }),
    page.getByRole("menuitemradio", { name: row }).first().click(),
  ]);
  await dismissSetupWizard(page);
}

async function expectSandbox(page: Page): Promise<void> {
  await expect(accountMenu(page)).toContainText(workspaces.sandboxName);
  await expect(sandboxBanner(page)).toBeVisible();
  await expect(errorBoundary(page)).toHaveCount(0);
  expect(await activeEnvCookie(page.context())).toBeTruthy();
}

async function expectProduction(page: Page): Promise<void> {
  await expect(accountMenu(page)).toContainText(workspaces.productionName);
  await expect(accountMenu(page)).not.toContainText(workspaces.sandboxName);
  await expect(sandboxBanner(page)).toHaveCount(0);
  await expect(errorBoundary(page)).toHaveCount(0);
  expect(await activeEnvCookie(page.context())).toBeUndefined();
}

const sandboxRow = () => new RegExp(workspaces.sandboxName);
const productionRow = () =>
  new RegExp(
    `^(?!.*${workspaces.sandboxName}).*(${shell.accountMenu.production}|${workspaces.productionName})`,
  );

test.describe("workspace switching", () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeEach(async ({ browser, baseURL }) => {
    ({ context, page } = await authedContext(browser, baseURL));
  });

  test.afterEach(async () => {
    await context.close();
  });

  for (const path of PAGES) {
    test(`switches into the sandbox and back to production from ${path}`, async () => {
      await open(page, path);
      await pickWorkspace(page, sandboxRow());
      await expectSandbox(page);

      await open(page, path);
      await expectSandbox(page);
      await pickWorkspace(page, productionRow());
      await expectProduction(page);
    });
  }

  test("a tab rendered by an earlier deployment can still switch", async () => {
    // Every server action this tab knows is unknown to the server, exactly as
    // after a release replaced the build the tab was loaded from.
    await page.route("**/*", (route) =>
      route.request().headers()["next-action"]
        ? route.fulfill({ status: 404, headers: { "x-nextjs-action-not-found": "1" }, body: "" })
        : route.fallback(),
    );
    await open(page, "/customers");
    await pickWorkspace(page, sandboxRow());
    await expectSandbox(page);
    await open(page, "/journal");
    await pickWorkspace(page, productionRow());
    await expectProduction(page);
  });

  test("the sandbox banner returns to its production organization", async () => {
    await open(page, "/journal");
    await pickWorkspace(page, sandboxRow());
    await open(page, "/reports/pnl");
    await Promise.all([
      page.waitForURL((url) => url.pathname === "/", { waitUntil: "load" }),
      sandboxBanner(page).click(),
    ]);
    await expectProduction(page);
  });

  test("history after a switch renders the current workspace, not the previous one", async () => {
    await open(page, "/customers");
    await pickWorkspace(page, sandboxRow());
    await expectSandbox(page);
    await page.goBack({ waitUntil: "load" });
    await expect(page).toHaveURL(/\/customers$/);
    await expectSandbox(page);
  });

  test("another tab that still shows the previous workspace is blocked until it reloads", async () => {
    const other = await context.newPage();
    await open(other, "/customers");
    await open(page, "/dashboard");

    await pickWorkspace(page, sandboxRow());
    await expectSandbox(page);

    const prompt = other.getByRole("dialog", { name: shell.workspaceSync.title });
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText(workspaces.productionName);
    await Promise.all([
      other.waitForEvent("load"),
      prompt.getByRole("button", { name: shell.workspaceSync.reload }).click(),
    ]);
    await expect(other).toHaveURL(/\/customers$/);
    await expectSandbox(other);
  });

  test("a tab returning to focus notices a switch it was not told about", async () => {
    await open(page, "/customers");
    // Switch through the endpoint directly: no tab announces this one.
    const switched = await page.request.post("/api/me/workspace", {
      data: { orgId: workspaces.sandboxOrgId },
      headers: { Origin: new URL(page.url()).origin },
    });
    expect(switched.status()).toBe(200);
    const prompt = page.getByRole("dialog", { name: shell.workspaceSync.title });
    await expect(prompt).toHaveCount(0);
    // Repeated until the page has hydrated and is listening for focus.
    await expect(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(prompt).toBeVisible({ timeout: 1_000 });
    }).toPass();
  });

  test("refused switches leave the session in its workspace", async () => {
    await open(page, "/dashboard");
    const origin = new URL(page.url()).origin;
    const malformed = await page.request.post("/api/me/workspace", {
      data: { orgId: "not-a-uuid" },
      headers: { Origin: origin },
    });
    expect(malformed.status()).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: "invalid_workspace" });
    const unknown = await page.request.post("/api/me/workspace", {
      data: { orgId: "00000000-0000-4000-8000-00000000f00d" },
      headers: { Origin: origin },
    });
    expect(unknown.status()).toBe(403);
    expect(await unknown.json()).toMatchObject({ error: "workspace_unavailable" });
    const current = await page.request.get("/api/me/workspace");
    expect(await current.json()).toEqual({ orgId: workspaces.productionOrgId });
    await page.reload();
    await expectProduction(page);
  });
});
