#!/usr/bin/env node
/**
 * Open a logged-in Chrome window with the native and spec renders side by side.
 *
 * Uses its own user-data directory so it never touches the developer's real
 * Chrome profile or session. The window stays open until closed manually; this
 * process stays alive to own it.
 */

import { chromium } from 'playwright'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const BASE = process.env.VIEWSPEC_BASE_URL ?? 'http://localhost:4780'
const EMAIL = process.env.VIEWSPEC_EMAIL ?? 'viewspec@sim.test'
const PASSWORD = process.env.VIEWSPEC_PASSWORD ?? 'viewspec-dev'
const PROFILE = process.env.VIEWSPEC_PROFILE ?? join(tmpdir(), 'viewspec-chrome-profile')

const TABS = process.argv.slice(2)
if (TABS.length === 0) {
  TABS.push('/reports/partners?kind=payable', '/reports/partners?kind=payable&__viewspec=1')
}

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  channel: 'chrome',
  viewport: null,
  args: ['--window-size=1600,1000'],
})

const response = await context.request.post(`${BASE}/api/login`, {
  headers: { 'content-type': 'application/json', origin: BASE, referer: `${BASE}/login` },
  data: { email: EMAIL, password: PASSWORD },
})
if (!response.ok()) {
  console.error(`login failed: ${response.status()} ${await response.text()}`)
  await context.close()
  process.exit(1)
}
console.log(`logged in as ${EMAIL}`)

// The persistent context shares its cookie jar with page navigations, so the
// tabs below open already authenticated.
const existing = context.pages()
for (let i = 0; i < TABS.length; i++) {
  const page = i === 0 && existing[0] ? existing[0] : await context.newPage()
  await page.goto(`${BASE}${TABS[i]}`, { waitUntil: 'domcontentloaded' })
  console.log(`tab ${i + 1}: ${TABS[i]}`)
}

console.log('\nChrome is open. This process owns the window; leave it running.')

// Stay alive so the browser stays open, and exit cleanly when it is closed.
await new Promise((resolve) => context.on('close', resolve))
