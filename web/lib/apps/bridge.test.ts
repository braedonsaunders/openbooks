// Run with:  node --import tsx --test web/lib/apps/bridge.test.ts   (from repo root)
//
// Unit tests for the pure bridge protocol helpers: request narrowing, result
// envelopes, document inlining, and SDK/CSP shape.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseBridgeRequest,
  makeBridgeResult,
  isBridgeMethod,
  inlineDocument,
  bridgeClientSource,
  APP_CSP,
  BRIDGE_MARKER,
} from './bridge.ts'

test('parseBridgeRequest accepts a well-formed call', () => {
  const r = parseBridgeRequest({ [BRIDGE_MARKER]: true, type: 'call', id: 'c1', method: 'callBackend', payload: { x: 1 } })
  assert.ok(r)
  assert.equal(r!.method, 'callBackend')
  assert.deepEqual(r!.payload, { x: 1 })
})

test('parseBridgeRequest rejects junk and non-bridge messages', () => {
  assert.equal(parseBridgeRequest(null), null)
  assert.equal(parseBridgeRequest('hi'), null)
  assert.equal(parseBridgeRequest({ type: 'call', id: 'x', method: 'm' }), null) // missing marker
  assert.equal(parseBridgeRequest({ [BRIDGE_MARKER]: true, type: 'result', id: 'x' }), null) // wrong type
  assert.equal(parseBridgeRequest({ [BRIDGE_MARKER]: true, type: 'call', id: 1, method: 'm' }), null) // bad id
})

test('makeBridgeResult builds ok and error envelopes', () => {
  const ok = makeBridgeResult('c1', true, { a: 1 })
  assert.deepEqual(ok, { [BRIDGE_MARKER]: true, type: 'result', id: 'c1', ok: true, result: { a: 1 } })
  const err = makeBridgeResult('c2', false, new Error('boom'))
  assert.equal(err.ok, false)
  assert.match(err.error!, /boom/)
})

test('isBridgeMethod allowlists only known methods', () => {
  assert.equal(isBridgeMethod('callBackend'), true)
  assert.equal(isBridgeMethod('records.list'), true)
  assert.equal(isBridgeMethod('storage.set'), false)
  assert.equal(isBridgeMethod('__proto__'), false)
})

test('inlineDocument substitutes asset refs and injects head', () => {
  const html = `<html><head><link rel="stylesheet" href="styles.css"></head><body><img src="./logo.png"><script src="app.js"></script></body></html>`
  const out = inlineDocument(
    html,
    {
      'styles.css': 'data:text/css;base64,AAAA',
      'logo.png': 'data:image/png;base64,BBBB',
      'app.js': 'data:text/javascript;base64,CCCC',
    },
    '<meta name="injected">',
  )
  assert.match(out, /href="data:text\/css;base64,AAAA"/)
  assert.match(out, /src="data:image\/png;base64,BBBB"/) // ./logo.png normalized
  assert.match(out, /src="data:text\/javascript;base64,CCCC"/)
  assert.match(out, /<head><meta name="injected">/) // injected right after <head>
})

test('inlineDocument handles documents without a <head>', () => {
  const out = inlineDocument('<html><body>hi</body></html>', {}, '<meta name="x">')
  assert.match(out, /<head><meta name="x"><\/head>/)
})

test('bridgeClientSource embeds context and defines the SDK surface', () => {
  const src = bridgeClientSource({ app: { id: 'a1', key: 'demo', name: 'Demo' }, user: { id: 'u1', name: 'Ada', role: 'admin' } })
  assert.match(src, /window\.openbooks/)
  assert.match(src, /callBackend/)
  assert.match(src, /records/)
  assert.match(src, /"key":"demo"/)
  assert.match(src, /type: 'ready'/)
})

test('APP_CSP locks down default-src and blocks app network', () => {
  assert.match(APP_CSP, /default-src 'none'/)
  assert.match(APP_CSP, /connect-src 'none'/)
})
