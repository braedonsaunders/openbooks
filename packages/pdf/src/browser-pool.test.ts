import assert from 'node:assert/strict'
import test from 'node:test'
import type { Browser, LaunchOptions, Page } from 'puppeteer-core'
import {
  PdfBrowserPool,
  RendererUnavailableError,
  pdfRendererStatus,
  rendererExecutablePath,
  scrubRendererEnv,
  type PdfBrowserLauncher,
} from './browser-pool'

type FakePageOptions = {
  onClose?: () => void
  failInterception?: boolean
}

function fakePage(release: () => void, options: FakePageOptions = {}): Page {
  let closed = false
  return {
    setJavaScriptEnabled: async () => undefined,
    setRequestInterception: async () => {
      if (options.failInterception) throw new Error('interception exploded')
    },
    on: () => undefined,
    setContent: async () => undefined,
    pdf: async () => Buffer.from('%PDF-fake'),
    close: async () => {
      closed = true
      options.onClose?.()
      release()
    },
    get __closed() {
      return closed
    },
  } as unknown as Page
}

function fakeBrowser(newPageImpl: () => Promise<Page>, connected = true): Browser {
  return { connected, newPage: newPageImpl } as unknown as Browser
}

/** A launcher whose launch moment the test controls. */
function gatedLauncher() {
  const launches: LaunchOptions[] = []
  let releaseLaunch!: (browser: Browser) => void
  let launchesStarted = 0
  const launcher: PdfBrowserLauncher = (options) => {
    launches.push(options)
    launchesStarted += 1
    return new Promise<Browser>((resolve) => {
      releaseLaunch = resolve
    })
  }
  return { launches, launcher, get launchesStarted() { return launchesStarted }, releaseLaunch: (b: Browser) => releaseLaunch(b) }
}

test('concurrent renders share one launch instead of orphaning browsers', async () => {
  const gate = gatedLauncher()
  const pool = new PdfBrowserPool(gate.launcher)
  const pages: Page[] = []
  const renders = Array.from({ length: 3 }, () =>
    pool.withPage(async (page) => {
      pages.push(page)
      await new Promise((resolve) => setTimeout(resolve, 20))
      return 'done'
    }),
  )
  // Let every render reach the launch before releasing it once.
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(gate.launchesStarted, 1)
  gate.releaseLaunch(fakeBrowser(async () => fakePage(() => undefined)))
  assert.deepEqual(await Promise.all(renders), ['done', 'done', 'done'])
  assert.equal(gate.launches.length, 1)
})

test('a disconnected browser is relaunched on next use', async () => {
  const state = { connected: true }
  const launches: LaunchOptions[] = []
  const launcher: PdfBrowserLauncher = async (options) => {
    launches.push(options)
    const browser = fakeBrowser(async () => fakePage(() => undefined), true)
    Object.defineProperty(browser, 'connected', { get: () => state.connected })
    return browser
  }
  const pool = new PdfBrowserPool(launcher)
  await pool.withPage(async () => 'first')
  state.connected = false
  await pool.withPage(async () => 'second')
  assert.equal(launches.length, 2)
})

test('a page-setup failure still closes the page', async () => {
  let closed = 0
  const launcher: PdfBrowserLauncher = async () =>
    fakeBrowser(async () => fakePage(() => { closed += 1 }, { failInterception: true }))
  const pool = new PdfBrowserPool(launcher)
  await assert.rejects(pool.withPage(async () => 'never'), /interception exploded/)
  assert.equal(closed, 1)
})

test('concurrent pages are capped', async () => {
  let active = 0
  let peak = 0
  const launcher: PdfBrowserLauncher = async () =>
    fakeBrowser(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 15))
      return fakePage(() => {
        active -= 1
      })
    })
  const pool = new PdfBrowserPool(launcher)
  await Promise.all(Array.from({ length: 8 }, (_, i) => pool.withPage(async () => i)))
  assert.ok(peak <= 4, `expected at most 4 concurrent pages, saw ${peak}`)
  assert.ok(peak > 1, `expected actual concurrency, saw ${peak}`)
  assert.equal(active, 0)
})

