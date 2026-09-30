import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../../testing/jsdom-env'
await bootJsdomEnvironment({ url: 'http://localhost/time/clock' })
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: window.localStorage })
Object.assign(globalThis, { Storage: window.Storage })
const { stubModules } = await import('../../testing/stub-modules')
stubModules({})
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../messages/en')).default
const { ClockControls } = await import('./ClockControls')

const ownerA = 'a'.repeat(64), ownerB = 'b'.repeat(64)
const prefix = 'openbooks.field-clock-queue'
const status = { clockedIn: true, since: null, projectId: null, projectName: null, costCodeRef: null, onBreak: false }
async function mount(ownerKey: string) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<NextIntlClientProvider locale="en" messages={messages}><ClockControls ownerKey={ownerKey} initial={status} projects={[]} tasks={[]} photoRequired={false} photoFolderId={null} geoHint="" clockOutLabel="Clock out" /></NextIntlClientProvider>))
  return async () => { await act(async () => root.unmount()); host.remove() }
}
async function click(label: string) {
  const button = [...document.querySelectorAll('button')].find((element) => element.textContent?.trim() === label)
  assert.ok(button, label)
  await act(async () => { button.click(); await new Promise((resolve) => setTimeout(resolve, 10)) })
}

test('clock retry isolates owners, survives blocked storage, retains missing acknowledgments and drains bounded batches', async () => {
  const originalFetch = globalThis.fetch
  const originalSet = Storage.prototype.setItem
  let unmount: (() => Promise<void>) | undefined
  try {
    localStorage.clear()
    Storage.prototype.setItem = () => { throw new Error('quota exceeded') }
    let missing = true
    const batches: Array<{ ownerKey: string; events: Array<{ ownerKey: string }> }> = []
    globalThis.fetch = async (_url, init) => {
      if (!init?.method) return Response.json({ status })
      const body = JSON.parse(String(init.body))
      if (!body.events) throw new TypeError('network unavailable')
      batches.push(body)
      return Response.json({ results: missing ? [] : body.events.map(() => ({ eventId: crypto.randomUUID() })) })
    }
    unmount = await mount(ownerA)
    await click('Clock out')
    assert.match(document.body.textContent ?? '', /Keep this page open/)
    await click('Replay now')
    assert.equal(batches.length, 1, 'retry uses the retained in-memory event')
    assert.match(document.body.textContent ?? '', /1 events queued/)
    missing = false
    await click('Replay now')
    assert.doesNotMatch(document.body.textContent ?? '', /events queued/)
    await unmount(); unmount = undefined
    Storage.prototype.setItem = originalSet

    const entries = Array.from({ length: 201 }, () => ({ key: crypto.randomUUID(), body: { ownerKey: ownerA, kind: 'clock_in', occurredAt: '2026-09-29T08:00:00Z', clientEventId: crypto.randomUUID() } }))
    localStorage.setItem(`${prefix}.${ownerA}`, JSON.stringify(entries))
    localStorage.setItem(prefix, JSON.stringify([{ body: { kind: 'clock_in' } }]))
    unmount = await mount(ownerB)
    assert.ok(![...document.querySelectorAll('button')].some((button) => button.textContent === 'Replay now'))
    assert.equal(JSON.parse(localStorage.getItem(`${prefix}.${ownerA}`)!).length, 201)
    await unmount(); unmount = undefined
    batches.length = 0
    unmount = await mount(ownerA)
    await click('Replay now')
    assert.deepEqual(batches.map((batch) => batch.events.length), [200, 1])
    assert.ok(batches.every((batch) => batch.ownerKey === ownerA && batch.events.every((event) => event.ownerKey === ownerA)))
    assert.equal(localStorage.getItem(`${prefix}.${ownerA}`), '[]')
    assert.ok(localStorage.getItem(prefix), 'legacy events are retained for controlled recovery')
  } finally {
    await unmount?.()
    Storage.prototype.setItem = originalSet
    globalThis.fetch = originalFetch
    localStorage.clear()
  }
})

test.after(() => window.close())
