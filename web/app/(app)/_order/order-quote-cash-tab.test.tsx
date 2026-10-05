import assert from 'node:assert/strict'
import test from 'node:test'
import '../dashboard/_dashboard-render-harness'
import {
  act,
  buttonsNamed,
  click,
  mountDashboard,
  scriptFetch,
  tick,
} from '../dashboard/_dashboard-render-harness'
import type { OrderPayload } from './OrderDrawer'

// Await-imports (not static imports): module hooks register while the
// harness above evaluates, so only imports that resolve after that point see
// the jsdom shims.
const { OrderDrawer } = await import('./OrderDrawer')
const messages = (await import('../../../messages/en')).default as Record<string, unknown>

const QUOTE_ID = '77777777-7777-4777-8777-777777777777'

function quoteOrder(status = 'approved'): OrderPayload {
  return {
    doc: {
      id: QUOTE_ID,
      currency: 'USD',
      subsidiary_id: null,
      project_id: null,
      department_id: null,
      memo: null,
      due_date: null,
      document_date: '2026-08-01',
      updated_at: '2026-08-01T12:00:00.123456Z',
      subtotal: '100.00',
      tax_total: '0',
      total: '100.00',
      party_id: 'customer-1',
      party_name: 'Acme Corp',
      document_number: 'Q-1001',
      extra_dims: {},
      status,
    },
    lines: [],
    links: [],
  } as unknown as OrderPayload
}

async function mountQuote(quoteToCashEnabled?: boolean) {
  return mountDashboard(
    <OrderDrawer
      order={quoteOrder()}
      kind="quote"
      parties={[{ id: 'customer-1', display_name: 'Acme Corp' }]}
      accounts={[]}
      items={[]}
      stockLocations={[]}
      taxCodes={[]}
      taxGroups={[]}
      departments={[]}
      projects={[]}
      subsidiaries={[]}
      segments={[]}
      canManage
      closeHref="/estimates"
      quoteToCashEnabled={quoteToCashEnabled}
    />,
    messages,
  )
}

test('the quote Subscription tab stays hidden while quoteToCash is off', async (t) => {
  const restoreFetch = scriptFetch(() => null)
  t.after(restoreFetch)
  const { unmount } = await mountQuote(false)
  t.after(unmount)
  assert.equal(
    buttonsNamed('Subscription').length,
    0,
    'no Subscription tab may render when the quoteToCash feature is off',
  )
})

test('the quote Subscription tab renders once quoteToCash resolves on', async (t) => {
  const restoreFetch = scriptFetch(() => null)
  t.after(restoreFetch)
  const { unmount } = await mountQuote(true)
  t.after(unmount)
  assert.equal(
    buttonsNamed('Subscription').length,
    1,
    'the Subscription tab must render when the quoteToCash feature is on',
  )
})

function termFixture(id: string, planName: string, amount: string) {
  return {
    term: {
      id,
      quoteLineId: 'line-1',
      planId: 'plan-1',
      planName,
      termMonths: 12,
      startRule: 'quote_date',
      billingTiming: 'advance',
      steps: [],
    },
    schedule: {
      periods: [{ periodIndex: 0, unitPrice: amount, quantity: '1', periodAmount: amount, arr: amount }],
      tcv: amount,
    },
    listTcv: amount,
    floorBreaches: [],
  }
}

function twoTermPreview() {
  return {
    quote: { id: QUOTE_ID, documentNumber: 'Q-1001', status: 'draft', currency: 'USD' },
    terms: [termFixture('term-a', 'Alpha plan', '110.00'), termFixture('term-b', 'Beta plan', '220.00')],
    tcv: '330.00',
    listTcv: '330.00',
    discountPct: '0.00',
    floorBreached: false,
    signature: null,
    settings: { maxDiscountPercent: '10', autoActivateOnSign: false },
    advancedSubscriptions: false,
    revenueContracts: false,
  }
}

function termStrip(): HTMLElement {
  const strip = document.querySelector("nav[aria-label='Subscription lines']")
  assert.ok(strip, 'a multi-term quote must offer the term selector strip')
  return strip as HTMLElement
}

function termTab(planName: string): HTMLButtonElement {
  const tab = [...termStrip().querySelectorAll('button')].find((button) =>
    button.textContent?.includes(planName),
  )
  assert.ok(tab, `the term strip must offer ${planName}`)
  return tab as HTMLButtonElement
}

