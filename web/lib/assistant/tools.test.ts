import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const tools = readFileSync(new URL('./tools.ts', import.meta.url), 'utf8')
const data = readFileSync(new URL('../data.ts', import.meta.url), 'utf8')

test('assistant journal search carries the caller subsidiary scope into every ledger query', () => {
  assert.match(tools, /import \{ subsidiaryVisibleFilter \} from "\.\.\/subsidiaries"/)
  assert.match(tools, /sql`e\.subsidiary_id`[\s\S]*authz\.allowedSubsidiaryIds/)
  assert.match(tools, /sql`l\.subsidiary_id`[\s\S]*authz\.allowedSubsidiaryIds/)
  assert.match(tools, /where = sql`e\.org_id = \$\{authz\.user\.orgId\}\$\{entrySubsidiaryFilter\}`/)
  assert.match(tools, /l\.org_id = e\.org_id\$\{lineSubsidiaryFilter\}/)
})

test('assistant journal detail scopes both the header and returned lines', () => {
  assert.match(data, /export async function entryDetail\([\s\S]*allowedSubsidiaryIds: ReadonlySet<string> \| null = null/)
  assert.match(data, /sql`e\.subsidiary_id`[\s\S]*allowedSubsidiaryIds/)
  assert.match(data, /sql`l\.subsidiary_id`[\s\S]*allowedSubsidiaryIds/)
  assert.match(data, /e\.org_id = \$\{orgId\}\$\{entrySubsidiaryFilter\}/)
  assert.match(data, /l\.org_id = \$\{orgId\}\$\{lineSubsidiaryFilter\}/)
  assert.match(tools, /entryDetail\(authz\.user\.orgId, a\.entryId, authz\.allowedSubsidiaryIds\)/)
})

test('assistant financial tools keep canonical money strings', () => {
  assert.match(tools, /function money\(v: unknown\): string/)
  assert.match(tools, /remaining: money\(item\.remaining\)/)
  assert.match(tools, /netChange: money\(r\.netChange\)/)
  assert.doesNotMatch(tools, /remaining: num\(item\.remaining\)/)
  assert.doesNotMatch(tools, /openingCash: num\(r\.openingCash\)/)
  assert.doesNotMatch(tools, /totalDebits: num\(r\.total_debits\)/)
})
