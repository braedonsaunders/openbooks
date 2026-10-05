#!/usr/bin/env node
/**
 * Write `web/lib/page-registry.ts` from the pages themselves.
 *
 * Run after adding, moving or renaming a page:
 *   node scripts/generate-page-registry.mjs
 *
 * The parsing lives in `./page-registry-source.mjs` so the drift test can
 * reuse it without regenerating the file it is checking.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describeView, findViews, generate } from './page-registry-source.mjs'

const ROOT = process.cwd()
const APP_DIR = join(ROOT, 'web', 'app', '(app)')
const OUT = join(ROOT, 'web', 'lib', 'page-registry.ts')

const views = findViews(APP_DIR).map((file) => describeView(file, readFileSync(file, 'utf8')))
const seen = new Map()
for (const view of views) {
  for (const mount of view.routes) {
    if (seen.has(mount.route)) {
      throw new Error(`two pages declare route ${mount.route}: ${seen.get(mount.route)} and ${view.spec}`)
    }
    seen.set(mount.route, view.spec)
  }
}
views.sort((a, b) => a.route.localeCompare(b.route))
writeFileSync(OUT, generate(views))
console.log(`wrote ${relative(ROOT, OUT)} — ${seen.size} routes from ${views.length} views`)
