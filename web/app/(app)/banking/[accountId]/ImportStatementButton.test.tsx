import assert from 'node:assert/strict'
import test from 'node:test'

// (statement-import Preview on junk CSV): the preview POST 422s
// with a typed { error } body, but the dialog neither toasts usefully nor
// persists anything — the click reads as dead. The dialog must persist the
// typed refusal as a role=alert (cleared on the next edit) and toast it,
// mirroring the RunBuilder pattern; an unreadable error body must
// fall back to the generic request-failed copy instead of a SyntaxError.
const { bootJsdomEnvironment } = await import('../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/banking/acc-1', scrollIntoView: false })

const script = {
  toasts: [] as Array<{ kind: string; message: string }>,
  previewStatus: 422 as number,
  previewBody: { error: 'CSV has a header but no data rows' } as unknown,
}
Object.assign(globalThis, {
  __importTestToasts: script.toasts,
  __importTestRouter: {
    push() {},
    refresh() {},
    replace() {},
    back() {},
    prefetch() {},
  },
})
const { registerHooks } = await import('node:module')
const { stubModules } = await import('../../../../testing/stub-modules')
stubModules({ navigation: 'export function useRouter(){return globalThis.__importTestRouter}' })
registerHooks({
  resolve(specifier, context, next) {

    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(m){globalThis.__importTestToasts.push({kind:"success",message:String(m)})},error(m){globalThis.__importTestToasts.push({kind:"error",message:String(m)})}};export function Toaster(){return null}',
      }
    }
    return next(specifier, context)
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { MoneyProvider } = await import('../../../../components/money-provider')
const { ImportStatementButton } = await import('./ImportStatementButton')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

function setNativeValue(el: HTMLElement, value: string) {
  const proto = el instanceof window.HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLSelectElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  setter.call(el, value)
}

async function mount() {
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String((init?.body as string) ?? '{}')) as { mode?: string }
    if (url === '/api/banking/import' && body.mode === 'columns') {
      return Response.json({ header: ['hello', 'not', 'a', 'statement'] })
    }
    if (url === '/api/banking/import' && body.mode === 'preview') {
      if (script.previewStatus === 200) return Response.json({ lines: [], imported: 0, duplicates: 0 })
      return Response.json(script.previewBody, { status: script.previewStatus })
    }
    throw new Error(`unexpected fetch ${String(url)} ${body.mode}`)
  }) as typeof fetch
  script.toasts.length = 0
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="CAD">
          <ImportStatementButton accountId="acc-1" />
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
    await tick()
  })
  return { host, root }
}

function clickButton(text: string) {
  const btn = [...document.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === text,
  ) as HTMLButtonElement | undefined
  assert.ok(btn, `button "${text}" must render`)
  return btn
}

test('statement import controls are associated with their visible labels', async (t) => {
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  await act(async () => {
    clickButton('Import statement').click()
    await tick()
  })
  for (const name of ['Format', 'File', 'Statement text']) {
    const label = [...document.querySelectorAll('label')].find((candidate) => candidate.textContent?.trim() === name)
    assert.ok(label, `${name} label renders`)
    assert.ok(label.control, `${name} label controls an input`)
  }
})

/** Drive the dialog to a mapped junk-CSV CSV state with Preview enabled. */
async function mapJunkCsv() {
  await act(async () => {
    clickButton('Import statement').click()
    await tick()
    await tick()
  })
  const formatSelect = document.querySelector('select') as HTMLSelectElement
  assert.ok(formatSelect, 'the format picker must render')
  await act(async () => {
    setNativeValue(formatSelect, 'csv')
    formatSelect.dispatchEvent(new window.Event('change', { bubbles: true }))
    await tick()
  })
  const area = document.querySelector('textarea') as HTMLTextAreaElement
  assert.ok(area, 'the statement text box must render')
  await act(async () => {
    setNativeValue(area, 'hello,not,a,statement')
    area.dispatchEvent(new window.Event('input', { bubbles: true }))
    await tick()
  })
  await act(async () => {
    clickButton('Detect columns').click()
    await tick()
    await tick()
  })
  const selects = [...document.querySelectorAll('select')]
  // format + date + amount + description (+ optional debit/ref/txn-id)
  assert.ok(selects.length >= 4, 'the column mapping selects must render')
  const [, dateSel, amountSel, descSel] = selects as HTMLSelectElement[]
  await act(async () => {
    for (const [sel, value] of [[dateSel, '0'], [amountSel, '1'], [descSel, '2']] as const) {
      setNativeValue(sel!, value)
      sel!.dispatchEvent(new window.Event('change', { bubbles: true }))
      await tick()
    }
  })
}

