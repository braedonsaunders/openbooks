// Shared Chromium browser pool behind HTML → PDF printing (see html.ts).
// Owns the process-wide browser lifecycle: sandboxed launch with fallback,
// secret-scrubbed child environment, single-flight launch, and a capped,
// always-closed page semaphore.

import puppeteer, {
  type Browser,
  type LaunchOptions,
  type Page,
} from 'puppeteer-core'
import { isAllowedPdfRequest } from './template'

/**
 * Cap on concurrent print pages. Each page is a full renderer holding a
 * parsed 16 MiB-scale document; unbounded pages under burst load OOM the
 * container (and every page shares the one browser's IO threads).
 */
const MAX_CONCURRENT_PDF_PAGES = 4

function resolveExecutable(): string {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH
  if (fromEnv) return fromEnv

  // Production images install Chromium at this fixed path (see Dockerfile).
  // Keep local development deterministic too, without probing arbitrary
  // filesystem paths that would make Next output tracing crawl the host.
  if (process.platform === 'linux') {
    return '/usr/bin/chromium'
  }
  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  }
  throw new Error(
    'Set PUPPETEER_EXECUTABLE_PATH to the approved Chrome/Chromium executable.',
  )
}

/**
 * Secrets are blocklisted out of the renderer environment, never allowlisted
 * in: an allowlist risks breaking rendering (fonts, locale, temp dirs) in
 * ways no test here can catch — this package's suite never launches a real
 * browser — while a missed secret on a deny list only matters after a
 * renderer escape that the sandbox (below) already contains. The app's whole
 * secret surface lives under OPENBOOKS_ plus the freestanding transport and
 * credential names enumerated here; everything else passes through so the
 * renderer keeps working exactly as it does today.
 */
const RENDERER_SECRET_ENV = /^(OPENBOOKS_|S3_|MINIO_|POSTGRES_|REDIS_|DATABASE_URL$|REDIS_URL$|SESSION_SECRET$|PGPASSWORD$)|(_PASSWORD$|_SECRET$|_TOKEN$|_PRIVATE_KEY$)/

export function scrubRendererEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const scrubbed: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (RENDERER_SECRET_ENV.test(key)) continue
    scrubbed[key] = value
  }
  return scrubbed
}

/**
 * Chromium sandbox arguments. The sandbox stays ON by default: this renderer
 * executes tenant-authored markup in processes (web, worker) whose
 * environment holds database and data keys. Container runtimes whose seccomp
 * profile blocks unprivileged user namespaces cannot run it — the Dockerfile
 * runs as non-root `node`, and swarm's default seccomp denies the `unshare`
 * the sandbox needs — so a sandbox failure falls back to `--no-sandbox`
 * with a loud warning naming the cause (see `launchSandboxed`), and
 * operators who know their runtime cannot sandbox can set
 * OPENBOOKS_CHROMIUM_NO_SANDBOX=1 to skip the doomed first attempt. Either
 * way the child environment is scrubbed (above), so even an unsandboxed
 * renderer never sees the keys.
 */
function chromiumArgs(noSandbox: boolean): string[] {
  const args = ['--disable-dev-shm-usage', '--font-render-hinting=none']
  if (noSandbox) args.unshift('--no-sandbox')
  return args
}

export type PdfBrowserLauncher = (options: LaunchOptions) => Promise<Browser>

const defaultLauncher: PdfBrowserLauncher = (options) => puppeteer.launch(options)

/** A launch failure plausibly caused by the sandbox (namespace/zygote/setuid denied). */
function looksLikeSandboxFailure(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${String((error as { stderr?: unknown }).stderr ?? '')}` : String(error)
  return /sandbox|namespace|zygote|setuid|permission denied|operation not permitted/i.test(message)
}

async function launchSandboxed(launcher: PdfBrowserLauncher): Promise<Browser> {
  const baseOptions = {
    executablePath: resolveExecutable(),
    headless: true,
    env: scrubRendererEnv(),
  } as const
  if (process.env.OPENBOOKS_CHROMIUM_NO_SANDBOX === '1') {
    return launcher({ ...baseOptions, args: chromiumArgs(true) })
  }
  try {
    return await launcher({ ...baseOptions, args: chromiumArgs(false) })
  } catch (error) {
    if (!looksLikeSandboxFailure(error)) throw error
    console.warn(
      '[pdf] Chromium sandbox unavailable (user namespaces blocked by the container runtime?) — ' +
        `retrying with --no-sandbox. Cause: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
    )
    return launcher({ ...baseOptions, args: chromiumArgs(true) })
  }
}

/**
 * The single shared browser behind every print. Launching is single-flight:
 * concurrent renders racing a disconnect used to each launch their own
 * browser and orphan all but the last winner. Page creation is semaphore
 * capped (MAX_CONCURRENT_PDF_PAGES) and always paired with a close, so a
 * setup failure (request interception, content load) cannot leak the page.
 */
export class PdfBrowserPool {
  private browserPromise: Promise<Browser> | null = null
  private launchPromise: Promise<Browser> | null = null
  private activePages = 0
  private waiters: Array<() => void> = []

  constructor(private readonly launcher: PdfBrowserLauncher = defaultLauncher) {}

  private async getBrowser(): Promise<Browser> {
    if (this.browserPromise) {
      const existing = await this.browserPromise.catch(() => null)
      if (existing?.connected) return existing
      this.browserPromise = null
    }
    // Single-flight: every concurrent caller awaits the one launch instead
    // of starting its own browser and orphaning the loser.
    this.launchPromise ??= launchSandboxed(this.launcher).finally(() => {
      this.launchPromise = null
    })
    this.browserPromise = this.launchPromise
    return this.browserPromise
  }

  private async acquirePageSlot(): Promise<() => void> {
    if (this.activePages < MAX_CONCURRENT_PDF_PAGES) {
      this.activePages += 1
      return () => this.releasePageSlot()
    }
    // The slot is transferred, not freed: releasePageSlot keeps
    // activePages unchanged when a waiter exists, so a newcomer racing the
    // wakeup cannot barge in and push the count over the cap.
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    return () => this.releasePageSlot()
  }

  private releasePageSlot(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
      return
    }
    this.activePages -= 1
  }

  /** Run `fn` with a hardened print page that is always closed afterwards. */
  async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const release = await this.acquirePageSlot()
    let page: Page | null = null
    try {
      const browser = await this.getBrowser()
      // Page creation lives INSIDE the try: a setRequestInterception
      // failure used to escape past the close and leak the page.
      page = await browser.newPage()
      await page.setJavaScriptEnabled(false)
      await page.setRequestInterception(true)
      page.on('request', (request) => {
        if (isAllowedPdfRequest(request.resourceType(), request.url())) {
          void request.continue()
        } else {
          void request.abort()
        }
      })
      return await fn(page)
    } finally {
      await page?.close().catch(() => undefined)
      release()
    }
  }
}

const sharedPool = new PdfBrowserPool()

/** The process-wide print pool behind `renderHtmlDocumentPdf`. */
export function sharedPdfPool(): PdfBrowserPool {
  return sharedPool
}
