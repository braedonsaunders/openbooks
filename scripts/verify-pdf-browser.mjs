import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { version } = JSON.parse(readFileSync(new URL('./pdf-browser.json', import.meta.url), 'utf8'))
const executable = process.env.PUPPETEER_EXECUTABLE_PATH
if (!executable) throw new Error('Set PUPPETEER_EXECUTABLE_PATH before verifying the production PDF renderer.')
const actual = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()
if (!actual.split(/\s+/).includes(version)) throw new Error(`PDF renderer version mismatch: expected ${version}, received ${actual}.`)
const directory = mkdtempSync(join(tmpdir(), 'openbooks-pdf-proof-'))
try {
  const html = join(directory, 'document.html')
  const pdf = join(directory, 'document.pdf')
  writeFileSync(html, '<!doctype html><meta charset="utf-8"><title>PDF verification</title><h1>OpenBooks</h1><p>Payroll · Benefits · 日本語 · français</p>')
  // Image builds have no user namespaces. Runtime launch retains the shared
  // browser pool's sandbox policy; this isolated build probe holds no secrets.
  execFileSync(executable, [
    '--headless', '--no-sandbox', '--disable-dev-shm-usage', '--no-pdf-header-footer',
    `--user-data-dir=${join(directory, 'profile')}`, `--print-to-pdf=${pdf}`, pathToFileURL(html).href,
  ], { timeout: 30_000, stdio: 'pipe' })
  const bytes = readFileSync(pdf)
  if (bytes.length < 1_000 || bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('Production PDF renderer did not produce a valid PDF.')
  console.log(`Production PDF rendering verified: ${actual}, ${bytes.length} bytes.`)
} finally {
  rmSync(directory, { recursive: true, force: true })
}
