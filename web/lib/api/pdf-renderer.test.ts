import assert from 'node:assert/strict'
import test from 'node:test'
import { RendererUnavailableError } from '@openbooks/pdf'
import {
  isRendererUnavailable,
  rendererStatusResponse,
  rendererUnavailableResponse,
} from './pdf-renderer'

test('ordinary errors are not renderer outages', () => {
  assert.equal(isRendererUnavailable(new Error('boom')), false)
  assert.equal(isRendererUnavailable(null), false)
  assert.equal(isRendererUnavailable('PDF renderer is unavailable'), false)
  assert.equal(rendererUnavailableResponse(new Error('boom')), null)
})

test('the typed refusal maps to 503 carrying the path and the remedy', async () => {
  const error = new RendererUnavailableError('/usr/bin/chromium')
  assert.equal(isRendererUnavailable(error), true)
  const response = rendererUnavailableResponse(error)
  assert.ok(response)
  assert.equal(response.status, 503)
  const body = (await response.json()) as { error: string }
  assert.ok(body.error.includes('/usr/bin/chromium'))
  assert.ok(body.error.includes('PUPPETEER_EXECUTABLE_PATH'))
})

test('the refusal survives boundaries that drop the prototype', async () => {
  // A serialized flow error rethrown in a route keeps its name and message
  // but loses the class: the mapper must still recognize it.
  const error = { name: 'RendererUnavailableError', message: 'PDF renderer is unavailable: gone' }
  assert.equal(isRendererUnavailable(error), true)
  const response = rendererUnavailableResponse(error)
  assert.ok(response)
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'PDF renderer is unavailable: gone' })
})

test('readiness maps to 503 only when unavailable', async () => {
  assert.equal(
    rendererStatusResponse({ available: true, executablePath: '/usr/bin/chromium', message: 'PDF renderer is available at /usr/bin/chromium.' }),
    null,
  )
  const response = rendererStatusResponse({
    available: false,
    executablePath: '/usr/bin/chromium',
    message: new RendererUnavailableError('/usr/bin/chromium').message,
  })
  assert.ok(response)
  assert.equal(response.status, 503)
  const body = (await response.json()) as { error: string }
  assert.ok(body.error.includes('/usr/bin/chromium'))
})
