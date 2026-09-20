import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../../', import.meta.url))
const flags = ['--no-concurrent-sparkplug', '--no-concurrent-recompilation']

for (const failure of ['create-refusal', 'seed-refusal', 'drop-refusal']) {
  test(`migration fixture closes real maintenance sockets after ${failure}`, { timeout: 15_000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'openbooks-fixture-cleanup-'))
    const record = join(directory, 'calls.txt')
    const sockets = new Set()
    const server = createServer(socket => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    t.after(async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
      rmSync(directory, { recursive: true, force: true })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    // Only database IO is doubled. Connections are real local sockets so a
    // missing end() actually keeps the child alive, rather than merely missing
    // a mock-method assertion. No real database is contacted or created.
    const pgSource = `
      import { createConnection } from 'node:net';
      import { appendFileSync } from 'node:fs';
      const log = value => appendFileSync(process.env.CLEANUP_RECORD, value + '\\n');
      class Client {
        constructor(options) { this.name = new URL(options.connectionString).pathname; }
        async connect() {
          this.socket = createConnection({host:'127.0.0.1', port:Number(process.env.CLEANUP_PORT)});
          await new Promise((resolve,reject) => {this.socket.once('connect',resolve);this.socket.once('error',reject)});
          log('connect ' + this.name);
        }
        async query(sql) {
          if (sql.startsWith('create database')) {
            log('create');
            if (process.env.CLEANUP_FAILURE !== 'create-refusal') return {rows:[]};
            const error = new Error('permission denied to create database'); error.code='42501'; throw error;
          }
          if (sql.startsWith('drop database')) {
            log('drop');
            if (process.env.CLEANUP_FAILURE === 'drop-refusal') throw new Error('drop refused');
            return {rows:[]};
          }
          throw new Error('seed refused');
        }
        async end() {
          log('end ' + this.name);
          await new Promise(resolve => {this.socket.once('close',resolve);this.socket.end()});
        }
      }
      export default { Client };
    `
    const loader = join(directory, 'loader.mjs')
    writeFileSync(loader, `import { registerHooks } from 'node:module';
      registerHooks({resolve(specifier, context, next) {
        if(specifier==='pg') return {shortCircuit:true,url:${JSON.stringify('data:text/javascript,' + encodeURIComponent(pgSource))}};
        return next(specifier,context);
      }});`)
    const env = { ...process.env, NODE_ENV: 'test',
      OPENBOOKS_DB_URL: 'postgres://probe:probe@127.0.0.1/probe',
      OPENBOOKS_TEST_ADMIN_DB_URL: 'postgres://probe:probe@127.0.0.1/probe',
      CLEANUP_PORT: String(server.address().port), CLEANUP_RECORD: record, CLEANUP_FAILURE: failure,
    }
    delete env.NODE_TEST_CONTEXT
    const child = spawn(process.execPath, [...flags, '--import', 'tsx', '--import', loader,
      '--test', 'schema/src/bank-statement-source-evidence.integration.test.ts'], {
      cwd: root, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = '', timedOut = false
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const killOwnedGroup = () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5_000, stdio: 'ignore' })
        else process.kill(-child.pid, 'SIGKILL')
      } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    const deadline = setTimeout(() => { timedOut = true; killOwnedGroup() }, 8_000)
    let status
    try {
      status = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
    } finally { clearTimeout(deadline); killOwnedGroup() }
    assert.equal(timedOut, false, `fixture failed to close its sockets: ${output}`)
    assert.equal(status, 1, 'the original setup refusal must still fail the test run')
    assert.match(output, failure === 'create-refusal' ? /permission denied to create database/ : /seed refused/)
    const calls = readFileSync(record, 'utf8').trim().split('\n')
    assert.equal(calls.filter(call => call.startsWith('end ')).length, failure === 'create-refusal' ? 1 : 2)
    assert.equal(calls.includes('drop'), failure !== 'create-refusal', 'drop only a database whose creation succeeded')
    if (failure === 'drop-refusal') assert.match(output, /setup and cleanup failed/)
  })
}