test('a refused import preview persists the typed server reason as a dialog alert', async (t) => {
  script.previewStatus = 422
  script.previewBody = { error: 'CSV has a header but no data rows' }
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  await mapJunkCsv()
  await act(async () => {
    clickButton('Preview').click()
    await tick()
    await tick()
  })
  const alert = document.querySelector('[role="alert"]')
  assert.ok(alert, 'the refused preview must persist a dialog-level alert')
  assert.match(alert.textContent ?? '', /header but no data rows/)
  const errors = script.toasts.filter((toast) => toast.kind === 'error')
  assert.equal(errors.length, 1, 'the refused preview must also toast once')
  assert.match(errors[0]!.message, /header but no data rows/)
})

test('an unreadable preview refusal falls back to the generic copy', async (t) => {
  script.previewStatus = 500
  script.previewBody = '<html>proxy boom</html>'
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  await mapJunkCsv()
  // Non-JSON body: override fetch to return raw HTML for the preview call.
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String((init?.body as string) ?? '{}')) as { mode?: string }
    if (body.mode === 'columns') return Response.json({ header: ['hello', 'not', 'a', 'statement'] })
    return new Response('<html>proxy boom</html>', { status: 500 })
  }) as typeof fetch
  await act(async () => {
    clickButton('Preview').click()
    await tick()
    await tick()
  })
  const alert = document.querySelector('[role="alert"]')
  assert.ok(alert, 'an unreadable refusal must still persist an alert')
  assert.doesNotMatch(alert.textContent ?? '', /Unexpected token/)
  const errors = script.toasts.filter((toast) => toast.kind === 'error')
  assert.equal(errors.length, 1, 'an unreadable refusal must toast once')
})

// ---------------------------------------------------------------------------
// Account picker, format memory, next-step guidance, balance candidates.
// ---------------------------------------------------------------------------

const dialogScript = {
  bodies: [] as { url: string; body: string }[],
  accounts: [
    { id: 'acc-1', label: '1000 Operating Cash', currency: 'CAD', type: 'asset_bank' },
    { id: 'acc-2', label: '2050 Corporate Card', currency: 'CAD', type: 'liability_card' },
  ] as { id: string; label: string; currency: string; type: string }[],
  previewImpl: (_parsed: Record<string, unknown>) => ({
    lines: [{ postedOn: '2026-11-02', amount: '-45.00', description: 'Card payment' }],
    imported: 1,
    duplicates: 0,
    possibleDuplicates: 0,
    skipped: [],
    balanceCandidates: [],
    statementDate: '2026-11-30',
    closingBalance: null as string | null,
    currency: 'CAD',
  }),
}

function clearFormatMemory() {
  const doomed: string[] = []
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i)
    if (key?.startsWith('openbooks.statementImport.format.')) doomed.push(key)
  }
  for (const key of doomed) window.localStorage.removeItem(key)
}

async function mountDialog() {
  dialogScript.bodies.length = 0
  script.toasts.length = 0
  // Format memory is per account and persists across mounts in this file:
  // start hermetic (the remembers-format test presets after mounting).
  clearFormatMemory()
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const target = String(url)
    const raw = String((init?.body as string) ?? '{}')
    dialogScript.bodies.push({ url: target, body: raw })
    if (target === '/api/banking/accounts') return Response.json({ ok: true, accounts: dialogScript.accounts })
    const parsed = JSON.parse(raw) as { mode?: string }
    if (parsed.mode === 'columns') return Response.json({ header: ['Date', 'Amount', 'Description'] })
    if (parsed.mode === 'preview') return Response.json(dialogScript.previewImpl(parsed))
    if (parsed.mode === 'import') return Response.json({ imported: 1, duplicates: 0, possibleDuplicates: 0 })
    throw new Error(`unexpected fetch ${target} ${parsed.mode}`)
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="CAD">
          <ImportStatementButton accountId="acc-1" />
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
    await tick()
  })
  return { host, root }
}

