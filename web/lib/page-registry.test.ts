import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { describeView, findViews } from '../../scripts/page-registry-source.mjs'
import { PAGE_REGISTRY, PAGE_ROUTES } from './page-registry'

/**
 * `page-registry.ts` must describe the pages that actually exist.
 *
 * It is generated, and a generated file nobody regenerates is a file that
 * lies. The consequences are not cosmetic: an author asking to customize a new
 * page is told the route does not exist, and a page whose loader signature
 * changed gets called with its arguments in the wrong order — which returns a
 * confidently wrong layout rather than an error.
 *
 * So this re-derives the same facts from source using the generator's own
 * parser and compares. Sharing the parser is deliberate: a second
 * reimplementation here would test that two regexes agree, not that the
 * registry matches the app.
 *
 * Importing the registry is cheap despite its 165 entries — each module is a
 * lazy `import()` closure, and naming one does not load it. That is the same
 * property that lets a caller describe one route without pulling in the other
 * hundred and sixty-four.
 */

const APP_DIR = join(process.cwd(), 'web', 'app', '(app)')

const fromSource = findViews(APP_DIR).map((file: string) =>
  describeView(file, readFileSync(file, 'utf8')),
)

test('the source walk actually found the pages', () => {
  // Without this, a broken walk would make every comparison below pass by
  // comparing two empty lists.
  assert.ok(fromSource.length > 150, `only found ${fromSource.length} views`)
})

test('every page is in the registry, and nothing else is', () => {
  const expected = fromSource.map((view: { route: string }) => view.route).sort()
  assert.deepEqual([...PAGE_ROUTES], expected)
})

test('each entry records the loader inputs its page actually takes', () => {
  for (const view of fromSource as Array<{
    route: string
    segments: string[]
    searchParams: boolean
  }>) {
    const entry = PAGE_REGISTRY[view.route]
    assert.ok(entry, `missing registry entry for ${view.route}`)
    assert.deepEqual([...entry.segments], view.segments, `segments for ${view.route}`)
    assert.equal(entry.searchParams, view.searchParams, `searchParams for ${view.route}`)
  }
})

test('every required segment is one the route pattern names', () => {
  // A segment the url cannot supply is a page nothing can describe: the caller
  // has no way to learn what value to pass.
  for (const route of PAGE_ROUTES) {
    const declared = [...route.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1])
    for (const segment of PAGE_REGISTRY[route]!.segments) {
      assert.ok(declared.includes(segment), `${route} needs [${segment}], which it does not declare`)
    }
  }
})

test('the registry key and the entry agree on the route', () => {
  for (const [key, entry] of Object.entries(PAGE_REGISTRY)) {
    assert.equal(entry.route, key)
  }
})
