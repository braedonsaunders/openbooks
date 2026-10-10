import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

// The void-reversal confirmation always shows the entry's date beside the
// reversal date with both fiscal years, so a prior-period void can never
// slip into the wrong year unseen. The date arrives prefilled with the
// server suggestion (the entry's date, or the first open period after a
// closed entry period, with its notice) and the operator may change it; an
// adjustment-period override keeps its second choice when the org uses
// adjustment periods. These tests mount the real PromptRoot under jsdom
// with scripted fetches.
await bootJsdomEnvironment({ url: "http://localhost:4800/journal", matchMediaMatches: false });

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../messages/en')).default
const { PromptRoot } = await import('./prompt')
const { promptVoidReversalPeriod } = await import('./void-reversal-period')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const COPY = {
  title: 'Reverse into which period?',
  dateLabel: 'Reversal date',
  summaryOriginal: 'Original entry',
  summaryReversal: 'Reversal',
  fiscalYear: 'FY',
  fallbackNotice: 'The original period is closed, so the reversal defaults to the first open period after it.',
  closedNotice: 'No open period follows the original. Generate a later period or reopen one before voiding.',
  label: 'Reversal period',
  regularOption: 'Regular period (default)',
  confirm: 'Void',
  cancel: 'Cancel',
}

const SUGGESTION = {
  originalDate: '2025-10-31',
  suggestedDate: '2025-10-31',
  fallbackToOpenPeriod: false,
  originalFiscalYear: 2026,
  originalPeriodName: '2025-10',
  suggestedFiscalYear: 2026,
  suggestedPeriodName: '2025-10',
  suggestedOpen: true,
}

async function mountPromptRoot(t: TestContext): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const rootHandle = createRoot(host)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    host.remove()
    for (const node of [...document.body.children]) node.remove()
  })
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <PromptRoot />
      </NextIntlClientProvider>,
    )
    await tick()
  })
}

function scriptFetch(t: TestContext, handler: (url: string) => Response): void {
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => handler(String(input))) as typeof fetch
  t.after(() => {
    globalThis.fetch = prior
  })
}

function dialog(): HTMLElement | null {
  return document.querySelector('[role="dialog"]')
}

function dialogText(): string {
  return (dialog()?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function dateInput(): HTMLInputElement | null {
  return document.querySelector('input#prompt-input') as HTMLInputElement | null
}

async function submitDate(value: string): Promise<void> {
  const input = dateInput()
  assert.ok(input, 'the reversal confirmation must render a date input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await tick()
  })
  const form = input.closest('form')
  assert.ok(form, 'the date must live in a form')
  await act(async () => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    await tick()
  })
}

async function chooseOption(value: string): Promise<void> {
  const select = document.querySelector('select#prompt-input') as HTMLSelectElement | null
  assert.ok(select, 'the period choice must render a select')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(select, value)
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
    await tick()
  })
  const form = select.closest('form')
  assert.ok(form, 'the choice must live in a form')
  await act(async () => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    await tick()
  })
}

async function clickCancel(): Promise<void> {
  const buttons = [...document.querySelectorAll('[role="dialog"] button')]
  const cancel = buttons.find((b) => (b.textContent ?? '').trim() === COPY.cancel)
  assert.ok(cancel, 'the choice must offer cancel')
  await act(async () => {
    ;(cancel as HTMLButtonElement).click()
    await tick()
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    await tick()
    await tick()
  })
}

test('the confirmation shows both dates with fiscal years and keeps the suggestion', async (t) => {
  await mountPromptRoot(t)
  scriptFetch(t, (url) => {
    assert.match(url, /\/api\/documents\/.+\/void/)
    return Response.json({ adjustmentPeriods: [], ...SUGGESTION })
  })
  const pending = promptVoidReversalPeriod('doc-1', COPY)
  await settle()
  assert.ok(dialog(), 'the date confirmation always shows, even with no adjustment periods')
  assert.ok(dialogText().includes('Original entry: 2025-10-31 (FY 2026)'), 'the entry date and fiscal year show')
  assert.ok(dialogText().includes('Reversal: 2025-10-31 (FY 2026)'), 'the suggested date and fiscal year show')
  assert.equal(dateInput()?.value, '2025-10-31', 'the input arrives prefilled with the suggestion')
  await submitDate('2025-10-31')
  assert.deepEqual(await pending, { cancelled: false, reversalDate: '2025-10-31', reversalPeriodId: null })
})

test('a closed entry period names the fallback in the confirmation', async (t) => {
  await mountPromptRoot(t)
  scriptFetch(t, () => Response.json({
    adjustmentPeriods: [],
    ...SUGGESTION,
    suggestedDate: '2025-11-01',
    fallbackToOpenPeriod: true,
    suggestedFiscalYear: 2026,
    suggestedPeriodName: '2025-11',
  }))
  const pending = promptVoidReversalPeriod('doc-1', COPY)
  await settle()
  assert.ok(dialogText().includes(COPY.fallbackNotice), 'the fallback notice is explicit')
  assert.ok(dialogText().includes('Reversal: 2025-11-01 (FY 2026)'), 'the moved default shows')
  await submitDate('2025-11-01')
  assert.deepEqual(await pending, { cancelled: false, reversalDate: '2025-11-01', reversalPeriodId: null })
})

