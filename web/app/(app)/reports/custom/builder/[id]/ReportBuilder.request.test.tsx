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
const { ReportBuilder } = await import('./ReportBuilder')

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

async function mount() {
  state.errors = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => { throw new TypeError('offline') }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ReportBuilder
          definition={{ id: 'report-1', kind: 'custom', name: 'Test report', description: null, query: { entity: 'ledger_lines', mode: 'rows', columns: [], filters: null, groupBy: null, sorts: null, limit: 1000 } as never }}
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
