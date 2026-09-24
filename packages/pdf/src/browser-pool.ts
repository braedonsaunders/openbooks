// Shared Chromium browser pool behind HTML → PDF printing (see html.ts).
// Owns the process-wide browser lifecycle: sandboxed launch with fallback,
// secret-scrubbed child environment, single-flight launch, and a capped,
// always-closed page semaphore.

import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import puppeteer, {
  type Browser,
  type LaunchOptions,
  type Page,
} from 'puppeteer-core'
import { isAllowedPdfRequest } from './template'

/**
 * The PDF renderer (headless Chromium) cannot start. The message names the
 * executable path the pool tried and the remedy — install Chromium or set
 * PUPPETEER_EXECUTABLE_PATH — because a missing renderer is an operator
 * precondition, never a tenant fault, and answering it as a generic 500
 * leaves the operator retrying a preview that can never succeed.
 */
export class RendererUnavailableError extends Error {
  readonly executablePath: string | null
  constructor(executablePath: string | null) {
    super(rendererUnavailableMessage(executablePath))
    this.name = 'RendererUnavailableError'
    this.executablePath = executablePath
  }
}

function rendererRemedy(): string {
  return 'Install Chromium on the app server or set PUPPETEER_EXECUTABLE_PATH to the approved Chrome/Chromium executable.'
}

function rendererUnavailableMessage(executablePath: string | null): string {
  const where = executablePath
    ? `Chromium was not found at ${executablePath}.`
    : `No Chromium executable is configured for this platform (${process.platform}).`
  return `PDF renderer is unavailable: ${where} ${rendererRemedy()}`
}

/**
 * Cap on concurrent print pages. Each page is a full renderer holding a
 * parsed 16 MiB-scale document; unbounded pages under burst load OOM the
 * container (and every page shares the one browser's IO threads).
 */
const MAX_CONCURRENT_PDF_PAGES = 4

/**
 * The Chromium executable the pool would launch, or null when no executable
 * is configured for this platform. Null is a distinct outcome from "a path
 * that is missing on disk": the former needs configuration, the latter needs
 * installation, and the refusal names which.
 */
export function rendererExecutablePath(): string | null {
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
  return null
}

function resolveExecutable(): string {
  const resolved = rendererExecutablePath()
  if (resolved === null) throw new RendererUnavailableError(null)
  return resolved
}

/** Readiness for status surfaces: is the configured executable present? */
export interface PdfRendererStatus {
  available: boolean
  executablePath: string | null
  message: string
}

/**
 * Renderer readiness without launching a browser. A launch probe would start
 * a persistent pooled browser from a status check, so readiness reports the
 * deployment precondition — the configured executable is present — while a
 * genuine launch failure still surfaces as RendererUnavailableError at
 * render time. A bare command (resolved through PATH) is looked up in PATH;
 * anything else must be an absolute path on disk.
 */
export function pdfRendererStatus(): PdfRendererStatus {
  const executablePath = rendererExecutablePath()
  if (executablePath === null) {
    return { available: false, executablePath, message: new RendererUnavailableError(null).message }
  }
  const present = isAbsolute(executablePath)
    ? existsSync(executablePath)
    : (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, executablePath)))
  if (!present) {
    return { available: false, executablePath, message: new RendererUnavailableError(executablePath).message }
  }
  return { available: true, executablePath, message: `PDF renderer is available at ${executablePath}.` }
}

/**
 * The renderer environment is an ALLOWLIST of what headless Chromium needs,
 * never a denylist of what secrets look like: a denylist misses every secret
 * shape it fails to enumerate (`*_KEY` and `*_ID` names like AWS_ACCESS_KEY_ID
 * reached the child), while an allowlist fails closed on anything new. The
 * renderer loads only inline `data:` resources (see `isAllowedPdfRequest`),
 * so it needs no credentials at all — only locale, fonts, temp dirs, and the
 * display/session plumbing below. Anything outside this list is dropped,
 * including the whole `OPENBOOKS_` surface and freestanding transport names
 * (`DATABASE_URL`, `PGPASSWORD`, …).
 */
