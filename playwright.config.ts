import { defineConfig } from "@playwright/test";

const production = process.env.E2E_PRODUCTION === "1";
const baseURL = process.env.E2E_BASE_URL ?? (production ? "https://localhost:4780" : "http://localhost:4780");

/**
 * Browser smoke suite for the app shell. CI builds the standalone app and
 * runs it over ephemeral HTTPS against a constrained database role. Local
 * development retains the Next dev server unless E2E_PRODUCTION=1 is set.
 * Bootstrap the disposable database before running either mode.
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
    baseURL,
    ignoreHTTPSErrors: process.env.E2E_IGNORE_HTTPS_ERRORS === "1",
    navigationTimeout: 90_000, // dev-mode cold compiles are slow on first hit
    actionTimeout: 30_000,
    trace: "retain-on-failure",
  },
  webServer: process.env.E2E_EXTERNAL
    ? undefined // E2E_EXTERNAL=1: caller started the app (e.g. `next start`)
    : {
        command: production ? "node scripts/e2e-production-server.mjs" : "npm run dev -w web",
        url: `${baseURL}/api/v1/health`,
        ignoreHTTPSErrors: process.env.E2E_IGNORE_HTTPS_ERRORS === "1",
        gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
        reuseExistingServer: !process.env.CI,
        timeout: 240_000,
      },
});
