import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { TEST_RUNTIME_FLAGS } from './test-suite.mjs'

const expected = ['--no-concurrent-sparkplug', '--no-concurrent-recompilation']
test('test compiler shutdown mitigation is identical across platforms, including Linux CI', () => {
  for (const platform of ['linux', 'darwin', 'win32', 'freebsd']) {
    const source = `
      Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
      const { TEST_RUNTIME_FLAGS } = await import(${JSON.stringify(new URL('./test-suite.mjs', import.meta.url).href)});
      process.stdout.write(JSON.stringify(TEST_RUNTIME_FLAGS));
    `
    const result = spawnSync(process.execPath, [...expected, '--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), expected, platform)
  }
})

test('the runtime accepts both compiler flags without disabling forced test exit', () => {
  const result = spawnSync(process.execPath, [...TEST_RUNTIME_FLAGS, '--test-force-exit', '-e', 'process.stdout.write(JSON.stringify(process.execArgv))'], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(result.status, 0, result.stderr)
  for (const flag of [...expected, '--test-force-exit']) assert.ok(JSON.parse(result.stdout).includes(flag), flag)
})
