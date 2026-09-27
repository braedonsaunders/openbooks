import assert from 'node:assert/strict'
import test from 'node:test'

const { bootJsdomEnvironment } = await import('../../../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/reports/custom/builder/report-1', matchMediaMatches: false })
if (!window.HTMLElement.prototype.getBoundingClientRect) {
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} })
}

const state = { errors: [] as string[], confirm: true }
Object.assign(globalThis, { __reportBuilderRequestTest: state })
const { stubModules } = await import('../../../../../../testing/stub-modules')
stubModules({
  navigation:
    "export function useRouter(){return {push(){},replace(){},refresh(){}}}export function usePathname(){return '/reports/custom/builder/report-1'}export function useSearchParams(){return new URLSearchParams()}",
  intl: false,
  authz: false,
  features: false,
  extra: {
    'next/link':
      'export default function Link(p){const{children,...rest}=p;return globalThis.React.createElement("a",rest,children)}',
    sonner:
      "export const toast={success(){},error(m){globalThis.__reportBuilderRequestTest.errors.push(String(m))}}",
    '../../../../../../lib/confirm':
      'export async function confirmDialog(){return globalThis.__reportBuilderRequestTest.confirm}',
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../../../messages/en')).default
const { BUILT_IN_REPORT_DEFINITIONS } = await import('@openbooks/reports')
const { ReportBuilder } = await import('./ReportBuilder')

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

async function mount(options: { query?: unknown; fetchImpl?: typeof fetch } = {}) {
  state.errors = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = options.fetchImpl ?? (async () => { throw new TypeError('offline') }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ReportBuilder
          definition={{ id: 'report-1', kind: 'custom', name: 'Test report', description: null, query: (options.query ?? { entity: 'ledger_lines', mode: 'rows', columns: [], filters: null, groupBy: null, sorts: null, limit: 1000 }) as never }}
          company="Acme"
          inventoryEnabled={false}
        />
      </NextIntlClientProvider>,
    )
    await tick(100)
  })
  await act(async () => { await tick(100) })
  return {
    host,
    cleanup: async () => {
      globalThis.fetch = originalFetch
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

async function changeValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set?.call(element, value)
    element.dispatchEvent(new window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    await tick()
  })
}

function queryPayload(body: string) {
  return JSON.parse(body) as { query: { measures: Array<Record<string, unknown>> } }
}

function summarize(entity: string, measures: unknown[]) {
  return { entity, mode: 'summarize', columns: [], breakouts: [], measures, filters: null, groupBy: null, sorts: null, limit: 1000 }
}

test('preview transport failure releases busy state and renders its translated error', async (t) => {
  const ui = await mount()
  t.after(ui.cleanup)

  const refresh = [...ui.host.querySelectorAll('button')].find((button) => button.textContent?.includes('Refresh'))
  assert.ok(refresh)
  assert.equal((refresh as HTMLButtonElement).disabled, false, 'preview settles after the automatic request fails')
  assert.ok(ui.host.textContent?.includes('Preview failed'), 'the preview refusal is visible to the operator')
})

test('delete transport failure releases busy state and surfaces a translated error', async (t) => {
  const ui = await mount()
  t.after(ui.cleanup)

  const remove = [...ui.host.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Delete') as HTMLButtonElement | undefined
  assert.ok(remove)
  await act(async () => {
    remove.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick(100)
  })

  assert.equal(remove.disabled, false, 'delete settles after transport failure')
  assert.ok(state.errors.includes('Could not delete report'), 'the failure is surfaced through the translated error')
})

test('changing an aggregate keeps its key, label, and measure filter', async (t) => {
  const plans: Array<{ query: { measures: Array<Record<string, unknown>> } }> = []
  const ui = await mount({ query: summarize('ledger_lines', [{ fn: 'sum', column: 'debit', key: 'debits', label: 'Debits', filter: { combinator: 'and', rules: [{ field: 'entry_status', op: 'eq', value: 'posted' }] } }]), fetchImpl: (async (_input, init) => {
    plans.push(queryPayload(String(init?.body)))
    return Response.json({ error: 'preview refused' }, { status: 422 })
  }) as typeof fetch })
  t.after(ui.cleanup)
  await act(async () => ui.host.querySelectorAll('button').forEach((button) => { if (button.textContent?.includes('Columns')) button.click() }))
  const fn = [...ui.host.querySelectorAll('select')].find((select) => select.value === 'sum')!
  await changeValue(fn, 'count')
  await act(async () => { await tick(550) })
  const measure = plans.at(-1)!.query.measures[0]!
  assert.deepEqual({ key: measure.key, label: measure.label, filter: measure.filter }, { key: 'debits', label: 'Debits', filter: { combinator: 'and', rules: [{ field: 'entry_status', op: 'eq', value: 'posted' }] } })
})

test('formula authoring saves stable references and places the server refusal in the measures panel', async (t) => {
  const previews: Array<{ query: { measures: Array<Record<string, unknown>> } }> = []
  const saves: Array<{ query: { measures: Array<Record<string, unknown>> } }> = []
  const ui = await mount({ query: summarize('ledger_lines', [{ fn: 'sum', column: 'debit', label: 'Revenue' }, { fn: 'sum', column: 'credit', label: 'Cost' }]), fetchImpl: (async (input, init) => {
    if (String(input) === '/api/reports/run') { previews.push(queryPayload(String(init?.body))); return Response.json({ error: "Formula measure 'm3' references unknown measure 'missing'" }, { status: 422 }) }
    if (String(input).endsWith('/report-1') && !init?.method) return Response.json({ definition: { updated_at: '2026-09-01T00:00:00Z' } })
    if (init?.method === 'PATCH') { saves.push(queryPayload(String(init.body))); return Response.json({ definition: { updated_at: '2026-09-02T00:00:00Z' } }) }
    throw new Error(`unexpected request ${String(input)}`)
  }) as typeof fetch })
  t.after(ui.cleanup)
  await act(async () => ui.host.querySelectorAll('button').forEach((button) => { if (button.textContent?.includes('Columns')) button.click() }))
  await act(async () => ui.host.querySelectorAll('button').forEach((button) => { if (button.textContent?.includes('Add formula')) button.click() }))
  await changeValue(ui.host.querySelectorAll('input[aria-label="Measure label"]')[2]! as HTMLInputElement, 'Margin')
  await act(async () => { await tick(850) })
  const measures = saves.at(-1)!.query.measures
  assert.deepEqual(measures.map((measure) => measure.key), ['m1', 'm2', 'm3'])
  assert.deepEqual(measures[2], { fn: 'formula', key: 'm3', label: 'Margin', expr: { op: '/', left: { ref: 'm1' }, right: { ref: 'm2' } }, format: 'ratio' })
  assert.ok(previews.length && ui.host.querySelector('[role="alert"]')?.textContent?.includes("references unknown measure 'missing'"))
})

test('opening and closing follow time keys, and measure controls stop at the exported limits', async (t) => {
  const temporal = await mount({ query: summarize('documents', [{ fn: 'count', key: 'm1' }]) })
  t.after(temporal.cleanup)
  await act(async () => temporal.host.querySelectorAll('button').forEach((button) => { if (button.textContent?.includes('Columns')) button.click() }))
  const temporalSelect = [...temporal.host.querySelectorAll('select')].find((select) => select.value === 'count')!
  assert.ok([...temporalSelect.options].some((option) => option.value === 'opening') && [...temporalSelect.options].some((option) => option.value === 'closing'))
  const ledger = await mount({ query: summarize('ledger_lines', [{ fn: 'count', key: 'm1' }]) })
  t.after(ledger.cleanup)
  await act(async () => ledger.host.querySelectorAll('button').forEach((button) => { if (button.textContent?.includes('Columns')) button.click() }))
  const ledgerSelect = [...ledger.host.querySelectorAll('select')].find((select) => select.value === 'count')!
  assert.ok(![...ledgerSelect.options].some((option) => option.value === 'opening' || option.value === 'closing'))
  const full = await mount({ query: summarize('ledger_lines', [...Array.from({ length: 8 }, (_, i) => ({ fn: 'count', key: `m${i}` })), ...Array.from({ length: 8 }, (_, i) => ({ fn: 'formula', key: `f${i}`, label: `F${i}`, expr: { const: '0' }, format: 'number' }))]) })
  t.after(full.cleanup)
  await act(async () => full.host.querySelectorAll('button').forEach((button) => { if (button.textContent?.includes('Columns')) button.click() }))
  assert.ok(![...full.host.querySelectorAll('button')].some((button) => /Add formula|Add measure/.test(button.textContent ?? '')))
})

test('a nested built-in formula remains unchanged in the saved query', async (t) => {
  const query = BUILT_IN_REPORT_DEFINITIONS.find((report) => report.slug === 'arpa-ltv')!.query
  const expected = structuredClone(query.measures)
  const saved: { payload?: { query: { measures: unknown[] } } } = {}
  const ui = await mount({ query, fetchImpl: (async (input, init) => {
    if (String(input) === '/api/reports/run') return Response.json({ error: 'preview unavailable' }, { status: 422 })
    if (!init?.method) return Response.json({ definition: { updated_at: '2026-09-01T00:00:00Z' } })
    saved.payload = JSON.parse(String(init.body)) as { query: { measures: unknown[] } }
    return Response.json({ definition: { updated_at: '2026-09-02T00:00:00Z' } })
  }) as typeof fetch })
  t.after(ui.cleanup)
  await changeValue(ui.host.querySelector('input')!, 'Cloned report')
  await act(async () => { await tick(850) })
  assert.deepEqual(saved.payload?.query.measures, expected)
})
