import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// UX-16 (export half): the data export must announce completion tied to the
// actual file (real filename, real column count) and must name its disabled
// reasons instead of sitting silent.

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/data/export',
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

const script = {
  toasts: [] as Array<{ kind: string; message: string }>,
  exportStatus: 200,
  clickedDownloads: [] as Array<string | undefined>,
}
Object.assign(globalThis, {
  __exportTestToasts: script.toasts,
})
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(m){globalThis.__exportTestToasts.push({kind:"success",message:String(m)})},error(m){globalThis.__exportTestToasts.push({kind:"error",message:String(m)})},info(m){globalThis.__exportTestToasts.push({kind:"info",message:String(m)})}};export function Toaster(){return null}',
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
const messages = (await import('../../../../messages/en')).default
const { ExportClient } = await import('./ExportClient')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

async function mountExport(t: TestContext): Promise<void> {
  const priorFetch = globalThis.fetch
  const priorCreateObjectURL = URL.createObjectURL
  const priorAnchorClick = window.HTMLAnchorElement.prototype.click
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    const url = String(input)
    if (url === '/api/data/resources' && (init?.method ?? 'GET') === 'GET') {
      return Response.json({
        resources: [{ key: 'invoices', label: 'Invoices', group: 'Sales', iconKey: 'file' }],
      })
    }
    if (url.startsWith('/api/data/resources?key=')) {
      return Response.json({
        columns: [
          { key: 'id', label: 'ID' },
          { key: 'total', label: 'Total' },
        ],
      })
    }
    if (url === '/api/data/export') {
      if (script.exportStatus !== 200) {
        return new Response(JSON.stringify({ error: 'export failed' }), {
          status: script.exportStatus,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('id,total\n1,2\n', {
        status: 200,
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="invoices.csv"',
        },
      })
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
  URL.createObjectURL = (() => 'blob:mock') as typeof URL.createObjectURL
  window.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    script.clickedDownloads.push(this.download)
  }
  t.after(() => {
    globalThis.fetch = priorFetch
    URL.createObjectURL = priorCreateObjectURL
    window.HTMLAnchorElement.prototype.click = priorAnchorClick
  })
  const rootHandle = createRoot(document.body)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    for (const node of [...document.body.children]) node.remove()
  })
  script.toasts.length = 0
  script.clickedDownloads.length = 0
  script.exportStatus = 200
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ExportClient />
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
}

function exportButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find((b) =>
    /^(Export|Exporting)/.test((b.textContent ?? '').trim()),
  ) as HTMLButtonElement | undefined
  assert.ok(button, 'the Export button must render')
  return button
}

async function chooseResource(): Promise<void> {
  const select = document.querySelector('select') as HTMLSelectElement | null
  assert.ok(select, 'the resource picker must render')
  await act(async () => {
    select.value = 'invoices'
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
    await tick()
    await tick()
  })
  await tick()
}

test('no resource names its disabled reason accessibly', async (t) => {
  await mountExport(t)
  const button = exportButton()
  assert.equal(button.disabled, true, 'Export without a resource stays disabled')
  assert.equal(button.getAttribute('aria-describedby'), 'data-export-hint', 'the reason must be described')
  const hint = document.getElementById('data-export-hint')
  assert.ok(hint, 'the reason must be visible, not silent')
  assert.match(hint.textContent ?? '', /Pick what to export/, 'the reason must name the missing choice')
})

test('no columns names its disabled reason', async (t) => {
  await mountExport(t)
  await chooseResource()
  // Clear all columns: the button must say why it is disabled.
  const clear = [...document.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === 'Clear all',
  ) as HTMLButtonElement | undefined
  assert.ok(clear, 'the clear-all control must render')
  await act(async () => {
    clear.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
  })
  await tick()
  const button = exportButton()
  assert.equal(button.disabled, true, 'Export without columns stays disabled')
  assert.match(
    document.getElementById('data-export-hint')?.textContent ?? '',
    /at least one column/,
    'the reason must name the missing columns',
  )
})

test('completion names the actual file and column count', async (t) => {
  await mountExport(t)
  await chooseResource()
  const button = exportButton()
  assert.equal(button.disabled, false, 'a resourced, columned export must enable')
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
    await tick()
  })
  await tick()
  assert.deepEqual(script.clickedDownloads, ['invoices.csv'], 'the real file must download')
  const status = document.querySelector('[role="status"]')
  assert.ok(status, 'completion must render a status, not just a toast')
  assert.match(status.textContent ?? '', /invoices\.csv/, 'completion must name the actual filename')
  assert.match(status.textContent ?? '', /2 columns/, 'completion must name the real column count')
})

test('a failed export claims no completion', async (t) => {
  await mountExport(t)
  script.exportStatus = 500
  await chooseResource()
  await act(async () => {
    exportButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
    await tick()
  })
  await tick()
  assert.equal(document.querySelector('[role="status"]'), null, 'failure must not render completion')
  assert.deepEqual(script.clickedDownloads, [], 'failure must download nothing')
  assert.ok(
    script.toasts.some((toast) => toast.kind === 'error'),
    'failure must surface as an error toast',
  )
})
