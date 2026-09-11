import { expect, test } from '@playwright/test'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { authedContext } from './auth'

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

test('every page renders without throwing', async ({ browser, baseURL }) => {
  test.slow()
  const { context, page } = await authedContext(browser, baseURL)
  const failures: string[] = []
  try {
    for (const route of routes) {
      const errors: string[] = []
      const onError = (error: Error) => errors.push(String(error))
      page.on('pageerror', onError)
      try {
        const response = await page.goto(route, { waitUntil: 'domcontentloaded' })
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
        const status = response?.status() ?? 0
        // A redirect is a legitimate answer — nine routes exist only to issue
        // one, and several more redirect when a feature is off.
        const text = await page.locator('main').first().innerText().catch(() => '')
        // A page that crashes into the app's error boundary answers 200 with
        // text in <main> and emits no `pageerror`, so it reads as a clean
        // render unless the boundary is detected explicitly. Proven by
        // deliberately throwing from a shared block: without this check the
        // whole suite passed while most of the app was broken.
        const boundary = await page.locator('[data-route-state="error"]').count()
        if (status >= 400) failures.push(`${route}: HTTP ${status}`)
        else if (boundary > 0) failures.push(`${route}: crashed into the error boundary`)
        else if (errors.length > 0) failures.push(`${route}: ${errors[0]}`)
        else if (text.trim().length === 0) failures.push(`${route}: rendered no content`)
      } finally {
        page.off('pageerror', onError)
      }
    }
  } finally {
    await context.close()
  }
  expect(failures, `${failures.length} of ${routes.length} routes failed`).toEqual([])
})
