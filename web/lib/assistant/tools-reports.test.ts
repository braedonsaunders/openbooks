import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./tools-reports.ts', import.meta.url), 'utf8')

test('assistant report calls carry the authorization subsidiary dimensions', () => {
  assert.match(source, /function reportDims\(authz: Authz\)/)
  assert.match(source, /if \(authz\.allowedSubsidiaryIds === null\) return undefined/)
  assert.match(source, /return \{ subsidiaryIds: \[\.\.\.authz\.allowedSubsidiaryIds\] \}/)
  assert.equal(
    source.split('reportDims(authz)').length - 1,
    4,
    'general ledger, aging, cash flow, and partner statement each receive the scope',
  )
  assert.equal(
    source.split('reportScopeDenied(authz)').length - 1,
    4,
    'each direct assistant report denies an empty restricted scope before querying',
  )
})

test('run_report denies every restricted scope before its generic resolver can widen visibility', () => {
  const runReport = source.slice(source.indexOf('const runReport:'), source.indexOf('const generalLedgerTool:'))
  assert.match(runReport, /if \(authz\.allowedSubsidiaryIds !== null\) return \{ ok: false, error: "forbidden" \}/)
  assert.ok(
    runReport.indexOf('authz.allowedSubsidiaryIds !== null') < runReport.indexOf('const def = (await db.execute'),
    'the restricted-scope denial must precede the definition lookup',
  )
})