async function openDialog() {
  await act(async () => {
    clickButton('Import statement').click()
    await tick()
    await tick()
    await tick()
  })
}

// The app-wide Select is a typeahead with a visually-hidden native select
// underneath (no id forwarded): drive the hidden selects positionally, as the
// original tests do. The account picker renders first, then format.
function hiddenSelects(): HTMLSelectElement[] {
  return [...document.querySelectorAll('select')]
}

function accountSelect(): HTMLSelectElement {
  const label = [...document.querySelectorAll('label')].find((candidate) => candidate.textContent?.trim() === 'Account')
  assert.ok(label, 'the dialog must require its account visibly')
  const selects = hiddenSelects()
  assert.ok(selects.length >= 1, 'the account options must render')
  return selects[0]!
}

function formatSelect(): HTMLSelectElement {
  const selects = hiddenSelects()
  assert.ok(selects.length >= 2, 'the format options must render')
  return selects[1]!
}

async function pasteText(value: string) {
  const area = document.querySelector('textarea') as HTMLTextAreaElement
  assert.ok(area, 'the statement text box must render')
  await act(async () => {
    setNativeValue(area, value)
    area.dispatchEvent(new window.Event('input', { bubbles: true }))
    await tick()
  })
}

function dialogCleanup(t: { after: (fn: () => unknown) => void }, host: HTMLElement, root: { unmount: () => void }) {
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
    clearFormatMemory()
  })
}

test('the dialog requires its account visibly, defaulted from the page', async (t) => {
  const { host, root } = await mountDialog()
  dialogCleanup(t, host, root)
  await openDialog()
  const select = accountSelect()
  assert.equal(select.value, 'acc-1', 'the picker defaults to the page account')
  assert.ok(
    (document.body.textContent ?? '').includes('1000 Operating Cash') ||
    [...select.options].some((o) => o.text.includes('Corporate Card')),
    'the picker must list the reconcilable accounts',
  )
  assert.ok((document.body.textContent ?? '').includes('CAD'), 'the choice must show its currency visibly')
  await act(async () => {
    setNativeValue(select, 'acc-2')
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
    await tick()
    await tick()
  })
  assert.equal(accountSelect().value, 'acc-2', 'the operator can retarget the import')
  await pasteText('OFXHEADER:100\nDATA:OFXSGML')
  await act(async () => {
    clickButton('Preview').click()
    await tick()
    await tick()
  })
  const previewed = dialogScript.bodies.find((b) => b.body.includes('"mode":"preview"'))
  assert.ok(previewed, 'the preview must post')
  assert.ok(previewed.body.includes('"accountId":"acc-2"'), `the preview must target the picked account, got ${previewed.body}`)
})

test('a statement currency mismatch warns before the engine refuses', async (t) => {
  const { host, root } = await mountDialog()
  dialogCleanup(t, host, root)
  dialogScript.previewImpl = (_parsed: Record<string, unknown>) => ({
    lines: [{ postedOn: '2026-11-02', amount: '100.00', description: 'Deposit' }],
    imported: 1,
    duplicates: 0,
    possibleDuplicates: 0,
    skipped: [],
    balanceCandidates: [],
    statementDate: '2026-11-30',
    closingBalance: null as string | null,
    currency: 'USD',
  })
  await openDialog()
  await pasteText('OFXHEADER:100\nDATA:OFXSGML')
  await act(async () => {
    clickButton('Preview').click()
    await tick()
    await tick()
  })
  const alert = [...document.querySelectorAll('[role="alert"]')].find((el) =>
    (el.textContent ?? '').includes('does not match account currency'),
  )
  assert.ok(alert, `the currency mismatch must warn in the dialog, got ${document.body.textContent}`)
})

