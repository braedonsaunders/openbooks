import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// Match the canonical runner's macOS shutdown mitigation in both generations.
const runtimeFlags = process.platform === 'darwin' ? ['--no-concurrent-sparkplug', '--no-concurrent-recompilation'] : []

async function runProbe(t, args, env, timeoutMs = 12_000) {
  const child = spawn(process.execPath, [...runtimeFlags, ...args], {
    env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = '', spawnError
  child.stdout.on('data', (data) => { stdout += data })
  child.stderr.on('data', (data) => { stderr += data })
  child.on('error', (error) => { spawnError = error })
  const closed = new Promise((resolve) => child.once('close', (code) => resolve(code)))
  const killGroup = () => {
    if (!child.pid) return
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5_000 })
    } else {
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  }
  const timer = setTimeout(killGroup, timeoutMs)
  t.signal.addEventListener('abort', killGroup, { once: true })
  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    clearTimeout(timer)
    t.signal.removeEventListener('abort', killGroup)
    killGroup()
    await closed
  }
  t.after(cleanup)
  try {
    const code = await closed
    if (spawnError) throw spawnError
    return { code, stdout, stderr }
  } finally {
    await cleanup()
  }
}

test('forced worker shutdown preserves every test event and final failure under output pressure', { timeout: 30_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'openbooks-test-output-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const files = Array.from({ length: 8 }, (_, i) => join(directory, `${i}.test.mjs`))
  for (const [index, file] of files.entries()) writeFileSync(file, `
    import { test } from 'node:test';
    for (let i = 0; i < 200; i++) test('case-' + i + '-' + 'x'.repeat(1500), () => {
      if (${index} === 7 && i === 199 && process.env.DRAIN_PROBE_FAILURE === '1') throw new Error('last case failed');
    });
  `)
  const runner = join(directory, 'run.mjs')
  writeFileSync(runner, `
    import { run } from 'node:test';
    import { writeSync } from 'node:fs';
    let pass = 0, fail = 0; const plans = [];
    const events = run({ files: ${JSON.stringify(files)}, forceExit: true, concurrency: 4,
      execArgv: ${JSON.stringify([...runtimeFlags, '--import', new URL('./test-output-drain.mjs', import.meta.url).href])} });
    for await (const event of events) {
      if (event.type === 'test:pass') pass++;
      if (event.type === 'test:fail') fail++;
      if (event.type === 'test:plan') plans.push(event.data.count);
    }
    writeSync(1, JSON.stringify({ pass, fail, plans }));
    process.exitCode = fail ? 1 : 0;
  `)
  for (const failure of [false, true]) {
    const env = { ...process.env, NODE_ENV: 'test', DRAIN_PROBE_FAILURE: failure ? '1' : '0' }
    delete env.NODE_TEST_CONTEXT
    const { code, stdout, stderr } = await runProbe(t, [runner], env)
    assert.equal(code, failure ? 1 : 0, stderr)
    assert.deepEqual(JSON.parse(stdout), { pass: failure ? 1599 : 1600, fail: failure ? 1 : 0, plans: [1600] })
  }
})

test('draining preserves exit status and fails closed on broken or blocked output', { timeout: 20_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'openbooks-test-exit-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const env = { ...process.env, NODE_ENV: 'test' }
  delete env.NODE_TEST_CONTEXT
  const cases = [
    { name: 'success', code: "process.stdout.write('x'.repeat(100000)); process.stderr.write('y'.repeat(100000)); process.exit(0)", status: 0, out: 100000, err: 100000 },
    { name: 'failure', code: "process.stdout.write('x'.repeat(100000)); process.exit(7)", status: 7, out: 100000, err: 0 },
    { name: 'repeated upgrade', code: 'process.exit(0); process.exit(7)', status: 7, out: 0, err: 0 },
    { name: 'repeated preservation', code: 'process.exit(7); process.exit(0)', status: 7, out: 0, err: 0 },
    { name: 'broken output', code: "process.stdout.write = (_chunk, callback) => { callback(new Error('broken')); return false }; process.exit(0)", status: 1, out: 0, err: 0 },
    { name: 'blocked output', code: 'process.stdout.write = () => true; process.exit(0)', status: 1, out: 0, err: 0 },
  ]
  for (const probe of cases) {
    const file = join(directory, `${probe.name}.mjs`)
    writeFileSync(file, probe.code)
    const { code: status, stdout, stderr } = await runProbe(t, ['--import', new URL('./test-output-drain.mjs', import.meta.url).href, '--test-force-exit', file], env)
    const out = Buffer.byteLength(stdout), err = Buffer.byteLength(stderr)
    assert.deepEqual({ status, out, err }, { status: probe.status, out: probe.out, err: probe.err }, probe.name)
  }
})
