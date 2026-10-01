import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { dataTransferJob } from '../testing/data-transfer'
import type { TransferJob } from '../lib/data-io/transfer-contract'

const { bootJsdomEnvironment } = await import('../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/data/import', scrollIntoView: false, resizeObserver: false })
const React = await import('react')
Object.assign(globalThis, { React })
const { act, useState } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../messages/en')).default
const { DataTransferStatus } = await import('./data-transfer-status')
const { useTransferJob } = await import('../lib/data-io/transfer-client')
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function StatefulStatus({ initial }: { initial: TransferJob }) {
  const [job, setJob] = useState(initial)
  return <DataTransferStatus job={job} onChange={setJob} />
}
function RecoveredStatus() {
  const { job, remember, connectionError } = useTransferJob('import')
  return job ? <DataTransferStatus job={job} onChange={remember} connectionError={connectionError} /> : <p>Loading</p>
}
async function mount(t: TestContext, content: React.ReactNode) {
  const root = createRoot(document.body), previousFetch = globalThis.fetch
  t.after(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); globalThis.fetch = previousFetch })
  await act(async () => { root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">{content}</NextIntlClientProvider>); await delay(30) })
}

test('million-row progress exposes committed effects separately from processed records', async (t) => {
  await mount(t, <StatefulStatus initial={dataTransferJob({ state: 'committing', totalRows: 2_000_000, processedRows: 1_250_000,
    outcome: { created: 1_000_000, updated: 249_750, deleted: 250, failed: 0, errors: [] } })} />)
  assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /1,250,000 of 2,000,000/)
  const progress = document.querySelector('progress')!
  assert.equal(progress.value, 1_250_000); assert.equal(progress.max, 2_000_000)
  assert.match(document.body.textContent ?? '', /1,000,000 created, 249,750 updated, 250 deleted/)
  assert.equal(document.querySelector('a[href$="/download"]'), null)
})

test('cancellation waits for the server checkpoint and does not claim to undo committed batches', async (t) => {
  const job = dataTransferJob({ state: 'committing', totalRows: 500, processedRows: 250, revision: 4, outcome: { created: 250, updated: 0, failed: 0, errors: [] } })
  await mount(t, <StatefulStatus initial={job} />)
  let body: Record<string, unknown> = {}
  globalThis.fetch = (async (_input, init) => { body = JSON.parse(String(init?.body)); return Response.json({ job: { ...job, cancelRequested: true, revision: 5 } }) }) as typeof fetch
  const cancel = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!
  await act(async () => { cancel.click(); await delay(30) })
  assert.deepEqual(body, { action: 'cancel', revision: 4 })
  assert.match(document.body.textContent ?? '', /Cancelling after the current batch/)
  assert.match(document.body.textContent ?? '', /250 created/)
  assert.match(document.body.textContent ?? '', /preserves earlier committed batches/)
  assert.ok([...document.querySelectorAll('button')].some((button) => button.disabled && /Cancelling/.test(button.textContent ?? '')))
})

test('a failed import retains counts, names its remedy and retries the same durable job', async (t) => {
  const job = dataTransferJob({ state: 'failed', totalRows: 1_000, processedRows: 250,
    error: 'The batch was refused. Correct the row errors, then retry from the stored checkpoint.',
    outcome: { created: 250, updated: 0, failed: 1, errors: [{ row: 251, message: 'Account is unavailable — select an active account.' }] } })
  await mount(t, <StatefulStatus initial={job} />)
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /Correct the row errors.*retry from the stored checkpoint/)
  assert.equal(document.querySelector('a[href$="/issues?phase=commit"]')?.getAttribute('href'), `/api/data/transfers/${job.id}/issues?phase=commit`)
  let requested = ''
  globalThis.fetch = (async (input) => { requested = String(input); return Response.json({ job: { ...job, state: 'committing', error: null } }) }) as typeof fetch
  const retry = [...document.querySelectorAll('button')].find((button) => /Retry from checkpoint/.test(button.textContent ?? ''))!
  await act(async () => { retry.click(); await delay(30) })
  assert.equal(requested, `/api/data/transfers/${job.id}`)
  assert.equal(document.querySelector('[role="alert"]'), null)
  assert.match(document.body.textContent ?? '', /250 created/)
})

test('a reload recovers live progress and a connection interruption preserves the last checkpoint', async (t) => {
  const job = dataTransferJob({ state: 'committing', totalRows: 2_000_000, processedRows: 750_000 })
  window.history.replaceState(null, '', `/data/import?transfer=${job.id}`)
  const originalFetch = globalThis.fetch
  let reads = 0
  globalThis.fetch = (async () => {
    reads++
    if (reads === 2) return new Response('<html>temporarily unavailable</html>', { status: 503 })
    return Response.json({ job: reads > 2 ? { ...job, state: 'completed', processedRows: 2_000_000, outcome: { created: 2_000_000, updated: 0, failed: 0, errors: [] } } : job })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = originalFetch; window.history.replaceState(null, '', '/data/import') })
  await mount(t, <RecoveredStatus />)
  assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /750,000 of 2,000,000/)
  await act(async () => { await delay(1100) })
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /Reconnecting; the server job continues/)
  assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /750,000 of 2,000,000/)
  await act(async () => { await delay(4100) })
  assert.equal(document.querySelector('[role="alert"]'), null)
  assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /2,000,000 of 2,000,000/)
})
