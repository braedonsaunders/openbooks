import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import {
  subsidiaryReadFilter,
  subsidiaryReadFilterWithUnassigned,
} from '../../../../lib/data-io/subsidiary-scope.ts'

const route = await readFile(new URL('./route.ts', import.meta.url), 'utf8')
const resources = await readFile(new URL('../../../../lib/data-io/resources.ts', import.meta.url), 'utf8')
const transactions = await readFile(new URL('../../../../lib/data-io/transaction-resources.ts', import.meta.url), 'utf8')

// Render a drizzle SQL fragment to its inline text: strings verbatim,
// nested fragments recursively, bound params by value.
function renderChunks(node: unknown): string {
  const chunks = (node as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk
      if (chunk && typeof chunk === 'object' && 'value' in chunk) {
        return String((chunk as { value?: unknown }).value ?? '')
      }
      return renderChunks(chunk)
    })
    .join('')
}

test('generic export binds the caller subsidiary scope before reading a resource', () => {
  // Regression: before this binding, the route passed only orgId to
  // getResource and transaction reads returned every subsidiary's documents.
  assert.match(
    route,
    /getResource\(authz\.user\.orgId, resourceKey, authz\.allowedSubsidiaryIds\)/,
  )
  assert.match(route, /resource\.read\(\{\s*allowedSubsidiaryIds: authz\.allowedSubsidiaryIds/)
  assert.match(resources, /function bindReadScope\(/)
  assert.match(resources, /resource\.read\(\{ allowedSubsidiaryIds: effectiveScope \}\)/)
  assert.match(transactions, /transactionSubsidiaryFilter\(subsidiaryScope\)/)
})

test('unrestricted exports remain a pass-through while restricted scopes fail closed', () => {
  // Happy path: null is the explicit unrestricted sentinel; an empty
  // allow-list must become `and false`, never an unscoped query. This
  // exercises the real shared helper, not a copy of its source.
  assert.match(resources, /if \(effectiveScope === null\) return result/)
  assert.match(
    resources,
    /subsidiaryReadFilter\(sql`p\.subsidiary_id`, scope\)/,
  )
  assert.equal(renderChunks(subsidiaryReadFilter(sql`subsidiary_id`, null)), '')
  assert.equal(renderChunks(subsidiaryReadFilterWithUnassigned(sql`subsidiary_id`, undefined)), '')
  assert.match(
    renderChunks(subsidiaryReadFilter(sql`subsidiary_id`, new Set())),
    /and false/,
  )
  assert.match(
    renderChunks(subsidiaryReadFilterWithUnassigned(sql`subsidiary_id`, new Set())),
    /and false/,
  )
  assert.match(
    renderChunks(
      subsidiaryReadFilter(sql`subsidiary_id`, new Set(['00000000-0000-4000-8000-000000000001'])),
    ),
    /= any\(/,
  )
})
