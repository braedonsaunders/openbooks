import assert from 'node:assert/strict'
import test from 'node:test'
import { runClientScripts } from '../../../../lib/client-scripts'

test('client scripts run through an iframe sandbox without same-origin or host-page access', async () => {
  const listeners = new Set<(event: MessageEvent) => void>()
  const attributes = new Map<string, string>()
  let removed = false
  let posted: unknown
  const contentWindow = {
    postMessage(message: unknown) {
      posted = message
      const event = {
        source: contentWindow,
        data: { __obClientScripts: true, results: [{ id: 's-1', name: 'Readiness check', result: { warnings: ['verify dimensions'] } }] },
      } as MessageEvent
      for (const listener of [...listeners]) listener(event)
    },
  }
  const iframe = {
    style: { display: '' },
    srcdoc: '',
    contentWindow,
    setAttribute(name: string, value: string) { attributes.set(name, value) },
    remove() { removed = true },
  }
  const browser = globalThis as typeof globalThis & {
    window: Window
    document: Document
    fetch: typeof fetch
  }
  const previousWindow = browser.window
  const previousDocument = browser.document
  const previousFetch = browser.fetch
  browser.window = {
    addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
      listeners.add(listener as (event: MessageEvent) => void)
    },
    removeEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
      listeners.delete(listener as (event: MessageEvent) => void)
    },
  } as unknown as Window & typeof globalThis
  browser.document = {
    createElement(tagName: string) {
      assert.equal(tagName, 'iframe')
      return iframe
    },
    body: {
      appendChild(element: Node) {
        assert.equal(element, iframe)
        const ready = { source: contentWindow, data: { __obClientScripts: true, ready: true } } as MessageEvent
        for (const listener of [...listeners]) listener(ready)
        return element
      },
    },
  } as unknown as Document
  browser.fetch = async (_input, init) => {
    assert.equal(init?.credentials, 'same-origin')
    return new Response(JSON.stringify({ scripts: [{ id: 's-1', name: 'Readiness check', source: 'function main() { return { warnings: ["verify dimensions"] } }' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  try {
    const kind = `sandbox-${Date.now()}-${Math.random()}`
    const doc = { amount: '12.00' }
    const result = await runClientScripts(kind, doc)
    assert.equal(attributes.get('sandbox'), 'allow-scripts')
    assert.ok(!attributes.get('sandbox')?.split(/\s+/).includes('allow-same-origin'))
    assert.match(iframe.srcdoc, /Content-Security-Policy/)
    assert.deepEqual(result, { ok: true, warnings: ['Readiness check: verify dimensions'] })
    assert.deepEqual(posted, {
      scripts: [{ id: 's-1', name: 'Readiness check', source: 'function main() { return { warnings: ["verify dimensions"] } }' }],
      ctx: { kind, doc },
    })
    assert.equal(removed, true, 'the disposable evaluator iframe is removed after its reply')
  } finally {
    browser.window = previousWindow
    browser.document = previousDocument
    browser.fetch = previousFetch
  }
})