const RENDERER_ENV_ALLOW_EXACT = new Set([
  // Process basics.
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'HOSTNAME',
  // Locale (Chromium formats dates/numbers with these).
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_NUMERIC',
  'LC_TIME', 'LC_COLLATE', 'LC_MONETARY', 'LC_ADDRESS', 'LC_IDENTIFICATION',
  'LC_MEASUREMENT', 'LC_NAME', 'LC_PAPER', 'LC_TELEPHONE', 'LOCPATH', 'TZ',
  // Temp dirs (render pages spill here).
  'TMPDIR', 'TEMP', 'TMP',
  // Display/session plumbing for Linux launches.
  'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_SESSION_TYPE',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_DATA_DIRS', 'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  // Font discovery (custom fontconfig setups) and library lookup.
  'FONTCONFIG_PATH', 'FONTCONFIG_FILE', 'LD_LIBRARY_PATH',
  // Windows session basics for local development launches.
  'SYSTEMROOT', 'WINDIR',
])

/** Namespace prefixes that are path/locale/session-typed, never secret-bearing. */
const RENDERER_ENV_ALLOW_PREFIX = [/^LC_/, /^FONTCONFIG_/, /^FC_/, /^XDG_/]

export function scrubRendererEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const scrubbed: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (RENDERER_ENV_ALLOW_EXACT.has(key)) {
      scrubbed[key] = value
      continue
    }
    if (RENDERER_ENV_ALLOW_PREFIX.some((prefix) => prefix.test(key))) scrubbed[key] = value
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

/**
 * A launch failure caused by a missing Chromium executable. Puppeteer reports
 * it as "Browser was not found at the configured executablePath (…)"; a
 * raw spawn reports ENOENT naming the path. Either shape becomes the typed
 * refusal naming the path and the remedy — never a generic launch error the
 * routes would answer as an unexpected 500. Checked BEFORE the sandbox
 * classification: a missing binary is not a sandbox problem and must not be
 * retried with --no-sandbox.
 */
function looksLikeMissingExecutable(error: unknown, executablePath: string): boolean {
  if (error instanceof RendererUnavailableError) return true
  const message = error instanceof Error
    ? `${error.message} ${String((error as { stderr?: unknown }).stderr ?? '')} ${String((error as { cause?: unknown }).cause ?? '')}`
    : String(error)
  if (/was not found at the configured executablePath/i.test(message)) return true
  const code = (error as { code?: unknown }).code
  if ((code === 'ENOENT' || /ENOENT/i.test(message)) && message.includes(executablePath)) return true
  return false
}

async function launchSandboxed(launcher: PdfBrowserLauncher): Promise<Browser> {
  const executablePath = resolveExecutable()
  const baseOptions = {
    executablePath,
    headless: true,
    env: scrubRendererEnv(),
  } as const
  if (process.env.OPENBOOKS_CHROMIUM_NO_SANDBOX === '1') {
    try {
      return await launcher({ ...baseOptions, args: chromiumArgs(true) })
    } catch (error) {
      if (looksLikeMissingExecutable(error, executablePath)) throw new RendererUnavailableError(executablePath)
      throw error
    }
  }
  try {
    return await launcher({ ...baseOptions, args: chromiumArgs(false) })
  } catch (error) {
    if (looksLikeMissingExecutable(error, executablePath)) throw new RendererUnavailableError(executablePath)
    if (!looksLikeSandboxFailure(error)) throw error
    console.warn(
      '[pdf] Chromium sandbox unavailable (user namespaces blocked by the container runtime?) — ' +
        `retrying with --no-sandbox. Cause: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
    )
    try {
      return await launcher({ ...baseOptions, args: chromiumArgs(true) })
    } catch (retryError) {
      if (looksLikeMissingExecutable(retryError, executablePath)) throw new RendererUnavailableError(executablePath)
      throw retryError
    }
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
