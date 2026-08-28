import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import nodeTest from 'node:test'

// The repository's broad Node test command also discovers this file, while
// the focused compliance gate uses Vitest. Load Vitest only in its runner so
// the normal Node suite does not acquire a new runtime dependency.
const vitest = process.env.VITEST ? await import('vitest') : null
const describe = vitest?.describe ?? nodeTest
const it = vitest?.it ?? nodeTest

const route = readFileSync(fileURLToPath(new URL('./route.ts', import.meta.url)), 'utf8')

describe('information-return authorization boundaries', () => {
  it('passes the authenticated subsidiary scope through reads and writes', () => {
    assert.match(route, /loadFilings\(gate\.user\.orgId,\s*gate\.allowedSubsidiaryIds\)/)
    assert.match(route, /guardSubsidiaryScope\(gate,\s*subsidiaryId\)/)
    assert.match(route, /select id[\s\S]*from subsidiaries[\s\S]*org_id = \$\{orgId\}/)
    assert.match(route, /if \(!subsidiary\) return NextResponse\.json\(\{ error: 'not found' \}, \{ status: 404 \}\)/)
  })

  it('rejects malformed IDs instead of converting them to an org-wide filing', () => {
    assert.match(route, /hasOwnProperty\.call\(body, 'subsidiaryId'\)/)
    assert.match(route, /subsidiaryId must be a valid UUID/)
    assert.doesNotMatch(route, /body\.subsidiaryId && isUuid\(body\.subsidiaryId\) \? body\.subsidiaryId : null/)
  })

  it('refuses incomplete current-year filings', () => {
    assert.match(route, /if \(taxYear >= Number\(\(await businessToday\(orgId\)\)\.slice\(0, 4\)\)\)/)
  })
})
