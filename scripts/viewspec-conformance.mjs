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
import sharp from 'sharp'

const BASE = process.env.VIEWSPEC_BASE_URL ?? 'http://localhost:4780'
const EMAIL = process.env.VIEWSPEC_EMAIL ?? 'viewspec@sim.test'
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
    variants: [
      '',
      '?kind=payable',
      '?kind=receivable',
      // Deliberate empty result: assert the empty branch, not row content.
      { query: '?kind=receivable&q=zzzznomatch', expect: 'table thead th', minMatches: 1 },
    ],
    // Proof the page actually rendered. Without a positive content assertion a
    // capture taken during the loading screen compares blank against blank.
    expect: 'table tbody tr',
    minMatches: 3,
  },
  {
    path: '/reports/pnl',
    // Exercise the statement matrix's real branches: comparison columns,
    // dimension breakout, and a scaled presentation.
    variants: ['', '?compare=prior_period', '?breakout=month', '?scale=thousands', '?showZero=1'],
    expect: 'table tbody tr',
    minMatches: 5,
  },
  {
    path: '/reports/journal',
    // Grouped/repeating content: entries with nested line tables.
    variants: ['', '?period=this_fiscal_year'],
    expect: 'table tbody tr',
    minMatches: 5,
  },
  {
    path: '/reports/general-ledger',
    // Repeating groups WITH spanning opening/closing summary rows.
    variants: ['', '?period=this_fiscal_year'],
    expect: 'table tbody tr',
    minMatches: 5,
  },
  {
    path: '/reports/orders',
    variants: [''],
    expect: 'table tbody tr',
    minMatches: 3,
  },
  {
    path: '/data/import/history',
    // First app-variant list table (card chrome, sticky header, EmptyState).
    variants: [''],
    expect: 'table tbody tr',
    minMatches: 3,
  },
  {
    path: '/reports/registers',
    variants: ['', '?side=ap'],
    expect: 'table tbody tr',
    minMatches: 5,
  },
  {
    path: '/purchasing',
    variants: [''],
    // The cockpit's hero panel — proves the grid/panel composition rendered,
    // not just the page shell.
    expect: 'h2, h3',
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
async function renderSettled(page, url, expectSelector, minMatches = 0) {
  // `domcontentloaded`, not `networkidle`: a large page with many client
  // components (a register with thousands of transaction links) never reaches
  // network idle within any sane timeout, while serving in ~60ms. Readiness is
  // asserted explicitly below — suspense drained, content selector visible,
  // overlays cleared — which is stricter than idle anyway.
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForSelector('main', { state: 'attached' })
  // Suspense fallbacks leave `<template id="B:n">` placeholders behind.
  await page.waitForFunction(
    () => {
      const main = document.querySelector('main')
      return !!main && !main.querySelector('template[id^="B:"]')
    },
    { timeout: 30_000 },
  )
  // The positive assertion. `textContent.length > 0` is not enough — the
  // loading screen satisfies it — so each page names an element that only
  // exists once its real content has rendered.
  if (expectSelector) {
    await page.waitForSelector(expectSelector, { state: 'visible', timeout: 30_000 })
  }
  // A page that legitimately renders its EMPTY state is not blank, so the ink
  // and byte-count guards pass it happily while proving nothing about the
  // table path. `minMatches` demands real content: import history passed at
  // 2068 bytes with zero rows before this existed.
  if (expectSelector && minMatches > 0) {
    const found = await page.locator(expectSelector).count()
    if (found < minMatches) {
      throw new Error(
        `${url} matched ${found} of "${expectSelector}", need ${minMatches} — the page has no data, so this comparison would prove nothing`,
      )
    }
  }
  // Wait out the brand splash. It is a root-layout overlay held for
  // MIN_VISIBLE_MS (2s) plus a 400ms fade on EVERY document load, so a capture
  // taken before it clears photographs the splash instead of the page — which
  // is identical on both sides and passes a pixel comparison meaninglessly.
  // Matching any full-viewport fixed overlay rather than the splash's own
  // classes keeps this correct if another overlay is introduced later.
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('body *')].some((el) => {
        const style = getComputedStyle(el)
        if (style.position !== 'fixed' || style.visibility === 'hidden') return false
        if (parseFloat(style.opacity) <= 0.01) return false
        const rect = el.getBoundingClientRect()
        return rect.width >= window.innerWidth * 0.9 && rect.height >= window.innerHeight * 0.9
      }),
    { timeout: 30_000 },
  )
  await page.evaluate(() => document.fonts?.ready)
}

