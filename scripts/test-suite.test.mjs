import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createConnection, createServer } from 'node:net'
import test from 'node:test'
import { testManifest, stopFixtureOwner, literalTestPath } from './test-suite.mjs'
import { observeFixtureOwnerSocket } from './fixture-owner-transport.mjs'

test('every tracked supported test belongs to exactly one canonical suite', () => {
  const manifest = testManifest()
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0')
    .filter((name) => /\.test\.(?:tsx?|mjs|js)$/.test(name))
  for (const name of tracked) assert.ok(manifest.all.includes(name), `undiscovered test: ${name}`)
  assert.equal(new Set([...manifest.unit, ...manifest.integration, ...manifest.restore]).size, manifest.all.length)
  assert.equal(manifest.unit.length + manifest.integration.length + manifest.restore.length, manifest.all.length)
})

for (const closeFirst of [true, false]) {
  test(`fixture shutdown handles ${closeFirst ? 'close before response' : 'response before close'}`, async () => {
    const owner = new EventEmitter()
    owner.kill = () => {}
    const server = createServer((socket) => {
      socket.on('data', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        if (closeFirst) owner.emit('close', 0)
        socket.end('{"ok":true}\n', () => {
          if (!closeFirst) setTimeout(() => owner.emit('close', 0), 10)
        })
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const response = await stopFixtureOwner({ owner, port: server.address().port, output: '', clearTimeout() {} })
      assert.equal(response.ok, true)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
}

test('owner closing without a response rejects instead of abandoning the promise', async () => {
  const owner = new EventEmitter()
  owner.kill = () => {}
  const server = createServer((socket) => {
    socket.on('data', () => { socket.destroy(); owner.emit('close', 0) })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await assert.rejects(stopFixtureOwner({ owner, port: server.address().port, output: '', clearTimeout() {} },
      { timeoutMs: 1000 }), /without a response/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a disconnected worker does not stop the fixture owner serving the next request', async () => {
  let received = 0
  const errors = []
  const server = createServer((socket) => {
    observeFixtureOwnerSocket(socket, () => {
      received += 1
      if (received === 1) {
        // A peer reset is a transport failure for one worker, not permission
        // to abort every later tenant lease in this partition.
        socket.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
        socket.destroy()
      } else {
        socket.end('{"ok":true}\n')
      }
    }, (error) => errors.push(error))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const first = createConnection({ host: '127.0.0.1', port: server.address().port })
    await new Promise((resolve, reject) => {
      first.once('connect', () => first.end('first\n'))
      first.once('close', resolve)
      first.once('error', reject)
    })
    const second = createConnection({ host: '127.0.0.1', port: server.address().port })
    const response = await new Promise((resolve, reject) => {
      let data = ''
      second.on('data', (chunk) => { data += chunk })
      second.once('end', () => resolve(data))
      second.once('error', reject)
      second.once('connect', () => second.end('second\n'))
    })
    assert.deepEqual(JSON.parse(response), { ok: true })
    assert.equal(errors.length, 1)
    assert.equal(errors[0].code, 'ECONNRESET')
    assert.equal(received, 2)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a bracketed route path executes its actual tests', () => {
  const directory = mkdtempSync(join(tmpdir(), 'openbooks-test-path-'))
  try {
    mkdirSync(join(directory, '[id]'))
    const file = join(directory, '[id]', 'route.test.mjs')
    writeFileSync(file, "import test from 'node:test'; test('BRACKET_TEST_EXECUTED', () => {});\n")
    const output = execFileSync(process.execPath, ['--test', literalTestPath(file)], { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } })
    assert.match(output, /BRACKET_TEST_EXECUTED/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
