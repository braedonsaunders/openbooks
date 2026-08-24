import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'

// records.ts composes the engine pool and server-only services; shim the
// marker package so the module graph loads for these pure/source-level pins
// (same seam technique as documents.test.ts).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const RECORDS_SOURCE = readFileSync(new URL('./records.ts', import.meta.url), 'utf8')
const PLATFORM_SOURCE = readFileSync(new URL('../apps/platform.ts', import.meta.url), 'utf8')
const { normalizeDocumentRecordRevisions } = await import('./records.ts')

test('application record reads scope documents rows by the resolved kind allowlist', () => {
  // baseWhere used to discriminate only when writer.kind === 'document', so a
  // documents-backed readonly type (payments) listed EVERY document kind in
  // the org. The resolved allowlist is now the single read fence.
  assert.match(
    RECORDS_SOURCE,
    /if \(scope\.resolved\.documentKinds\) \{\s*\n\s*conditions\.push\(sql`kind = any\(\$\{\[\.\.\.scope\.resolved\.documentKinds\]\}::text\[\]\)`\);/,
  )
  assert.doesNotMatch(
    RECORDS_SOURCE,
    /writer\.kind === "document"/,
    'the application layer never re-derives kinds from the writer shape',
  )
})

test('app platform reads scope documents rows by the same resolved allowlist', () => {
  assert.match(PLATFORM_SOURCE, /resolved\.documentKinds \? sql`and kind = any/)
  assert.doesNotMatch(
    PLATFORM_SOURCE,
    /writer\.kind === 'document' && conditions|conditions\.push\(sql`kind = \$\{resolved\.writer\.docKind\}`\)/,
  )
})

test('document-backed record payloads keep their exact persisted revision', () => {
  const lossy = new Date('2026-08-24T12:34:56.123Z')
  const exact = '2026-08-24T12:34:56.123456Z'
  const [record] = normalizeDocumentRecordRevisions('documents', [{
    id: '00000000-0000-4000-8000-000000000001',
    updated_at: lossy,
    __documentRevision: exact,
  }])
  assert.equal(record?.updated_at, exact)
  assert.equal('__documentRevision' in (record ?? {}), false)
})
