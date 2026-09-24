import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchChequePdf } from './RunWizard'

const originalFetch = globalThis.fetch
test.after(() => { globalThis.fetch = originalFetch })

test('cheque PDF download surfaces a named refusal', async () => {
  globalThis.fetch = (async () => Response.json({ error: 'the run is not committed' }, { status: 409 })) as typeof fetch
  await assert.rejects(fetchChequePdf('run-1', 'Could not prepare the cheque PDF.'), /the run is not committed/)
})

test('cheque PDF download uses a translated fallback for non-JSON errors', async () => {
  globalThis.fetch = (async () => new Response('<html>proxy error</html>', { status: 502 })) as typeof fetch
  await assert.rejects(
    fetchChequePdf('run-1', 'Could not prepare the cheque PDF.'),
    /Could not prepare the cheque PDF\. \(status 502\)/,
  )
})
