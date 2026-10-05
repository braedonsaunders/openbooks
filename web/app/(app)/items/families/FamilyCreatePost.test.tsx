import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { bootJsdomEnvironment } from '../../../../testing/jsdom-env'
import { stubModules } from '../../../../testing/stub-modules'

await bootJsdomEnvironment({ url: 'http://localhost/items/families?family=new' })

stubModules({
  navigation: {
    source:
      'export function useRouter() { const q = new URLSearchParams(globalThis.__famQuery ?? ""); return { push(u) { globalThis.__famPushed = String(u) }, replace(u) { globalThis.__famPushed = String(u) }, refresh() {}, back() {} } }' +
      'export function usePathname() { return "/items/families" }' +
      'export function useSearchParams() { return new URLSearchParams(globalThis.__famQuery ?? "") }',
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    'next-intl': 'const t = (key) => key; export function useTranslations() { return t } export function useLocale() { return "en" }',
    sonner:
      'export const toast = { success() {}, error() {} }',
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { MoneyProvider } = await import('../../../../components/money-provider')
const { BusinessDateProvider } = await import('../../../../components/business-date-provider')
const { FamilyDrawer } = await import('./FamilyDrawer.tsx')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

async function clickButton(label: string) {
  const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label)
  assert.ok(button, `button ${label} is rendered`)
  await act(async () => { button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await tick() })
}

test('the create form posts exactly the options shown as chips', async (t: TestContext) => {
  const posted: { url: string; body: string }[] = []
  const priorFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (String(input).includes('/api/item-families') && (init?.method ?? 'GET') === 'POST') {
      posted.push({ url: String(input), body: String(init?.body ?? '') })
      return Response.json({ id: 'fam-new', code: 'FAM' })
    }
    return Response.json({})
  }) as typeof fetch
  t.after(() => { globalThis.fetch = priorFetch })

  const root = createRoot(document.body)
  t.after(async () => {
    await act(async () => root.unmount())
    for (const node of [...document.body.children]) node.remove()
  })
  const tree = () => React.createElement(MoneyProvider as React.ComponentType<{ currency: string }>, { currency: 'USD' }, React.createElement(BusinessDateProvider as React.ComponentType<{ today: string }>, { today: '2026-09-24' }, React.createElement(FamilyDrawer, { familyId: 'new', canManage: true })))
  await act(async () => {
    root.render(tree())
    await tick()
  })

  const inputs = [...document.querySelectorAll('input')] as HTMLInputElement[]
  await act(async () => { typeInto(inputs[0]!, 'ACC-FAM'); await tick() })
  await act(async () => { typeInto(inputs[1]!, 'Acceptance Family'); await tick() })
  // values first, then the option name — mirrors the live acceptance order
  const box = document.querySelector('input[placeholder="options.valuesPlaceholder"]') as HTMLInputElement | null
  assert.ok(box, 'the option-values box is rendered')
  for (const value of ['S', 'M']) {
    await act(async () => {
      box.focus()
      typeInto(box, value)
      box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await tick()
    })
  }
  const chips = [...document.querySelectorAll('button')].filter((b) => (b.getAttribute('aria-label') ?? '') === 'remove').length
  assert.ok(chips >= 2, `chips display (${chips})`)
  const optName = document.querySelector('input[placeholder="options.namePlaceholder"]') as HTMLInputElement | null
  assert.ok(optName, 'the option name is editable')
  await act(async () => { typeInto(optName, 'Size'); await tick() })

  await clickButton('create')
  assert.equal(posted.length, 1, 'one family POST leaves the form')
  const body = JSON.parse(posted[0]!.body)
  assert.deepEqual(body.options?.[0]?.values, ['S', 'M'], 'the POST carries the chipped values')
})
