#!/usr/bin/env node
/**
 * Navigation-latency baseline: 30 representative routes, cold and warm.
 *
 * Cold means a fresh browser context (empty HTTP cache, new profile) that
 * logs in through the API and then loads the route once. Warm means loading
 * the same route a second time in that same context, so the HTTP cache and
 * the compiled client bundles are already hot. The two numbers answer
 * different questions: cold is what a first visit after a deploy feels like,
 * warm is what everyday clicking between pages feels like.
 *
 * Time-to-first-byte comes from the Navigation Timing entry
 * (responseStart - startTime). Time-to-interactive has no single browser
 * number without a tracing harness, so this records domInteractive as an
 * explicit, documented proxy: the point at which the document finished
 * parsing and deferred scripts started running. Treat it as a stable
 * relative signal for before/after comparisons, not as a lab-grade TTI.
 *
 * Usage:
 *   node scripts/perf-navigation-latency.mjs [--out <path>]
 *
 * Environment:
 *   PERF_BASE_URL    app origin (default http://localhost:4780)
 *   PERF_EMAIL / PERF_PASSWORD
 *                    login for the perf tenant (defaults match the e2e seed)
 *   PERF_TENANT_NAME label recorded in the output (default SIM Meridian Constructors)
 *   PERF_SHA         commit measured (default: git rev-parse HEAD)
 *
 * The JSON table defaults into $BB_THREAD_STORAGE so reruns after later
 * performance work overwrite the same series, and always names the measured
 * commit so a reader can tell which tree a row belongs to.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { chromium, request } from '@playwright/test'

// Thirty routes covering the shell and every high-traffic domain. Gate
// explanation pages are excluded: without redirect context they honestly
// 404, so timing them would measure the not-found page, not the product.
const ROUTES = [
  '/',
  '/dashboard',
  '/banking',
  '/banking/reconciliations',
  '/ar',
  '/ar/invoices',
  '/ap',
  '/ap/bills',
  '/customers',
  '/journal',
  '/reports',
  '/reports/pnl',
  '/reports/balance-sheet',
  '/reports/cash-flow',
  '/reports/trial-balance',
  '/reports/general-ledger',
  '/projects',
  '/projects/pre-billing',
  '/field-tickets',
  '/subcontracts',
  '/payroll',
  '/payroll/runs',
  '/timesheets',
  '/inventory',
  '/items',
  '/purchasing',
  '/purchase-orders',
  '/expenses',
  '/close',
  '/tax',
]

const baseURL = process.env.PERF_BASE_URL ?? 'http://localhost:4780'
const email = process.env.PERF_EMAIL ?? process.env.E2E_EMAIL ?? 'e2e@openbooks.test'
const password = process.env.PERF_PASSWORD ?? process.env.E2E_PASSWORD ?? 'e2e-test-password-123'
const tenant = process.env.PERF_TENANT_NAME ?? 'SIM Meridian Constructors'

function measuredSha() {
  if (process.env.PERF_SHA) return process.env.PERF_SHA
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function defaultOutPath(sha) {
  const short = sha === 'unknown' ? 'unknown' : sha.slice(0, 12)
  const name = `wp-70-navigation-latency-${short}.json`
  const dir = process.env.BB_THREAD_STORAGE ?? process.cwd()
  return resolve(dir, name)
}

const outArg = process.argv.indexOf('--out')
const sha = measuredSha()
const outPath = outArg === -1 ? defaultOutPath(sha) : resolve(process.argv[outArg + 1])

async function readTimings(page) {
  return page.evaluate(() => {
    const entry = performance.getEntriesByType('navigation')[0]
    if (!entry) return null
    const at = (value) => (value > 0 ? Math.round(value - entry.startTime) : null)
    return {
      ttfbMs: at(entry.responseStart),
      domInteractiveMs: at(entry.domInteractive),
      domContentLoadedMs: at(entry.domContentLoadedEventEnd),
      loadMs: at(entry.loadEventEnd),
      transferBytes: entry.transferSize ?? null,
    }
  })
}

async function measureRoute(browser, storageState, route) {
  const row = { route }
  const context = await browser.newContext({ baseURL, storageState })
  try {
    const page = await context.newPage()
    for (const pass of ['cold', 'warm']) {
      try {
        const response = await page.goto(route, { waitUntil: 'load', timeout: 90_000 })
        const timings = await readTimings(page)
        row[pass] = {
          ok: (response?.status() ?? 0) < 400 && timings !== null,
          httpStatus: response?.status() ?? null,
          finalUrl: page.url(),
          ...(timings ?? {}),
        }
      } catch (error) {
        row[pass] = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    await page.close()
  } finally {
    await context.close()
  }
  return row
}

const browser = await chromium.launch()
try {
  const api = await request.newContext({ baseURL })
  try {
    const res = await api.post('/api/login', {
      data: { email, password },
      headers: { Origin: new URL(baseURL).origin },
    })
    if (!res.ok()) throw new Error(`login failed: ${res.status()} ${await res.text()}`)
    var storageState = await api.storageState()
  } finally {
    await api.dispose()
  }

  const rows = []
  for (const route of ROUTES) {
    const row = await measureRoute(browser, storageState, route)
    rows.push(row)
    const show = (pass) => {
      const m = row[pass]
      return m.ok ? `ttfb=${m.ttfbMs}ms interactive~${m.domInteractiveMs}ms` : `FAILED (${m.error ?? m.httpStatus})`
    }
    console.log(`${route} cold: ${show('cold')} | warm: ${show('warm')}`)
  }

  const failed = rows.filter((row) => !row.cold?.ok || !row.warm?.ok).length
  const table = {
    tool: 'scripts/perf-navigation-latency.mjs',
    sha,
    measuredAt: new Date().toISOString(),
    baseURL,
    tenant,
    routeCount: ROUTES.length,
    failedRoutes: failed,
    notes: 'ttfbMs is Navigation-Timing responseStart. domInteractiveMs is a documented proxy for time-to-interactive, for relative before/after comparison only.',
    routes: rows,
  }
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(table, null, 2) + '\n')
  console.log(`wrote ${rows.length} routes (${failed} failed) to ${outPath}`)
  if (failed > 0) process.exitCode = 1
} finally {
  await browser.close()
}
