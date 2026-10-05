import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createConnection, createServer } from 'node:net'
import test from 'node:test'
import { testManifest, stopFixtureOwner, literalTestPath, validateForwardedOptions } from './test-suite.mjs'
import { observeFixtureOwnerSocket } from './fixture-owner-transport.mjs'

test('every tracked supported test belongs to exactly one canonical suite', () => {
  const manifest = testManifest()
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0')
    .filter((name) => /\.test\.(?:tsx?|mjs|js)$/.test(name))
  for (const name of tracked) assert.ok(manifest.all.includes(name), `undiscovered test: ${name}`)
  assert.equal(new Set([...manifest.unit, ...manifest.integration, ...manifest.restore]).size, manifest.all.length)
  assert.equal(manifest.unit.length + manifest.integration.length + manifest.restore.length, manifest.all.length)
})

async function withFixtureOwner(onRequest, verify) {
  const owner = new EventEmitter()
  owner.kill = () => {}
  const server = createServer((socket) => socket.on('data', () => onRequest(socket, owner)))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await verify({ owner, port: server.address().port, output: '', clearTimeout() {} })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

for (const closeFirst of [true, false]) {
  test(`fixture shutdown handles ${closeFirst ? 'close before response' : 'response before close'}`, async () => {
    await withFixtureOwner(async (socket, owner) => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      if (closeFirst) owner.emit('close', 0)
      socket.end('{"ok":true}\n', () => {
        if (!closeFirst) setTimeout(() => owner.emit('close', 0), 10)
      })
    }, async (handle) => {
      assert.equal((await stopFixtureOwner(handle)).ok, true)
    })
  })
}

test('owner closing without a response rejects instead of abandoning the promise', async () => {
  await withFixtureOwner((socket, owner) => { socket.destroy(); owner.emit('close', 0) }, async (handle) => {
    await assert.rejects(stopFixtureOwner(handle, { timeoutMs: 1000 }), /without a response/)
  })
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
    const send = (request) => new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: server.address().port })
      let data = ''
      socket.on('data', (chunk) => { data += chunk })
      socket.once('close', () => resolve(data))
      socket.once('error', reject)
      socket.once('connect', () => socket.end(request + '\n'))
    })
    await send('first')
    const response = await send('second')
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

test('partition arguments preserve Node option values and refuse filenames before launching tests', () => {
  for (const args of [[], ['--test-concurrency=1'], ['--test-reporter', 'spec', '--test-name-pattern', 'named case']]) {
    assert.doesNotThrow(() => validateForwardedOptions(args))
  }
  for (const file of ['scripts/test-runtime-flags.test.mjs', 'missing.test.mjs', 'web/app/api/[id]/route.test.ts']) {
    assert.throws(() => validateForwardedOptions([file]), /does not accept positional filenames/)
    const result = spawnSync(process.execPath, ['scripts/test-suite.mjs', 'unit', '--test-concurrency=1', file], {
      encoding: 'utf8', timeout: 10000, env: { ...process.env, OPENBOOKS_DB_URL: 'test-selection-refusal-only' },
    })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /does not accept positional filenames[\s\S]*--test-concurrency=1 <file>/)
    assert.equal(result.stdout, '')
  }
})