test('no open period after the entry warns instead of silently defaulting', async (t) => {
  await mountPromptRoot(t)
  scriptFetch(t, () => Response.json({
    adjustmentPeriods: [],
    ...SUGGESTION,
    suggestedOpen: false,
  }))
  const pending = promptVoidReversalPeriod('doc-1', COPY)
  await settle()
  assert.ok(dialogText().includes(COPY.closedNotice), 'the closed warning is explicit')
  await submitDate('2025-10-31')
  assert.deepEqual(await pending, { cancelled: false, reversalDate: '2025-10-31', reversalPeriodId: null })
})

test('the operator may pick another reversal date', async (t) => {
  await mountPromptRoot(t)
  scriptFetch(t, () => Response.json({ adjustmentPeriods: [], ...SUGGESTION }))
  const pending = promptVoidReversalPeriod('doc-1', COPY)
  await settle()
  await submitDate('2025-11-15')
  assert.deepEqual(await pending, { cancelled: false, reversalDate: '2025-11-15', reversalPeriodId: null })
})

test('a non-date is re-prompted instead of sent to the server', async (t) => {
  await mountPromptRoot(t)
  scriptFetch(t, () => Response.json({ adjustmentPeriods: [], ...SUGGESTION }))
  const pending = promptVoidReversalPeriod('doc-1', COPY)
  await settle()
  await submitDate('next Friday')
  assert.ok(dialog(), 'junk stays in the dialog for correction')
  await submitDate('2025-11-01')
  assert.deepEqual(await pending, { cancelled: false, reversalDate: '2025-11-01', reversalPeriodId: null })
})

test('dismissing the date confirmation cancels the void', async (t) => {
  await mountPromptRoot(t)
  scriptFetch(t, () => Response.json({ adjustmentPeriods: [], ...SUGGESTION }))
  const pending = promptVoidReversalPeriod('doc-1', COPY)
  await settle()
  await clickCancel()
  assert.deepEqual(await pending, { cancelled: true, reversalDate: null, reversalPeriodId: null })
})

test('adjustment periods are offered after the date confirmation', async (t) => {
  await mountPromptRoot(t)
  scriptFetch(t, () => Response.json({
    adjustmentPeriods: [
      { id: 'period-a', name: 'FY26 Adjustment', startsOn: '2026-07-01', endsOn: '2026-07-31' },
      { id: 'period-b', name: 'FY25 Adjustment', startsOn: '2025-07-01', endsOn: '2025-07-31' },
    ],
    ...SUGGESTION,
  }))
  const pending = promptVoidReversalPeriod('doc-1', COPY)
  await settle()
  await submitDate('2025-10-31')
  await settle()
  const options = [...document.querySelectorAll('select#prompt-input option')]
  assert.deepEqual(
    options.map((o) => [(o as HTMLOptionElement).value, (o.textContent ?? '').trim()]),
    [
      ['', COPY.regularOption],
      ['period-a', 'FY26 Adjustment'],
      ['period-b', 'FY25 Adjustment'],
    ],
  )
  await chooseOption('period-b')
  assert.deepEqual(await pending, { cancelled: false, reversalDate: '2025-10-31', reversalPeriodId: 'period-b' })
})

test('choosing the regular default resolves a null override', async (t) => {
  await mountPromptRoot(t)
  scriptFetch(t, () => Response.json({
    adjustmentPeriods: [
      { id: 'period-a', name: 'FY26 Adjustment', startsOn: '2026-07-01', endsOn: '2026-07-31' },
    ],
    ...SUGGESTION,
  }))
  const pending = promptVoidReversalPeriod('doc-1', COPY)
  await settle()
  await submitDate('2025-10-31')
  await settle()
  await chooseOption('')
  assert.deepEqual(await pending, { cancelled: false, reversalDate: '2025-10-31', reversalPeriodId: null })
})

test('dismissing the period choice cancels the void', async (t) => {
  await mountPromptRoot(t)
  scriptFetch(t, () => Response.json({
    adjustmentPeriods: [
      { id: 'period-a', name: 'FY26 Adjustment', startsOn: '2026-07-01', endsOn: '2026-07-31' },
    ],
    ...SUGGESTION,
  }))
  const pending = promptVoidReversalPeriod('doc-1', COPY)
  await settle()
  await submitDate('2025-10-31')
  await settle()
  await clickCancel()
  assert.deepEqual(await pending, { cancelled: true, reversalDate: null, reversalPeriodId: null })
})

test('a failed lookup falls back to the server default without prompting', async (t) => {
  await mountPromptRoot(t)
  scriptFetch(t, () => new Response('proxy error', { status: 502 }))
  const choice = await promptVoidReversalPeriod('doc-1', COPY)
  assert.deepEqual(choice, { cancelled: false, reversalDate: null, reversalPeriodId: null })
  assert.equal(dialog(), null)
})
