#!/usr/bin/env node
/**
 * ViewSpec conformance harness.
 *
 * For every converted page, render it twice against the SAME request — once
 * through the native JSX and once through `ModuleView` — and prove the two are
 * indistinguishable. A page counts as converted only when this is clean; until
 * then the native branch stays and ships.
 *
 * This runs in a real browser, and that is not incidental. The first version
 * of this harness fetched the HTML with `fetch` and compared the `<main>`
 * subtree, and it reported four passing variants that were in fact four
 * identical copies of the streaming suspense fallback — the page content
 * arrives in later chunks that a single `fetch` never resolves. A harness that
 * cannot fail is worse than no harness, so the comparison happens after the
 * document has actually finished streaming and rendering.
 *
 * Two comparisons, because they catch different failures:
 *
 *   1. Structural — the settled DOM of the page's `<main>`, normalized and
 *      diffed node by node. Exact, and it is the gate. A DOM diff can say
 *      WHAT changed; a pixel diff cannot.
 *   2. Visual — a full-page screenshot compared pixel for pixel. Identical
 *      markup can still lay out differently, so this is the backstop.
 *
 * Normalization is deliberately narrow: React comment markers and per-render
 * `useId` values carry no user-visible meaning. Nothing else is stripped —
 * anything more and the harness would be lying to us.
 *
 * Usage:
 *   node scripts/viewspec-conformance.mjs                  # every registered page
 *   node scripts/viewspec-conformance.mjs /reports/partners
 *   VIEWSPEC_HEADED=1 node scripts/viewspec-conformance.mjs   # watch it run
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const BASE = process.env.VIEWSPEC_BASE_URL ?? 'http://localhost:4780'
const EMAIL = process.env.VIEWSPEC_EMAIL ?? 'viewspec@local.test'
const PASSWORD = process.env.VIEWSPEC_PASSWORD ?? 'viewspec-dev'
const OUT_DIR = process.env.VIEWSPEC_OUT ?? join(process.cwd(), 'tmp', 'viewspec')
const VIEWPORT = { width: 1440, height: 900 }

/**
 * Pages under conversion. Each entry lists query variants that must ALL match:
 * one default render proves little on a page whose shape changes with its
 * filters, so variants pin the branches that matter — here both sides of the
 * payable/receivable toggle and a search that returns nothing.
 */
const PAGES = [
  {
    path: '/reports/partners',
    variants: ['', '?kind=payable', '?kind=receivable', '?kind=receivable&q=zzzznomatch'],
  },
]

function specUrl(path, variant) {
  const separator = variant.includes('?') ? '&' : '?'
  return `${BASE}${path}${variant}${separator}__viewspec=1`
}

async function login(page) {
  const response = await page.request.post(`${BASE}/api/login`, {
    headers: { 'content-type': 'application/json', origin: BASE, referer: `${BASE}/login` },
    data: { email: EMAIL, password: PASSWORD },
  })
  if (!response.ok()) throw new Error(`login failed: ${response.status()} ${await response.text()}`)
}

/**
 * Navigate and wait until the page has genuinely settled: streaming finished,
 * no suspense fallback left, network quiet, and the mount fade complete. The
 * fade matters because `PageContainer` animates opacity on mount; screenshotting
 * mid-animation produces a diff that is pure timing noise.
 */
async function renderSettled(page, url) {
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForSelector('main', { state: 'attached' })
  await page.waitForFunction(
    () => {
      const main = document.querySelector('main')
      if (!main) return false
      // Suspense fallbacks leave `<template id="B:n">` placeholders behind.
      if (main.querySelector('template[id^="B:"]')) return false
      return main.textContent.trim().length > 0
    },
    { timeout: 30_000 },
  )
  await page.evaluate(() => document.fonts?.ready)
  // Settle mount transitions so the screenshot is of the resting state.
  await page.waitForTimeout(400)
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('main *')) {
      const style = getComputedStyle(el)
      if (parseFloat(style.opacity) < 1) el.style.opacity = '1'
      if (style.transform !== 'none') el.style.transform = 'none'
    }
  })
}

