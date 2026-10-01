import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

test('the production worker bundle loads deferred transfer dependencies before connecting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openbooks-worker-startup-'))
  try {
    await symlink(resolve('node_modules'), join(directory, 'node_modules'))
    const output = join(directory, 'worker.mjs')
    await build({
      entryPoints: ['scripts/worker-entry.mts'], outfile: output,
      bundle: true, platform: 'node', format: 'esm', conditions: ['react-server'],
      tsconfig: 'web/tsconfig.json', external: ['pg-native', 'jsdom'],
      banner: { js: "import { createRequire as openbooksCreateRequire } from 'node:module'; const require = openbooksCreateRequire(import.meta.url);" },
    })
    const program = `
      const entry = await import(${JSON.stringify(pathToFileURL(output).href)});
      const transfer = await entry.loadDataTransferWorker();
      if (typeof transfer.startDataTransferWorker !== 'function') throw new Error('Transfer startup did not load');
      console.log('Deferred transfer runtime verified');
    `
    const result = await promisify(execFile)(process.execPath,
      ['--max-old-space-size=512', '--conditions=react-server', '--input-type=module', '-e', program],
      { timeout: 15_000, env: { ...process.env, NODE_ENV: 'test', OPENBOOKS_DB_URL: '', OPENBOOKS_BYPASS_DB_URL: '' } })
    assert.match(result.stdout, /Deferred transfer runtime verified/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
