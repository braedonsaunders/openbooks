import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// C-9: the employer carry-in section renders one row per pack-declared levy
// with its stored base, and renders nothing when no pack declares a levy
// (the engine refuses undeclared carry-ins, so an empty grid would be a lie).

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/payroll/opening-balances',
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

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(){},error(){},info(){}};export function Toaster(){return null}',
      }
    }
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return {refresh(){}}}',
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
const { EmployerLevyOpeningsView } = await import('./EmployerLevyOpeningsView')

async function renderSection(
  t: TestContext,
  props: React.ComponentProps<typeof EmployerLevyOpeningsView>,
): Promise<void> {
  const rootHandle = createRoot(document.body)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    for (const node of [...document.body.children]) node.remove()
  })
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <EmployerLevyOpeningsView {...props} />
      </NextIntlClientProvider>,
    )
  })
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
  await renderSection(t, {
    year: 2026,
    levies,
    rows: [{ country: 'CA', levyKey: 'eht', region: 'ON', baseYtd: '150000.0000' }],
    canManage: true,
  })
  assert.ok(bodyText().includes('Employer health tax'), 'the levy label renders');
  assert.ok(bodyText().includes('ON'), 'the stored region renders');
  const input = document.querySelector('input[aria-label="Employer health tax base year-to-date, ON"]') as HTMLInputElement | null
  assert.ok(input, 'the base cell is editable');
  assert.equal(input.value, '150000');
})

test('no declared levies renders nothing, never an empty grid', async (t) => {
  await renderSection(t, { year: 2026, levies: [], rows: [], canManage: true })
  assert.equal(bodyText(), '');
})