function monthsInput(): HTMLInputElement {
  const label = [...document.querySelectorAll('label')].find((element) =>
    element.textContent?.includes('Term (months)'),
  )
  const input = label?.querySelector('input')
  assert.ok(input, 'the editing draft must keep its term-months field')
  return input as HTMLInputElement
}

/**
 * Multi-term quotes focus one term behind the shared strip: only the
 * selected term's schedule renders, and an in-flight editing draft
 * survives switching terms with its values intact.
 */
test('a multi-term quote focuses one term schedule and keeps the editing draft', async (t) => {
  const restoreFetch = scriptFetch((url) =>
    url.includes(`/api/estimates/${QUOTE_ID}/terms`) ? Response.json(twoTermPreview()) : null,
  )
  t.after(restoreFetch)
  const { unmount } = await mountDashboard(
    <OrderDrawer
      order={quoteOrder('draft')}
      kind="quote"
      parties={[{ id: 'customer-1', display_name: 'Acme Corp' }]}
      accounts={[]}
      items={[]}
      stockLocations={[]}
      taxCodes={[]}
      taxGroups={[]}
      departments={[]}
      projects={[]}
      subsidiaries={[]}
      segments={[]}
      canManage
      closeHref="/estimates"
      quoteToCashEnabled
    />,
    messages,
  )
  t.after(unmount)

  const subscriptionTab = buttonsNamed('Subscription')[0]
  assert.ok(subscriptionTab, 'the Subscription tab must render before terms load')
  await click(subscriptionTab)
  await tick()
  await tick()

  // Amounts, not plan names: the strip tabs name both terms, while each
  // schedule amount renders only inside the focused term card.
  assert.ok(termTab('Alpha plan'), 'the strip names the first term')
  assert.ok(termTab('Beta plan'), 'the strip names the second term')
  assert.match(document.body.textContent ?? '', /\$110\.00/, 'the first term focuses by default')
  assert.doesNotMatch(
    document.body.textContent ?? '',
    /\$220\.00/,
    'the sibling schedule renders no amount beside the focus',
  )

  await click(termTab('Beta plan'))
  assert.match(document.body.textContent ?? '', /\$220\.00/, 'selecting focuses the second schedule')
  assert.doesNotMatch(
    document.body.textContent ?? '',
    /\$110\.00/,
    'the first schedule leaves with its selection',
  )

  await click(termTab('Alpha plan'))
  // Scoped to the section: the drawer chrome carries its own exact Edit
  // buttons, while only the focused term card offers editing in context.
  const sectionRoot = termStrip().closest('div.space-y-4')
  assert.ok(sectionRoot, 'the terms must render inside their section')
  const editButton = [...sectionRoot.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Edit',
  )
  assert.ok(editButton, 'the focused term must offer editing in context')
  await click(editButton as HTMLButtonElement)
  assert.equal(buttonsNamed('Save term').length, 1, 'editing opens its draft panel')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    assert.ok(setter, 'the months field must accept typed input')
    setter.call(monthsInput(), '24')
    monthsInput().dispatchEvent(new window.Event('input', { bubbles: true }))
    await tick()
  })
  assert.equal(monthsInput().value, '24', 'the draft records the typed months')

  await click(termTab('Beta plan'))
  assert.equal(buttonsNamed('Save term').length, 1, 'the draft panel survives switching terms')
  assert.equal(monthsInput().value, '24', 'the draft keeps its values through the switch')
  assert.match(
    document.body.textContent ?? '',
    /\$220\.00/,
    'switching still refocuses the schedule beside the draft',
  )
  const hiddenSave = buttonsNamed('Save term')[0]?.closest('div[hidden]')
  assert.ok(hiddenSave, 'the Alpha editor hides while Beta is selected')
  assert.equal(
    buttonsNamed('Send for signature').length,
    1,
    'the send action stays available beside terms and draft',
  )

  await click(termTab('Alpha plan'))
  assert.equal(monthsInput().value, '24', 'returning restores the same draft values')
  assert.equal(
    buttonsNamed('Save term')[0]?.closest('div[hidden]') ?? null,
    null,
    'returning to Alpha restores its editor visibly',
  )
  assert.doesNotMatch(
    document.body.textContent ?? '',
    /\$110\.00/,
    'the editing term shows its editor instead of its schedule',
  )
})
