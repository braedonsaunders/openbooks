import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { bootJsdomEnvironment } from '../../../../testing/jsdom-env'
import { stubModules } from '../../../../testing/stub-modules'

await bootJsdomEnvironment({ url: 'http://localhost/items/families?family=fam-1' })

Object.assign(globalThis, { __familyQuery: 'family?family=fam-1&familyTab=details' })

stubModules({
  navigation: {
    source:
      'export function useRouter() { return { push() {}, replace() {}, refresh() {}, back() {} } }' +
      'export function usePathname() { return "/items/families" }' +
      'export function useSearchParams() { return new URLSearchParams(globalThis.__familyQuery ?? "") }',
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

const detail = {
  id: 'fam-1',
  code: 'FAM-1',
  name: 'Classic Tee',
  description: null,
  category: null,
  kind: 'inventory',
  defaultUnit: 'each',
  defaultRate: '25.0000',
  status: 'active',
  options: [{ id: 'opt-1', name: 'Size', position: 1, values: ['S', 'M'] }],
  variants: [
    {
      id: 'v-1', code: 'FAM-1-S', name: 'Classic Tee S', optionValues: { Size: 'S' },
      kind: 'inventory', unit: 'each', defaultRate: null, defaultCost: null,
      isActive: true, onHand: '4.0000', barcode: null,
    },
  ],
}
const pricing = {
  levels: [], customers: [], currencies: [], baseCurrency: null, schedules: [], inherited: [],
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

function setQuery(query: string) {
  ;(globalThis as Record<string, unknown>).__familyQuery = query
}

function rateInput(): HTMLInputElement {
  const inputs = [...document.querySelectorAll('input[inputmode="decimal"]')] as HTMLInputElement[]
  const found = inputs.find((input) => input.value === '25.0000' || input.getAttribute('aria-label') === null)
  assert.ok(inputs.length > 0, 'a decimal draft field is rendered')
  return found ?? inputs[0]!
}

async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await tick()
  })
}

test('switching family tabs keeps drafts and the same dialog DOM', async (t: TestContext) => {
  const priorFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    if (url.includes('/prices')) return Response.json(pricing)
    if (url.includes('/api/item-families/')) return Response.json(detail)
    return Response.json({})
  }) as typeof fetch
  t.after(() => { globalThis.fetch = priorFetch })

  setQuery('family=fam-1&familyTab=details')
  const root = createRoot(document.body)
  t.after(async () => {
    await act(async () => root.unmount())
    for (const node of [...document.body.children]) node.remove()
  })
  const tree = () => React.createElement(MoneyProvider as React.ComponentType<{ currency: string }>, { currency: 'USD' }, React.createElement(BusinessDateProvider as React.ComponentType<{ today: string }>, { today: '2026-09-24' }, React.createElement(FamilyDrawer, { familyId: 'fam-1', canManage: true })))
  await act(async () => {
    root.render(tree())
    await tick()
    await tick()
  })

  // All four panels stay mounted; only the active one is shown.
  const root_body = document.body.firstChild as HTMLElement
  const sections = [...root_body.querySelectorAll(':scope > section')] as HTMLElement[]
  assert.equal(sections.length, 4, 'every panel stays mounted')
  assert.deepEqual(
    sections.map((section) => section.hidden),
    [true, true, true, false],
    'only the details panel is shown',
  )
  const dialog = document.body.firstChild
  assert.ok(dialog, 'the drawer body is rendered')

  // Draft a defaults change, switch away and back: the draft survives.
  await typeInto(rateInput(), '29.5000')
  setQuery('family=fam-1&familyTab=variants')
  await act(async () => {
    root.render(tree())
    await tick()
  })
  assert.deepEqual(
    [...(document.body.firstChild as HTMLElement).querySelectorAll(':scope > section')].map((section) => (section as HTMLElement).hidden),
    [false, true, true, true],
    'the variants panel is shown after the switch',
  )
  setQuery('family=fam-1&familyTab=details')
  await act(async () => {
    root.render(tree())
    await tick()
  })
  assert.equal(rateInput().value, '29.5000', 'the unsaved draft survives the round trip')
  assert.ok(document.body.firstChild?.isSameNode(dialog), 'the same dialog DOM survives tab switches')
})