test('editing the statement date after preview disables import with a notice', async (t) => {
  const { host, root } = await mountDialog()
  dialogCleanup(t, host, root)
  await openDialog()
  await pasteText('OFXHEADER:100\nDATA:OFXSGML')
  await act(async () => {
    clickButton('Preview').click()
    await tick()
    await tick()
  })
  const importButton = [...document.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').trim().startsWith('Import 1 line'),
  ) as HTMLButtonElement | undefined
  assert.ok(importButton, 'the fresh preview must enable Import')
  assert.equal(importButton.disabled, false)
  const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement | null
  assert.ok(dateInput, 'the preview must offer the statement date')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(dateInput, '2026-11-29')
    dateInput.dispatchEvent(new window.Event('input', { bubbles: true }))
    await tick()
  })
  assert.ok(
    (document.body.textContent ?? '').includes('run Preview again to enable Import'),
    'editing after preview must say import needs a re-preview',
  )
  assert.equal(importButton.disabled, true, 'import must stay disabled until re-preview')
})

test('pasted CSV names Detect columns as the next step', async (t) => {
  const { host, root } = await mountDialog()
  dialogCleanup(t, host, root)
  await openDialog()
  assert.ok(
    (document.body.textContent ?? '').includes('paste statement text or choose a file'),
    'an empty dialog must name its first step',
  )
  await act(async () => {
    const format = formatSelect()
    setNativeValue(format, 'csv')
    format.dispatchEvent(new window.Event('change', { bubbles: true }))
    await tick()
  })
  await pasteText('Date,Amount,Description\n2026-11-02,-45.00,Card payment')
  assert.ok(
    (document.body.textContent ?? '').includes('run Detect columns to map Date, Amount and Description'),
    'pasted CSV must name Detect columns as the next step',
  )
})

test('a balance candidate offers one-click balance fills', async (t) => {
  dialogScript.previewImpl = (_parsed: Record<string, unknown>) => ({
    lines: [{ postedOn: '2026-11-02', amount: '100.00', description: 'Receipt' }],
    imported: 1,
    duplicates: 0,
    possibleDuplicates: 0,
    skipped: [],
    balanceCandidates: [
      { postedOn: '2026-11-01', amount: '3068.57', description: 'Opening balance', role: 'opening' },
    ],
    statementDate: '2026-11-30',
    closingBalance: null as string | null,
    currency: 'CAD',
  })
  const { host, root } = await mountDialog()
  dialogCleanup(t, host, root)
  await openDialog()
  await pasteText('OFXHEADER:100\nDATA:OFXSGML')
  await act(async () => {
    clickButton('Preview').click()
    await tick()
    await tick()
  })
  assert.ok(
    (document.body.textContent ?? '').includes('look like statement balances'),
    'the preview must call out balance rows',
  )
  const use = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Use as opening') as HTMLButtonElement | undefined
  assert.ok(use, 'the candidate must offer Use as opening')
  await act(async () => {
    use.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
  })
  const opening = [...document.querySelectorAll('input')].find((i) => i.getAttribute('inputmode') === 'decimal') as HTMLInputElement | undefined
  assert.ok(opening && opening.value.includes('3068.57'), `the opening balance must fill, got ${opening?.value}`)
  assert.ok(
    (document.body.textContent ?? '').includes('run Preview again to enable Import'),
    'using a candidate must require a re-preview',
  )
})

test('each account remembers its own last used format', async (t) => {
  const { host, root } = await mountDialog()
  dialogCleanup(t, host, root)
  window.localStorage.setItem('openbooks.statementImport.format.acc-2', 'csv')
  await openDialog()
  assert.equal(formatSelect().value, 'ofx', 'the page account starts from its own memory (none: OFX)')
  await act(async () => {
    const select = accountSelect()
    setNativeValue(select, 'acc-2')
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
    await tick()
  })
  assert.equal(formatSelect().value, 'csv', 'switching accounts recalls that account’s format')
  await act(async () => {
    const format = formatSelect()
    setNativeValue(format, 'bai2')
    format.dispatchEvent(new window.Event('change', { bubbles: true }))
    await tick()
  })
  assert.equal(
    window.localStorage.getItem('openbooks.statementImport.format.acc-2'),
    'bai2',
    'choosing a format remembers it for the account',
  )
})
