import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

const { version } = JSON.parse(readFileSync(new URL('./pdf-browser.json', import.meta.url), 'utf8'))
// Official archives have no distribution-package advisory metadata. Require
// the current stable browser in every release build so a superseded pinned
// renderer cannot disappear from OS vulnerability scanning and ship unnoticed.
const release = await fetch('https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json', { signal: AbortSignal.timeout(30_000) })
if (!release.ok) throw new Error(`Cannot verify the current stable PDF browser (${release.status}). Retry before publishing the image.`)
const stable = (await release.json()).channels?.Stable?.version
if (stable !== version) throw new Error(`Pinned PDF browser ${version} is not the current stable release (${stable ?? 'unknown'}). Update both official archive checksums and the version before publishing.`)
const executable = process.env.PUPPETEER_EXECUTABLE_PATH
if (!executable) throw new Error('Set PUPPETEER_EXECUTABLE_PATH before verifying the production PDF renderer.')
const actual = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()
if (!actual.split(/\s+/).includes(version)) throw new Error(`PDF renderer version mismatch: expected ${version}, received ${actual}.`)
const directory = mkdtempSync(join(tmpdir(), 'openbooks-pdf-proof-'))
try {
  const pdf = join(directory, 'document.pdf')
  // Image builds have no user namespaces. Runtime launch retains the shared
  // browser pool's sandbox policy; this isolated build probe holds no secrets.
  const browser = await puppeteer.launch({ executablePath: executable, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  try {
    const page = await browser.newPage()
    await page.setJavaScriptEnabled(false)
    await page.setContent('<!doctype html><meta charset="utf-8"><title>PDF verification</title><h1>OpenBooks</h1><p>Payroll · Benefits · 日本語 · français</p>')
    await page.pdf({ path: pdf, format: 'Letter', displayHeaderFooter: false })
  } finally {
    await browser.close()
  }
  const bytes = readFileSync(pdf)
  if (bytes.length < 1_000 || bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('Production PDF renderer did not produce a valid PDF.')
  execFileSync('qpdf', ['--check', pdf], { timeout: 10_000, stdio: 'pipe' })
  console.log(`Production PDF rendering verified: ${actual}, ${bytes.length} bytes.`)
} finally {
  rmSync(directory, { recursive: true, force: true })
}