/**
 * Screenshot the resting state.
 *
 * NOT `animations: 'disabled'`: that rewinds finite animations to their first
 * frame, and this app's entrance animations start at opacity 0, so it renders
 * a blank page — identically blank on both sides, which passes a pixel
 * comparison while proving nothing. Instead let entrance animations finish,
 * then hard-stop everything still moving. The brand logo runs an infinite
 * 12s stroke-redraw cycle; `animation: none` drops it to its resting fully
 * drawn state, which is deterministic.
 */
async function captureSettled(page) {
  await page.waitForTimeout(900)
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  })
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('main *')) {
      const style = getComputedStyle(el)
      if (parseFloat(style.opacity) < 1) el.style.opacity = '1'
      if (style.transform !== 'none') el.style.transform = 'none'
    }
  })
  await page.waitForTimeout(120)
  return await page.screenshot({ fullPage: true, caret: 'hide' })
}

function normalize(markup) {
  return (
    markup
      // React suspense / segment comment markers.
      .replace(/<!--[\s\S]*?-->/g, '')
      // useId values depend on tree position and never reach the user.
      .replace(/\b(id|for|aria-labelledby|aria-controls|aria-describedby)="[^"]*«[^"]*»[^"]*"/g, '')
      // ECharts stamps each chart with a per-instance counter/timestamp. Same
      // class of framework noise as useId: generated per mount, never rendered.
      .replace(/ _echarts_instance_="[^"]*"/g, '')
      // The conversion flag leaks into client-built self-referential hrefs
      // (ReportDrillLink rebuilds the query from useSearchParams). It is
      // harness scaffolding that disappears when the native branch is deleted,
      // so removing it is honest — but it has to be removed as a query
      // PARAMETER, preserving the `?`/`&` separator structure, and `&` arrives
      // entity-encoded inside an attribute value.
      .replace(/\?__viewspec=1(&amp;|&)/g, '?')
      .replace(/(&amp;|&)__viewspec=1/g, '')
      .replace(/\?__viewspec=1/g, '')
      // …and again URL-ENCODED, because links that carry a return path embed
      // the current query inside a parameter value (drawerReturn=%2F…%3F…).
      .replace(/%3F__viewspec%3D1(%26)/gi, '%3F')
      .replace(/%26__viewspec%3D1/gi, '')
      .replace(/%3F__viewspec%3D1/gi, '')
      .replace(/>\s+</g, '><')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/**
 * Sort attributes within each tag.
 *
 * Attribute ORDER carries no meaning in HTML and is not user-visible, but
 * React's hydration writes some attributes in a different sequence than the
 * server did (a controlled `<input>` gets `type` reapplied before `value`),
 * so two identical renders can serialize differently purely by timing. Sorting
 * removes that noise without hiding anything real: attribute presence and
 * every value are preserved exactly, so a genuinely different class list, a
 * missing attribute, or a changed value still fails.
 */
function sortAttributes(markup) {
  return markup.replace(/<([a-zA-Z][\w-]*)((?:\s+[^\s=>]+(?:="[^"]*")?)+)\s*(\/?)>/g, (_all, tag, attrs, selfClose) => {
    const pairs = attrs.match(/[^\s=]+(?:="[^"]*")?/g) ?? []
    pairs.sort()
    return `<${tag}${pairs.length ? ' ' + pairs.join(' ') : ''}${selfClose}>`
  })
}

/**
 * Sort the class list inside every class attribute.
 *
 * Utility ORDER in the attribute does not affect what Tailwind renders —
 * precedence comes from the order utilities are defined in the compiled CSS,
 * not from the order they appear on the element. So two elements with the same
 * SET of classes are visually identical, and comparing them as ordered strings
 * would fail on nothing but authoring sequence. Sorting preserves the set
 * exactly, so a missing or extra class still fails.
 */
function sortClassLists(markup) {
  return markup.replace(/class="([^"]*)"/g, (_all, classes) => {
    const sorted = classes.trim().split(/\s+/).filter(Boolean).sort().join(' ')
    return `class="${sorted}"`
  })
}

/**
 * Canonicalize inline style attributes.
 *
 * The same declarations serialize two ways depending on how they were set:
 * framer-motion's SSR output is `opacity:1;transform:none`, while a style the
 * browser has since written through the CSSOM comes back as
 * `opacity: 1; transform: none;`. Which one you get depends on whether a row's
 * entrance animation had finished at read time — a race, not a difference.
 *
 * Declarations are preserved exactly; only spacing, trailing semicolons and
 * order are normalized, so a changed or missing property still fails.
 */
function normalizeStyles(markup) {
  return markup.replace(/style="([^"]*)"/g, (_all, style) => {
    const declarations = style
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const index = d.indexOf(':')
        return index === -1 ? d : `${d.slice(0, index).trim()}:${d.slice(index + 1).trim()}`
      })
      .sort()
    return `style="${declarations.join(';')}"`
  })
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

