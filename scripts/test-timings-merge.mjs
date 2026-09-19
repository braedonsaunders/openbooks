// Merges the per-shard timing records produced by
// scripts/test-timings-reporter.mjs into the single scripts/test-timings.json
// that drives shard packing.
//
//   gh run download <run-id> -D evidence
//   node scripts/test-timings-merge.mjs evidence
//
// Recalibration is a deliberate, reviewable commit rather than something CI
// mutates behind the author: a change in shard membership changes which
// database a test runs against, and that should show up in a diff.

import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { testManifest } from './test-suite.mjs'

const ROOT = resolve(new URL('..', import.meta.url).pathname)
const OUTPUT = resolve(ROOT, 'scripts/test-timings.json')

const [root = 'evidence'] = process.argv.slice(2)
const records = globSync('**/test-timings.json', { cwd: resolve(ROOT, root), nodir: true })
if (records.length === 0) throw new Error(`no test-timings.json found under ${root}`)

// Keep the slowest observation for a file seen more than once. A shard that
// happened to run warm should not talk the packer into underweighting a file.
const merged = new Map()
for (const record of records) {
  const parsed = JSON.parse(readFileSync(resolve(ROOT, root, record), 'utf8'))
  for (const [file, duration] of Object.entries(parsed.files ?? {})) {
    if (typeof duration !== 'number' || !(duration > 0)) continue
    merged.set(file, Math.max(merged.get(file) ?? 0, Math.round(duration)))
  }
}

// Drop files that no longer exist so the record cannot accumulate ghosts, and
// report what CI measured against what the manifest expects.
const manifest = testManifest()
const expected = new Set([...manifest.unit, ...manifest.integration])
const files = {}
for (const file of [...merged.keys()].sort()) {
  if (existsSync(resolve(ROOT, file))) files[file] = merged.get(file)
}

const missing = [...expected].filter((file) => !(file in files))
writeFileSync(OUTPUT, `${JSON.stringify({ measuredAt: new Date().toISOString(), files }, null, 2)}\n`)

const total = Object.values(files).reduce((sum, duration) => sum + duration, 0)
console.log(`merged ${records.length} shard records -> ${Object.keys(files).length} files, ${(total / 1000).toFixed(0)}s measured`)
if (missing.length > 0) {
  console.log(`${missing.length} manifest files carry no measurement and will be charged the median:`)
  for (const file of missing.slice(0, 20)) console.log(`  ${file}`)
  if (missing.length > 20) console.log(`  ... and ${missing.length - 20} more`)
}
