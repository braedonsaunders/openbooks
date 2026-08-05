import { defineConfig } from "@playwright/test";

/**
 * Browser smoke suite for the app shell. The webServer block boots the real
 * Next dev server against OPENBOOKS_DB_URL; CI provisions Postgres + seeds an
 * admin via scripts/bootstrap.ts before `npx playwright test` runs.
 *
 * Local: bootstrap a scratch DB, then
 *   ADMIN_EMAIL=e2e@openbooks.test ADMIN_PASSWORD=e2e-test-password-123 \
 *   SESSION_SECRET=dev npx tsx scripts/bootstrap.ts && npx playwright test
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["html"]] : [["list"], ["html"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:4780",
    navigationTimeout: 90_000, // dev-mode cold compiles are slow on first hit
    actionTimeout: 30_000,
    trace: "retain-on-failure",
  },
  webServer: process.env.E2E_EXTERNAL
    ? undefined // E2E_EXTERNAL=1: caller started the app (e.g. `next start`)
    : {
        command: "npm run dev -w web",
        url: "http://localhost:4780/api/v1/health",
        reuseExistingServer: !process.env.CI,
        timeout: 240_000,
      },
});