/**
 * Confirm the page actually took the branch we think it did.
 *
 * The converted page emits `<meta name="x-viewspec-render">` on the spec path
 * only, hoisted into <head> and therefore outside the compared <main>. Without
 * this check a server still running a build that predates the conversion would
 * serve the native page for BOTH urls and the harness would report a perfect
 * pass — which is exactly what happened before it existed.
 */
async function renderPath(page) {
  return await page.evaluate(() =>
    document.querySelector('meta[name="x-viewspec-render"]') ? 'viewspec' : 'native',
  )
}

/**
 * The stylesheet must actually load. A pixel comparison between two UNSTYLED
 * pages passes trivially, so an app rendering without CSS invalidates the
 * visual half of every result.
 */
async function assertStylesLoaded(page) {
  const status = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="stylesheet"]')
    if (!link) return 'no-stylesheet-link'
    const res = await fetch(link.href)
    if (!res.ok) return `stylesheet ${res.status}`
    const text = await res.text()
    // A real Tailwind build defines the utilities the app is written in.
    return /\.flex\b/.test(text) && /\.text-sm\b/.test(text) ? 'ok' : 'stylesheet-missing-utilities'
  })
  if (status !== 'ok') throw new Error(`styles not loaded: ${status}`)
}


/**
 * Reject a capture that is essentially empty.
 *
 * This harness has produced three false passes, and every one shared a shape:
 * both sides rendered the SAME nothing (a streaming fallback, a stale build,
 * an animation rewound to opacity 0) and the comparison happily reported a
 * match. A pixel comparison cannot tell "identical" from "identically blank",
 * so the content has to be asserted independently of the diff.
 *
 * A real page is mostly background with text, rules and chrome over it. Well
 * under 1% non-background means the capture is a loading screen.
 */
/**
 * Count differing pixels between two captures.
 *
 * Byte equality is too strict: subpixel text antialiasing varies by a handful
 * of pixels between two renders of identical markup. A tolerance is dangerous
 * in principle — it is exactly the mechanism that hides real differences — so
 * it is bounded three ways: the DOM must already match exactly (structure is
 * the real gate, pixels are the backstop), the budget is a few tens of pixels
 * out of ~1.3M, and the actual count is ALWAYS printed on success so a slow
 * creep upward is visible rather than silent.
 */
async function pixelDiff(a, b) {
  const [ra, rb] = await Promise.all([
    sharp(a).raw().toBuffer({ resolveWithObject: true }),
    sharp(b).raw().toBuffer({ resolveWithObject: true }),
  ])
  if (ra.info.width !== rb.info.width || ra.info.height !== rb.info.height) {
    return { differing: Infinity, reason: `size ${ra.info.width}x${ra.info.height} vs ${rb.info.width}x${rb.info.height}` }
  }
  const { width, height, channels } = ra.info
  let differing = 0
  for (let i = 0; i < width * height * channels; i += channels) {
    if (ra.data[i] !== rb.data[i] || ra.data[i + 1] !== rb.data[i + 1] || ra.data[i + 2] !== rb.data[i + 2]) {
      differing++
    }
  }
  return { differing, total: width * height }
}

