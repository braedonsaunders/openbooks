import { expect, test, type BrowserContext } from '@playwright/test'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { authedContext, dismissSetupWizard } from './auth'

/**
 * Every page renders.
 *
 * The ViewSpec conversion put all 165 pages behind one loader/spec pair each,
 * and — this is the part worth testing — behind TWO shared files. A single
 * edit to `widgets.tsx` or `blocks.tsx` now reaches every page in the app. The
 * conversion proved the renderer once against the hand-written pages it
 * replaced; nothing since then would notice a shared widget breaking forty
 * screens at once.
 *
 * So this asserts the cheap, durable thing rather than the expensive, brittle
 * one: each route answers, renders content, and throws nothing. It does not
 * pin markup. A UI change should never fail this file — only a broken page
 * should.
 *
 * The route list is DISCOVERED from the filesystem, not typed out. A list
 * someone has to remember to extend is a list that silently stops covering new
 * pages, which is the failure mode this exists to prevent.
 *
 * What it does NOT cover, and cannot: a branch selected by a QUERY STRING.
 * Every route is visited bare, so a page that renders something else entirely
 * for `?run=<id>` is invisible here — which is exactly how `/close` served a
 * blank wizard for weeks. Those branches need a test that can seed the row
 * they depend on; `web/lib/close-run-branch.integration.test.ts` is the model.
 */

const APP_DIR = join(process.cwd(), 'web', 'app', '(app)')

/** Concrete ids for the dynamic segments, so `[id]` routes are reachable. */
const DYNAMIC_SAMPLES: Record<string, string> = {
  '/apps/[key]': '/apps/viewspec-demo',
}

/**
 * Routes this suite cannot visit blind, with the reason.
 *
 * A skip needs a cause, not a shrug: an unexplained exclusion is how coverage
 * quietly shrinks. Dynamic routes with no seeded sample are skipped rather
 * than guessed at, because a 404 from a made-up id would prove nothing.
 */
const SKIP: Record<string, string> = {}

function discoverRoutes(dir: string, prefix = ''): string[] {
  const routes: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (!statSync(full).isDirectory()) continue
    // Route groups `(x)` and private folders `_x` do not contribute a segment.
    const segment = entry.startsWith('(') || entry.startsWith('_') ? '' : `/${entry}`
    const child = prefix + segment
    if (readdirSync(full).includes('page.tsx')) routes.push(child || '/')
    routes.push(...discoverRoutes(full, child))
  }
  return routes
}

const routes = [...new Set(discoverRoutes(APP_DIR))]
  .map((route) => DYNAMIC_SAMPLES[route] ?? route)
  // A dynamic route with no sample cannot be visited without inventing an id.
  .filter((route) => !route.includes('['))
  .filter((route) => !SKIP[route])
  .sort()

test('the route list was actually discovered', () => {
  // Guards the discovery itself. If the walk breaks, every route test below
  // would pass vacuously by testing nothing.
  expect(routes.length).toBeGreaterThan(120)
  expect(routes).toContain('/banking')
  expect(routes).toContain('/reports/pnl')
})

// Authenticate once per worker; every route still gets a fresh browser context.
// The login form and credential policy retain their separate browser coverage.
let routeStorageState: Awaited<ReturnType<BrowserContext['storageState']>>
test.beforeAll(async ({ browser, baseURL }) => {
  const { context } = await authedContext(browser, baseURL)
  try { routeStorageState = await context.storageState() }
  finally { await context.close() }
})

// Each discovered route owns its timeout and trace. A single aggregate test
// exhausted its budget after only 30 cold Next compiles, leaving most routes
// unvisited and making a retry repeat all earlier work.
for (const route of routes) {
  test(`${route} renders without throwing`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({
      baseURL,
      storageState: routeStorageState,
      ignoreHTTPSErrors: process.env.E2E_IGNORE_HTTPS_ERRORS === '1',
    })
    const page = await context.newPage()
    const errors: string[] = []
    let restorePayrollDisabled = false
    page.on('pageerror', (error: Error) => errors.push(String(error)))
    try {
      // Payroll deliberately defaults off. Adopt it through the authoritative
      // switchboard for this one render case, then restore the prior gate.
      if (route === '/admin/setup/payroll') {
        await page.goto('/admin/setup/features')
        await dismissSetupWizard(page)
        await page.goto('/admin/setup/features')
        const payroll = page.getByRole('switch', { name: 'Payroll', exact: true })
        if ((await payroll.getAttribute('aria-checked')) === 'false') {
          restorePayrollDisabled = true
          const saved = page.waitForResponse((response) => response.url().endsWith('/api/admin/setup/features') && response.request().method() === 'PUT')
          await payroll.click()
          expect((await saved).status()).toBe(200)
          await expect(payroll).toHaveAttribute('aria-checked', 'true')
        }
      }
      const response = await page.goto(route, { waitUntil: 'domcontentloaded' })
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
      expect(response?.status(), `${route}: HTTP response`).toBeLessThan(400)
      await expect(page.locator('main').first(), `${route}: rendered content`).toContainText(/\S/)
      await expect(page.locator('[data-route-state="error"]'), `${route}: error boundary`).toHaveCount(0)
      expect(errors, `${route}: browser errors`).toEqual([])
    } finally {
      try {
        if (restorePayrollDisabled) {
          const restored = await context.request.put('/api/admin/setup/features', {
            headers: { Origin: new URL(baseURL!).origin },
            data: { features: { payroll: false } },
          })
          expect(restored.status(), await restored.text()).toBe(200)
        }
      } finally { await context.close() }
    }
  })
}
