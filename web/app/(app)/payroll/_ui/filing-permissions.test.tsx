import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// F3-22: the filing workspace offered Record-as-filed, Issue amendment and
// Cancel slip to payroll.read-only callers — the routes refuse all three
// (payroll.run), but the buttons were there to press. The workspace now
// takes canFile (payroll.run, from the route's permission constant) and
// gates every filing act on it, while a read-only caller still reads every
// filing. Mounts the lifecycle bar and the correction section under jsdom
// with canFile on and off.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/payroll/year-end',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof dom.window.requestAnimationFrame !== 'function') {
  dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame
  dom.window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame
}
if (globals.requestAnimationFrame === undefined) {
  globals.requestAnimationFrame = dom.window.requestAnimationFrame
  globals.cancelAnimationFrame = dom.window.cancelAnimationFrame
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({
    matches: false,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { MoneyProvider } = await import('../../../../components/money-provider')
const {
  FilingCorrectionSection,
  FilingLifecycleBar,
} = await import('./filing-amendments')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const section = {
  country: 'CA',
  key: 't4',
  label: 'T4',
  data: { rows: [{ id: 'row-1' }], rowKey: 'id', columns: [], totals: null },
} as unknown as Parameters<typeof FilingLifecycleBar>[0]['section']

const lifecycle = {
  country: 'CA',
  filingKey: 't4',
  label: 'T4',
  taxYear: 2026,
  amendment: {
    supported: true,
    revisions: ['amended', 'cancelled'],
    vehicle: 'same_form',
    formLabel: null,
    download: null,
    downloadRefusal: null,
  },
  submissions: [
    {
      id: 'submission-1',
      revision: 'original',
      revisionNumber: 1,
      supersedesId: null,
      issuedAt: '2026-03-01T00:00:00.000Z',
      note: null,
      slipCount: 1,
      artifact: null,
      slips: [],
    },
  ],
  rows: [],
  populationRefusal: null,
} as unknown as Parameters<typeof FilingCorrectionSection>[0]['lifecycle']

const review = {
  rowId: 'row-1',
  label: 'Ada',
  status: 'changed',
  lastRevision: null,
  lastIssuedAt: null,
  changes: [],
} as unknown as Parameters<typeof FilingCorrectionSection>[0]['review']

async function mount(t: TestContext, node: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const rootHandle = createRoot(host)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    host.remove()
    for (const child of [...document.body.children]) child.remove()
  })
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="CAD">{node}</MoneyProvider>
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
}

const bodyText = () => document.body.textContent ?? ''

test('a read-only caller is never offered Record as filed', async (t) => {
  await mount(
    t,
    <FilingLifecycleBar
      section={section}
      year={2026}
      lifecycle={{ ...lifecycle, submissions: [] }}
      busy={false}
      error={null}
      onRecordOriginal={() => {}}
      canFile={false}
    />,
  )
  assert.doesNotMatch(bodyText(), /Record as filed/)
  // The status itself still reads: gating hides the act, never the evidence.
  assert.match(bodyText(), /Filing status/)
})

test('a filing caller is offered Record as filed before anything is issued', async (t) => {
  await mount(
    t,
    <FilingLifecycleBar
      section={{ ...section, data: { ...section.data, rows: [{ id: 'row-1' }] } } as typeof section}
      year={2026}
      lifecycle={{ ...lifecycle, submissions: [] }}
      busy={false}
      error={null}
      onRecordOriginal={() => {}}
      canFile
    />,
  )
  assert.match(bodyText(), /Record as filed/)
})

test('a read-only caller sees the correction but is never offered the amendment or the cancellation', async (t) => {
  await mount(
    t,
    <FilingCorrectionSection
      section={section}
      year={2026}
      review={review}
      lifecycle={lifecycle}
      onIssued={() => {}}
      canFile={false}
    />,
  )
  assert.doesNotMatch(bodyText(), /Issue amendment/)
  assert.doesNotMatch(bodyText(), /Cancel this slip/)
  // The review still reads: what moved since filing is evidence, not an act.
  assert.match(bodyText(), /Correction/)
})

test('a filing caller on a changed slip is offered both the amendment and the cancellation', async (t) => {
  await mount(
    t,
    <FilingCorrectionSection
      section={section}
      year={2026}
      review={review}
      lifecycle={lifecycle}
      onIssued={() => {}}
      canFile
    />,
  )
  assert.match(bodyText(), /Issue amendment/)
  assert.match(bodyText(), /Cancel this slip/)
})