/** ~0.005% of a 1440x900 frame. Antialiasing noise only. */
const PIXEL_TOLERANCE = 64

async function assertNotBlank(shot, label) {
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true })
  const counts = new Map()
  const total = info.width * info.height
  for (let i = 0; i < data.length; i += info.channels) {
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let dominant = 0
  for (const n of counts.values()) if (n > dominant) dominant = n
  const inkRatio = 1 - dominant / total
  if (inkRatio < 0.01) {
    throw new Error(
      `${label} capture is blank (${(inkRatio * 100).toFixed(2)}% non-background) — the page had not rendered`,
    )
  }
  return inkRatio
}

async function checkVariant(page, path, variant, expectSelector, minMatches) {
  const nativeUrl = `${BASE}${path}${variant}`
  await renderSettled(page, nativeUrl, expectSelector, minMatches)
  await assertStylesLoaded(page)
  const nativePath = await renderPath(page)
  if (nativePath !== 'native') throw new Error(`${nativeUrl} rendered via ${nativePath}, expected native`)
  const nativeMarkup = normalizeStyles(sortClassLists(sortAttributes(normalize(await page.locator('main').innerHTML()))))
  const nativeShot = await captureSettled(page)
  const ink = await assertNotBlank(nativeShot, `${path}${variant} native`)

  await renderSettled(page, specUrl(path, variant), expectSelector, minMatches)
  const chosen = await renderPath(page)
  if (chosen !== 'viewspec') {
    throw new Error(
      `${specUrl(path, variant)} rendered via ${chosen}, expected viewspec — the server is probably serving a build that predates the conversion`,
    )
  }
  const specMarkup = normalizeStyles(sortClassLists(sortAttributes(normalize(await page.locator('main').innerHTML()))))
  const specShot = await captureSettled(page)
  await assertNotBlank(specShot, `${path}${variant} spec`)

  const slug = `${path}${variant}`.replace(/[^a-z0-9]+/gi, '_')
  const pixels = nativeShot.equals(specShot) ? { differing: 0 } : await pixelDiff(nativeShot, specShot)
  const pixelsEqual = pixels.differing <= PIXEL_TOLERANCE

  if (nativeMarkup === specMarkup && pixelsEqual) {
    return {
      ok: true,
      path,
      variant,
      bytes: nativeMarkup.length,
      markup: nativeMarkup,
      ink,
      pixels: pixels.differing,
    }
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
    pixels: pixels.differing,
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
      for (const raw of entry.variants) {
        // A variant may be a bare query string, or an object overriding the
        // page's expectations — an intentional empty-result case has to opt out
        // of the data-presence requirement rather than weaken it for everyone.
        const variant = typeof raw === 'string' ? raw : raw.query
        const expect = (typeof raw === 'string' ? undefined : raw.expect) ?? entry.expect
        const minMatches =
          typeof raw === 'string' ? (entry.minMatches ?? 0) : (raw.minMatches ?? entry.minMatches ?? 0)
        let result
        try {
          result = await checkVariant(page, entry.path, variant, expect, minMatches)
        } catch (error) {
          failures += 1
          console.error(`✗ ${entry.path}${variant}\n    ${error.message}`)
          continue
        }
        results.push(result)
        if (result.ok) {
          console.log(
          `✓ ${entry.path}${variant || ' (default)'}  [${result.bytes} bytes, ${result.pixels === 0 ? 'pixels identical' : `${result.pixels} px AA`}, ${(result.ink * 100).toFixed(1)}% ink]`,
        )
          continue
        }
        failures += 1
        console.error(`✗ ${entry.path}${variant || ' (default)'}`)
        console.error(`    structural: ${result.structural ? 'match' : 'DIFFER'}   visual: ${result.visual ? 'match' : `DIFFER (${result.pixels} px, tolerance ${PIXEL_TOLERANCE})`}`)
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
