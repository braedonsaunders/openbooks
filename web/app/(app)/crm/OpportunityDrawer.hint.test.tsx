import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// OM-02b: the opportunity drawer's disabled "Create estimate" gave its
// save-first reason ONLY as the button's title tooltip — invisible at rest,
// undescribed to assistive tech, and unfocusable while disabled. While the
// drawer is dirty the reason must be a persistent visible hint next to the
// control, wired through aria-describedby. Same house shape as the documents
// UploadButton (button + hint in an inline-flex span, hint id referenced by
// aria-describedby). When clean there is no hint and the button is enabled.

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/crm?opportunity=1',
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

Object.assign(globalThis, {
  __om02bTestRouter: {
    push() {},
    refresh() {},
    replace() {},
    back() {},
    prefetch() {},
  },
})
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return globalThis.__om02bTestRouter}export function usePathname(){return "/crm"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default function Link(p){return globalThis.React.createElement("a",{href:typeof p.href==="string"?p.href:p.href?.toString()},p.children)}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(){},error(){},info(){}};export function Toaster(){return null}',
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
const messages = (await import('../../../messages/en')).default
const { OpportunityDrawer } = await import('./OpportunityDrawer')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const baseOpportunity = {
  id: 'opp-1',
  title: 'Atlas rollout',
  party_id: 'acct-1',
  primary_contact_id: null,
  owner_user_id: null,
  sales_team_id: null,
  status_id: 'st-1',
  lead_source_id: null,
  expected_close_date: null,
  forecast_category: 'most_likely',
  probability: 50,
  currency: 'USD',
  next_step: null,
  description: null,
  win_loss_reason: null,
  opportunity_number: 'OPP-00002',
  status_name: 'qualification',
  updated_at: '2026-09-23T00:00:00Z',
}

function mountDrawer(t: TestContext) {
  const rootHandle = createRoot(document.body)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    for (const node of [...document.body.children]) node.remove()
  })
  return act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <OpportunityDrawer
          data={{ opportunity: { ...baseOpportunity }, lines: [] }}
          statuses={[{ id: 'st-1', name: 'qualification' }]}
          accounts={[{ id: 'acct-1', name: 'Atlas' }]}
          contacts={[]}
          owners={[]}
          teams={[]}
          sources={[]}
          items={[]}
          currencies={[]}
          closeHref="/crm"
          canManage
        />
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
}

function estimateButton(): HTMLButtonElement {
  const buttons = [...document.querySelectorAll('button')]
  const found = buttons.find((b) => /create estimate/i.test(b.textContent ?? ''))
  assert.ok(found, 'the Create estimate button must render')
  return found as HTMLButtonElement
}

async function editTitle() {
  // The title field is the drawer's first text input; a harmless unsaved edit
  // makes the drawer dirty, which is the OM-02b precondition.
  const input = document.querySelector('input:not([type="number"]):not([type="date"]):not([type="hidden"])') as HTMLInputElement | null
  assert.ok(input, 'the title input must render')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, 'Atlas rollout (edited)')
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await tick()
  })
}

test('clean drawer shows no hint and an enabled estimate button', async (t) => {
  await mountDrawer(t)
  const button = estimateButton()
  assert.equal(button.disabled, false, 'a saved opportunity keeps conversion enabled')
  assert.equal(button.getAttribute('aria-describedby'), null, 'no reason is needed when conversion works')
  assert.equal(document.getElementById('opportunity-estimate-hint'), null, 'no hint when the drawer is clean')
})

test('dirty drawer shows a visible save-first hint described by the disabled button', async (t) => {
  await mountDrawer(t)
  await editTitle()
  const button = estimateButton()
  assert.equal(button.disabled, true, 'conversion stays disabled until save')
  assert.equal(
    button.getAttribute('aria-describedby'),
    'opportunity-estimate-hint',
    'the disabled button must describe its reason',
  )
  const hint = document.getElementById('opportunity-estimate-hint')
  assert.ok(hint, 'the save-first reason must be a visible element, not a tooltip')
  assert.match(
    hint.textContent ?? '',
    /Save this opportunity first/,
    'the hint must name the save-first remedy',
  )
  assert.ok((hint.textContent ?? '').length > 0, 'the hint must carry visible text')
})
