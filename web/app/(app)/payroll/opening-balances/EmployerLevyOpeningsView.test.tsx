import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { bootJsdomEnvironment } from '../../../../testing/jsdom-env'
import { stubModules } from '../../../../testing/stub-modules'

// C-9: the employer carry-in section renders one row per pack-declared levy
// with its stored base, and renders nothing when no pack declares a levy
// (the engine refuses undeclared carry-ins, so an empty grid would be a lie).

await bootJsdomEnvironment({ url: 'http://localhost:4800/payroll/opening-balances' })

stubModules({
  navigation: {
    source: 'export function useRouter(){return {refresh(){}}}',
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    sonner: 'export const toast={success(){},error(){},info(){}};export function Toaster(){return null}',
  },
})
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { EmployerLevyOpeningsView } = await import('./EmployerLevyOpeningsView')

async function renderSection(
  t: TestContext,
  props: React.ComponentProps<typeof EmployerLevyOpeningsView>,
): Promise<(props: React.ComponentProps<typeof EmployerLevyOpeningsView>) => Promise<void>> {
  const rootHandle = createRoot(document.body)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    for (const node of [...document.body.children]) node.remove()
  })
  const render = (next: React.ComponentProps<typeof EmployerLevyOpeningsView>) => <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC"><EmployerLevyOpeningsView {...next} /></NextIntlClientProvider>
  await act(async () => rootHandle.render(render(props)))
  return async (next) => act(async () => rootHandle.render(render(next)))
}

function bodyText(): string {
  return document.body.textContent ?? ''
}

const levies = [
  {
    country: 'CA',
    levyKey: 'eht',
    label: 'Employer health tax',
    description: 'Ontario EHT on total remuneration',
    scope: 'region',
  },
]

test('declared levies render with their stored base year-to-date', async (t) => {
  const changeYear = await renderSection(t, {
    year: 2026,
    levies,
    rows: [{ country: 'CA', levyKey: 'eht', region: 'ON', baseYtd: '150000.0000' }],
    canManage: true,
  })
  assert.ok(bodyText().includes('Employer health tax'), 'the levy label renders');
  assert.ok(bodyText().includes('ON'), 'the stored region renders');
  const input = document.querySelector('input[aria-label="Employer health tax base year-to-date, ON"]') as HTMLInputElement | null
  assert.ok(input, 'the base cell is editable');
  await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, '200000'); input.dispatchEvent(new window.Event('input', { bubbles: true })) }); await changeYear({ year: 2027, levies, rows: [{ country: 'CA', levyKey: 'eht', region: 'ON', baseYtd: '160000' }], canManage: true }); assert.equal((document.querySelector('input[aria-label="Employer health tax base year-to-date, ON"]') as HTMLInputElement).value, '160000', 'the prior year edit is not reused in this year')
  await act(async () => { const addRegion = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Add a region')); assert.ok(addRegion); addRegion.click() });
  assert.ok(document.querySelector('input[aria-label="Employer health tax · New region base year-to-date"]'), 'new-row base field names its levy as well as its function');
})

test('no declared levies renders nothing, never an empty grid', async (t) => {
  await renderSection(t, { year: 2026, levies: [], rows: [], canManage: true })
  assert.equal(bodyText(), '');
})