test('the renderer environment carries no secrets', () => {
  const scrubbed = scrubRendererEnv({
    PATH: '/usr/bin',
    HOME: '/home/node',
    LANG: 'C.UTF-8',
    TMPDIR: '/tmp',
    OPENBOOKS_DB_URL: 'postgres://owner:secret@host/db',
    OPENBOOKS_DATA_KEY: '001122',
    OPENBOOKS_INTERNAL_TOKEN: 'internal',
    OPENBOOKS_S3_BUCKET: 'openbooks',
    SESSION_SECRET: 'session',
    S3_ACCESS_KEY_ID: 'akid',
    S3_SECRET_ACCESS_KEY: 'secret',
    MINIO_ROOT_PASSWORD: 'rootpw',
    // libpq reads this freestanding name with no underscore separator, so the
    // generic _PASSWORD suffix rule misses it — it needs its own entry.
    PGPASSWORD: 'dbpw',
    POSTGRES_OWNER_PASSWORD: 'dbpw',
    REDIS_PASSWORD: 'redispw',
    SOMETHING_API_TOKEN: 'tok',
  })
  for (const [key, value] of Object.entries(scrubbed)) {
    assert.ok(!/secret|password|token|key|url/i.test(`${key}=${value}`) || key === 'PATH', `${key} must not reach the renderer`)
  }
  assert.equal(scrubbed.PATH, '/usr/bin')
  assert.equal(scrubbed.HOME, '/home/node')
  assert.equal(scrubbed.LANG, 'C.UTF-8')
  assert.equal(scrubbed.OPENBOOKS_DB_URL, undefined)
  assert.equal(scrubbed.PGPASSWORD, undefined)
  assert.equal(scrubbed.SESSION_SECRET, undefined)
  assert.equal(scrubbed.S3_SECRET_ACCESS_KEY, undefined)
})

test('a sandbox failure retries unsandboxed with a warning', async () => {
  const launches: LaunchOptions[] = []
  const warnings: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => void warnings.push(args)
  const previous = process.env.OPENBOOKS_CHROMIUM_NO_SANDBOX
  delete process.env.OPENBOOKS_CHROMIUM_NO_SANDBOX
  try {
    let calls = 0
    const launcher: PdfBrowserLauncher = async (options) => {
      launches.push(options)
      calls += 1
      if (calls === 1) throw new Error('Failed to launch the browser process! Failed to move to new namespace')
      return fakeBrowser(async () => fakePage(() => undefined))
    }
    const pool = new PdfBrowserPool(launcher)
    assert.equal(await pool.withPage(async () => 'ok'), 'ok')
    assert.equal(launches.length, 2)
    assert.ok(!(launches[0]!.args ?? []).includes('--no-sandbox'), 'first attempt keeps the sandbox')
    assert.ok((launches[1]!.args ?? []).includes('--no-sandbox'), 'retry drops it')
    assert.ok(warnings.some((args) => args.join(' ').includes('--no-sandbox')))
    // The scrubbed env rides on every launch, sandboxed or not.
    for (const launch of launches) {
      assert.equal((launch.env as Record<string, string | undefined>)?.OPENBOOKS_DB_URL, undefined)
    }
  } finally {
    console.warn = originalWarn
    if (previous === undefined) delete process.env.OPENBOOKS_CHROMIUM_NO_SANDBOX
    else process.env.OPENBOOKS_CHROMIUM_NO_SANDBOX = previous
  }
})

test('a non-sandbox launch failure is not retried', async () => {
  let calls = 0
  const launcher: PdfBrowserLauncher = async () => {
    calls += 1
    throw new Error('no such executable: /usr/bin/chromium')
  }
  const pool = new PdfBrowserPool(launcher)
  await assert.rejects(pool.withPage(async () => 'never'), /no such executable/)
  assert.equal(calls, 1)
})

