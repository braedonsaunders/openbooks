import assert from 'node:assert/strict'
import test from 'node:test'

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4800/payroll/runs/run-1',
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
const messages = (await import('../../../../../messages/fr')).default
const { HolidayAttestations } = await import('./HolidayAttestations')

test('holiday attestation controls render translated copy for a French viewer', async (t) => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    employees: [{
      employeePartyId: 'employee-1',
      name: 'Ada',
      paidOnCommission: null,
      assertions: [],
      demanding: [],
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch
  t.after(() => {
    globalThis.fetch = previousFetch
  })

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
    for (const child of [...document.body.children]) child.remove()
  })

  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="fr" messages={messages} timeZone="UTC">
        <HolidayAttestations
          runId="run-1"
          errors={[{
            employee: 'Ada',
            employeePartyId: 'employee-1',
            neededFact: 'paidOnCommission',
            message: 'Commission-pay status is required.',
          }]}
          roster={[{ employee_party_id: 'employee-1', name: 'Ada' }]}
          canAnswer
          onAnswered={() => undefined}
        />
      </NextIntlClientProvider>,
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  assert.match(host.textContent ?? '', /Rémunération à la commission/)
  assert.doesNotMatch(host.textContent ?? '', /Paid on commission|Save & recalculate|Unanswered/)
})
