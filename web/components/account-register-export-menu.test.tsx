import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// UX-16b (register half): the account register export menu was the same bare
// `<a href>` shape as ExportMenu — silent on success, an error-body download
// on refusal. It shares the fetch-download-announce helper, so it gets the
// same coverage: completion naming the real file only after the bytes arrive,
// a named 422 refusal, and a generic 500 failure.

// jsdom first: Popover/Button read browser globals at render.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/accounts/11111111-1111-4111-8111-111111111111',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({
    matches: true,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}

declare global {
  var __registerExportToasts: { kind: string; message: string }[] | undefined
}

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__registerExportToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__registerExportToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
      }
    }
    return next(specifier, context)
  },
})

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../messages/en')).default
const { AccountRegisterExportMenu } = await import('./account-register-export-menu')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const script = {
  toasts: [] as Array<{ kind: string; message: string }>,
  exportStatus: 200 as number,
  exportJsonError: null as string | null,
  exportHtmlError: false,
  deferred: null as null | { resolve: (res: Response) => void },
  clickedDownloads: [] as Array<string | undefined>,
  requestedUrls: [] as Array<string>,
}

function buildExportResponse(): Response {
  if (script.exportStatus !== 200) {
    if (script.exportHtmlError) {
      return new Response('<html><body>Bad Gateway</body></html>', {
        status: script.exportStatus,
        headers: { 'Content-Type': 'text/html' },
      })
    }
    return new Response(JSON.stringify({ error: script.exportJsonError ?? 'export failed' }), {
      status: script.exportStatus,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return new Response('date,type\n2026-09-01,journal\n', {
    status: 200,
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="1000-cash-register.csv"',
    },
  })
}

async function mountMenu(t: TestContext): Promise<void> {
  ;(globalThis as Record<string, unknown>).__registerExportToasts = script.toasts
  const priorFetch = globalThis.fetch
  const priorCreateObjectURL = URL.createObjectURL
  const priorRevokeObjectURL = URL.revokeObjectURL
  const priorAnchorClick = window.HTMLAnchorElement.prototype.click
  globalThis.fetch = ((input: unknown) => {
    const url = String(input)
    script.requestedUrls.push(url)
    if (!url.includes('/register?')) throw new Error(`unexpected fetch ${url}`)
    if (script.deferred) return new Promise<Response>((resolve) => script.deferred!.resolve = resolve)
    return Promise.resolve(buildExportResponse())
  }) as typeof fetch
  URL.createObjectURL = (() => 'blob:mock') as typeof URL.createObjectURL
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
  window.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    script.clickedDownloads.push(this.download)
  }
  t.after(() => {
    globalThis.fetch = priorFetch
    URL.createObjectURL = priorCreateObjectURL
    URL.revokeObjectURL = priorRevokeObjectURL
    window.HTMLAnchorElement.prototype.click = priorAnchorClick
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    for (const node of [...document.body.querySelectorAll('[data-ui-overlay]')]) node.remove()
  })
  script.toasts.length = 0
  script.clickedDownloads.length = 0
  script.requestedUrls.length = 0
  script.exportStatus = 200
  script.exportJsonError = null
  script.exportHtmlError = false
  script.deferred = null
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <AccountRegisterExportMenu accountId="11111111-1111-4111-8111-111111111111" from="2026-09-01" to="2026-09-30" />
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
}

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll('button')].filter(
    (b) => (b.textContent ?? '').trim() === name,
  ) as HTMLButtonElement[]
}

async function openMenu(): Promise<void> {
  const trigger = document.querySelector('button[aria-label="Export"]') as HTMLButtonElement | null
  assert.ok(trigger, 'the Export trigger must render')
  await act(async () => {
    trigger.click()
    await tick()
    await tick()
  })
  assert.ok(buttonsNamed('CSV').length >= 1, 'the CSV menu item must render')
}

async function clickCsv(): Promise<void> {
  const items = buttonsNamed('CSV')
  assert.ok(items.length >= 1, 'the CSV menu item must render')
  await act(async () => {
    items[items.length - 1]!.click()
    await tick()
  })
}

test('CSV success downloads the server file and announces it only after the bytes arrive', async (t) => {
  await mountMenu(t)
  script.deferred = { resolve: () => {} }
  await openMenu()
  await clickCsv()
  await tick()
  // While the fetch is in flight the item shows a busy state and nothing is
  // claimed: no download, no toast, no live-region status.
  assert.match(document.body.textContent ?? '', /Exporting CSV/, 'the menu item must show a busy state')
  assert.equal(script.clickedDownloads.length, 0, 'no download before the bytes arrive')
  assert.equal(script.toasts.length, 0, 'no toast before the bytes arrive')
  assert.equal(document.querySelector('[role="status"]'), null, 'no status before the bytes arrive')
  // The bytes arrive: the download fires with the server filename and
  // completion names it in both the toast and the live region.
  await act(async () => {
    script.deferred!.resolve(buildExportResponse())
    await tick()
    await tick()
  })
  await tick()
  assert.deepEqual(script.clickedDownloads, ['1000-cash-register.csv'], 'the real file must download')
  assert.ok(
    script.requestedUrls.some((url) => url.includes('/api/accounts/11111111-1111-4111-8111-111111111111/register?')),
    'the register endpoint must be fetched, not navigated to',
  )
  const status = document.querySelector('[role="status"]')
  assert.ok(status, 'completion must render a live-region status, not just a toast')
  assert.match(status.textContent ?? '', /1000-cash-register\.csv/, 'completion must name the actual filename')
  assert.ok(
    script.toasts.some((toast) => toast.kind === 'success' && /1000-cash-register\.csv/.test(toast.message)),
    'completion must toast the actual filename',
  )
})

test('a 422 JSON refusal shows its named message and downloads nothing', async (t) => {
  await mountMenu(t)
  script.exportStatus = 422
  script.exportJsonError = 'export_too_large'
  await openMenu()
  await clickCsv()
  await act(async () => {
    await tick()
    await tick()
  })
  await tick()
  assert.deepEqual(script.clickedDownloads, [], 'a refusal must download nothing')
  assert.equal(document.querySelector('[role="status"]'), null, 'a refusal must not render completion')
  assert.ok(
    script.toasts.some((toast) => toast.kind === 'error' && /export_too_large/.test(toast.message)),
    'a refusal must surface the server message by name',
  )
})

test('a 500 shows the generic failure naming the format', async (t) => {
  await mountMenu(t)
  script.exportStatus = 500
  script.exportHtmlError = true
  await openMenu()
  await clickCsv()
  await act(async () => {
    await tick()
    await tick()
  })
  await tick()
  assert.deepEqual(script.clickedDownloads, [], 'a failure must download nothing')
  assert.equal(document.querySelector('[role="status"]'), null, 'a failure must not render completion')
  assert.ok(
    script.toasts.some((toast) => toast.kind === 'error' && /Could not export CSV/.test(toast.message)),
    'a non-JSON failure must name the format in a generic message',
  )
})