test('a missing executable fails as the typed refusal naming the path and the remedy', async () => {
  // This machine has no Chromium: point the pool at a path that cannot
  // exist, with the exact shape puppeteer-core reports for it.
  const missing = '/nonexistent-dir-7c2/chromium'
  const previous = process.env.PUPPETEER_EXECUTABLE_PATH
  process.env.PUPPETEER_EXECUTABLE_PATH = missing
  try {
    assert.equal(rendererExecutablePath(), missing)
    let calls = 0
    const launcher: PdfBrowserLauncher = async () => {
      calls += 1
      throw new Error(`Browser was not found at the configured executablePath (${missing})`)
    }
    const pool = new PdfBrowserPool(launcher)
    const error = await pool.withPage(async () => 'never').catch((e: unknown) => e)
    assert.ok(error instanceof RendererUnavailableError, `expected RendererUnavailableError, saw ${error}`)
    assert.equal(error.executablePath, missing)
    assert.match(error.message, /PDF renderer is unavailable/)
    assert.ok(error.message.includes(missing), 'the refusal names the path it tried')
    assert.ok(error.message.includes('PUPPETEER_EXECUTABLE_PATH'), 'the refusal names the remedy')
    // A missing binary is not a sandbox problem: no --no-sandbox retry.
    assert.equal(calls, 1)
  } finally {
    if (previous === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH
    else process.env.PUPPETEER_EXECUTABLE_PATH = previous
  }
})

test('a raw ENOENT spawn naming the executable fails as the typed refusal', async () => {
  const missing = '/nonexistent-dir-7c2/chromium'
  const previous = process.env.PUPPETEER_EXECUTABLE_PATH
  process.env.PUPPETEER_EXECUTABLE_PATH = missing
  try {
    const spawnError = Object.assign(
      new Error(`spawn ${missing} ENOENT`),
      { code: 'ENOENT' },
    )
    const pool = new PdfBrowserPool(async () => { throw spawnError })
    const error = await pool.withPage(async () => 'never').catch((e: unknown) => e)
    assert.ok(error instanceof RendererUnavailableError, `expected RendererUnavailableError, saw ${error}`)
    assert.equal((error as RendererUnavailableError).executablePath, missing)
  } finally {
    if (previous === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH
    else process.env.PUPPETEER_EXECUTABLE_PATH = previous
  }
})

test('renderer readiness reports unavailable with the remedy when the executable is absent', () => {
  const missing = '/nonexistent-dir-7c2/chromium'
  const previous = process.env.PUPPETEER_EXECUTABLE_PATH
  process.env.PUPPETEER_EXECUTABLE_PATH = missing
  try {
    const status = pdfRendererStatus()
    assert.equal(status.available, false)
    assert.equal(status.executablePath, missing)
    assert.ok(status.message.includes(missing), 'readiness names the path it tried')
    assert.ok(status.message.includes('PUPPETEER_EXECUTABLE_PATH'), 'readiness names the remedy')
  } finally {
    if (previous === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH
    else process.env.PUPPETEER_EXECUTABLE_PATH = previous
  }
})

test('an explicit opt-out launches unsandboxed immediately', async () => {
  const launches: LaunchOptions[] = []
  const previous = process.env.OPENBOOKS_CHROMIUM_NO_SANDBOX
  process.env.OPENBOOKS_CHROMIUM_NO_SANDBOX = '1'
  try {
    const launcher: PdfBrowserLauncher = async (options) => {
      launches.push(options)
      return fakeBrowser(async () => fakePage(() => undefined))
    }
    const pool = new PdfBrowserPool(launcher)
    assert.equal(await pool.withPage(async () => 'ok'), 'ok')
    assert.equal(launches.length, 1)
    assert.ok((launches[0]!.args ?? []).includes('--no-sandbox'))
  } finally {
    if (previous === undefined) delete process.env.OPENBOOKS_CHROMIUM_NO_SANDBOX
    else process.env.OPENBOOKS_CHROMIUM_NO_SANDBOX = previous
  }
})
