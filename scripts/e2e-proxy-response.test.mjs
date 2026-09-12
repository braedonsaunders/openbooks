import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { forwardResponse } from './e2e-proxy-response.mjs'

test('a truncated upstream body promptly closes the browser response', { timeout: 5_000 }, async (t) => {
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-length': '1000' })
    response.write('partial body')
    setImmediate(() => response.destroy())
  })
  const proxy = http.createServer((_request, response) => {
    const request = http.get(`http://127.0.0.1:${upstream.address().port}`, (result) => forwardResponse(result, response))
    request.on('error', (error) => response.destroy(error))
  })
  t.after(() => {
    for (const server of [proxy, upstream]) { server.closeAllConnections(); server.close() }
  })
  for (const server of [upstream, proxy]) await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const result = await new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${proxy.address().port}`, (response) => {
      response.resume()
      response.on('error', () => {})
      response.on('close', () => resolve({ complete: response.complete }))
    })
    request.on('error', reject)
    request.setTimeout(1_000, () => { request.destroy(); reject(new Error('truncated response remained open')) })
  })
  assert.equal(result.complete, false)
})
