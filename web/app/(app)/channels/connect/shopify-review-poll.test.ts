import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForShopifyReview } from './shopify-review-poll'

const options = () => ({ signal: new AbortController().signal, failureMessage: 'Cannot load approval', timeoutMessage: 'Complete Shopify approval, then refresh to retry.', intervalMs: 1, timeoutMs: 1000 })

test('Shopify approval surfaces a named HTTP refusal immediately', async () => {
  const prior = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json({ error: 'This shop is not bound to this channel. Reconnect the intended shop.' }, { status: 422 }) }
  try {
    await assert.rejects(waitForShopifyReview('channel', options()), /not bound.*Reconnect the intended shop/)
    assert.equal(calls, 1)
  } finally { globalThis.fetch = prior }
})

test('Shopify polls pending approval until ready and preserves its payload', async () => {
  const prior = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => Response.json(++calls === 1 ? { channel: { status: 'draft' } } : { channel: { status: 'connected' }, shop: 'example.myshopify.com' })
  try {
    assert.deepEqual(await waitForShopifyReview('channel', options()), { channel: { status: 'connected' }, shop: 'example.myshopify.com' })
    assert.equal(calls, 2)
  } finally { globalThis.fetch = prior }
})

test('Shopify approval refuses unreadable responses and network failures', async () => {
  const prior = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response('upstream unavailable', { status: 503 })
    await assert.rejects(waitForShopifyReview('channel', options()), /Cannot load approval/)
    globalThis.fetch = async () => { throw new Error('connection lost') }
    await assert.rejects(waitForShopifyReview('channel', options()), /connection lost/)
    globalThis.fetch = async () => new Response('not JSON', { status: 200 })
    await assert.rejects(waitForShopifyReview('channel', options()), /Cannot load approval.*status 200/)
  } finally { globalThis.fetch = prior }
})

test('Shopify approval timeout names the retry remedy and aborts a pending request', async () => {
  const prior = globalThis.fetch
  let aborted = false
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => { aborted = true; reject(init!.signal!.reason) }, { once: true })
  })
  try {
    await assert.rejects(waitForShopifyReview('channel', { ...options(), timeoutMs: 10 }), /Complete Shopify approval, then refresh to retry/)
    assert.equal(aborted, true)
  } finally { globalThis.fetch = prior }
})

test('leaving Shopify review cancels its wait without another request', async () => {
  const prior = globalThis.fetch
  const controller = new AbortController()
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json({ channel: { status: 'draft' } }) }
  try {
    const pending = waitForShopifyReview('channel', { ...options(), signal: controller.signal, intervalMs: 1000 })
    const checked = assert.rejects(pending, /left review/)
    await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort(new Error('left review'))
    await checked
    assert.equal(calls, 1)
  } finally { globalThis.fetch = prior }
})