function normalize(markup) {
  return (
    markup
      // React suspense / segment comment markers.
      .replace(/<!--[\s\S]*?-->/g, '')
      // useId values depend on tree position and never reach the user.
      .replace(/\b(id|for|aria-labelledby|aria-controls|aria-describedby)="[^"]*«[^"]*»[^"]*"/g, '')
      // The conversion flag leaks into client-built self-referential hrefs
      // (ReportDrillLink rebuilds the query from useSearchParams). It is
      // harness scaffolding that disappears when the native branch is deleted,
      // so removing it is honest — but it has to be removed as a query
      // PARAMETER, preserving the `?`/`&` separator structure, and `&` arrives
      // entity-encoded inside an attribute value.
      .replace(/\?__viewspec=1(&amp;|&)/g, '?')
      .replace(/(&amp;|&)__viewspec=1/g, '')
      .replace(/\?__viewspec=1/g, '')
      .replace(/>\s+</g, '><')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

function tokenize(markup) {
  return markup.match(/<[^>]+>|[^<]+/g) ?? []
}

function firstDifference(a, b) {
  const ta = tokenize(a)
  const tb = tokenize(b)
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    if (ta[i] !== tb[i]) {
      return {
        index: i,
        context: ta.slice(Math.max(0, i - 5), i).join(''),
        native: ta[i] ?? '(end of document)',
        spec: tb[i] ?? '(end of document)',
      }
    }
  }
  return null
}

/**
 * Guard against the failure mode that produced the first false pass: if the
 * two variants of a page render byte-identical content, the harness is very
 * likely comparing chrome rather than content. Report it rather than counting
 * a pass.
 */
function assertVariantsDiffer(results) {
  const withContent = results.filter((r) => r.ok && r.markup)
  const distinct = new Set(withContent.map((r) => r.markup))
  if (withContent.length > 1 && distinct.size === 1) {
    return `every variant rendered identical markup (${withContent[0].markup.length} bytes) — the harness is probably not capturing page content`
  }
  return null
}

async function checkVariant(page, path, variant) {
  const nativeUrl = `${BASE}${path}${variant}`
  await renderSettled(page, nativeUrl)
  const nativeMarkup = normalize(await page.locator('main').innerHTML())
  const nativeShot = await page.screenshot({ fullPage: true })

  await renderSettled(page, specUrl(path, variant))
  const specMarkup = normalize(await page.locator('main').innerHTML())
  const specShot = await page.screenshot({ fullPage: true })

  const slug = `${path}${variant}`.replace(/[^a-z0-9]+/gi, '_')
  const pixelsEqual = nativeShot.equals(specShot)

  if (nativeMarkup === specMarkup && pixelsEqual) {
    return { ok: true, path, variant, bytes: nativeMarkup.length, markup: nativeMarkup }
  }

  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(join(OUT_DIR, `${slug}.native.html`), nativeMarkup)
  writeFileSync(join(OUT_DIR, `${slug}.spec.html`), specMarkup)
  writeFileSync(join(OUT_DIR, `${slug}.native.png`), nativeShot)
  writeFileSync(join(OUT_DIR, `${slug}.spec.png`), specShot)

  return {
    ok: false,
    path,
    variant,
    slug,
    structural: nativeMarkup === specMarkup,
    visual: pixelsEqual,
    diff: nativeMarkup === specMarkup ? null : firstDifference(nativeMarkup, specMarkup),
  }
}

async function main() {
  const only = process.argv[2]
  const pages = only ? PAGES.filter((p) => p.path === only) : PAGES
  if (pages.length === 0) {
    console.error(`no registered page matches ${only}`)
    process.exit(2)
  }

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: process.env.VIEWSPEC_HEADED !== '1',
  })
  let failures = 0
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 })
    const page = await context.newPage()
    await login(page)

    for (const entry of pages) {
      const results = []
      for (const variant of entry.variants) {
        let result
        try {
          result = await checkVariant(page, entry.path, variant)
        } catch (error) {
          failures += 1
          console.error(`✗ ${entry.path}${variant}\n    ${error.message}`)
          continue
        }
        results.push(result)
        if (result.ok) {
          console.log(`✓ ${entry.path}${variant || ' (default)'}  [${result.bytes} bytes, pixels identical]`)
          continue
        }
        failures += 1
        console.error(`✗ ${entry.path}${variant || ' (default)'}`)
        console.error(`    structural: ${result.structural ? 'match' : 'DIFFER'}   visual: ${result.visual ? 'match' : 'DIFFER'}`)
        if (result.diff) {
          console.error(`    first difference at node ${result.diff.index}, after: …${result.diff.context.slice(-140)}`)
          console.error(`    native: ${String(result.diff.native).slice(0, 220)}`)
          console.error(`    spec  : ${String(result.diff.spec).slice(0, 220)}`)
        }
        console.error(`    artifacts: ${join(OUT_DIR, `${result.slug}.*`)}`)
      }
      const suspicious = assertVariantsDiffer(results)
      if (suspicious) {
        failures += 1
        console.error(`✗ ${entry.path}: ${suspicious}`)
      }
    }
  } finally {
    await browser.close()
  }

  console.log(failures === 0 ? '\nconformance: PASS' : `\nconformance: FAIL (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
