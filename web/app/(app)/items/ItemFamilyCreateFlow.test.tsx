import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { bootJsdomEnvironment } from '../../../testing/jsdom-env'
import { stubModules } from '../../../testing/stub-modules'

await bootJsdomEnvironment({ url: 'http://localhost/items?item=new' })

stubModules({
  navigation: {
    source:
      'export function useRouter() { return { push() {}, replace() {}, refresh() {}, back() {} } }' +
      'export function usePathname() { return "/items" }' +
      'export function useSearchParams() { return new URLSearchParams("item=new") }',
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
const { MoneyProvider } = await import('../../../components/money-provider')
const { BusinessDateProvider } = await import('../../../components/business-date-provider')
const { ItemFamilyCreateFlow } = await import('./ItemFamilyCreateFlow.tsx')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

async function clickButton(label: string) {
  const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label)
  assert.ok(button, `button ${label} is rendered`)
  await act(async () => { button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await tick() })
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

async function tagValues(values: string[]) {
  const box = document.querySelector('input[placeholder="options.valuesPlaceholder"]') as HTMLInputElement | null
  assert.ok(box, 'the option-values box is rendered')
  for (const value of values) {
    await act(async () => {
      box.focus()
      typeInto(box, value)
      box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await tick()
    })
  }
}

test('going back to the options step restores the drafted matrix', async (t: TestContext) => {
  const root = createRoot(document.body)
  t.after(async () => {
    await act(async () => root.unmount())
    for (const node of [...document.body.children]) node.remove()
  })
  await act(async () => {
    root.render(React.createElement(MoneyProvider as React.ComponentType<{ currency: string }>, { currency: 'USD' }, React.createElement(BusinessDateProvider as React.ComponentType<{ today: string }>, { today: '2026-09-24' }, React.createElement(ItemFamilyCreateFlow, {
      kind: 'inventory',
      canManage: true,
      onBack: () => {},
      onCreated: () => {},
    }))))
    await tick()
  })
  // details -> options
  const name = document.querySelectorAll('input')[0] as HTMLInputElement | undefined
  assert.ok(name, 'the family name is editable')
  await act(async () => { typeInto(name, 'Acceptance Tee'); await tick() })
  await clickButton('continue')
  assert.ok(document.body.textContent?.includes('optionsTitle'), 'the options step follows details')
  // draft the matrix
  const optionName = document.querySelector('input[placeholder="options.namePlaceholder"]') as HTMLInputElement | null
  assert.ok(optionName, 'the option name is editable')
  await act(async () => { typeInto(optionName, 'Size'); await tick() })
  await tagValues(['S', 'M'])
  assert.ok(document.body.textContent?.includes('variantCount'), 'the live variant count is shown')
  // forward to preview and back: the draft must survive
  await clickButton('reviewVariants')
  assert.ok(document.body.textContent?.includes('previewTitle'), 'preview reached')
  await clickButton('actions.back')
  assert.ok(document.body.textContent?.includes('optionsTitle'), 'back returns to options')
  const nameAfter = (document.querySelector('input[placeholder="options.namePlaceholder"]') as HTMLInputElement | null)?.value
  assert.equal(nameAfter, 'Size', 'the option name survives the round trip')
  const chipsAfter = [...document.querySelectorAll('button')].filter((b) => (b.getAttribute('aria-label') ?? '').startsWith('remove')).length
  assert.ok(chipsAfter >= 2, `the drafted values survive the round trip (found ${chipsAfter} chips)`)
  assert.ok(document.body.textContent?.includes('variantCount'), 'the live count survives the round trip')
})
