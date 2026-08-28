import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(webRoot, 'lib/crm.ts'), 'utf8')

test('team forecast actuals only include invoices linked to that sales team', () => {
  const filterStart = source.indexOf('const actualsTeamFilter')
  const rowsStart = source.indexOf('const rows =', filterStart)
  assert.ok(filterStart >= 0 && rowsStart > filterStart, 'team actuals filter is defined before the query')
  const filter = source.slice(filterStart, rowsStart)

  assert.match(filter, /scope\.salesTeamId \? sql`[\s\S]*crm_opportunity_documents od/)
  assert.match(filter, /od\.document_id = d\.id/)
  assert.match(filter, /o\.sales_team_id = \$\{scope\.salesTeamId\}/)
  assert.match(filter, /: sql``/)

  const actualsStart = source.indexOf('), actuals as', rowsStart)
  const currenciesStart = source.indexOf('), currencies as', actualsStart)
  assert.ok(actualsStart >= 0 && currenciesStart > actualsStart, 'actuals CTE is defined')
  assert.match(source.slice(actualsStart, currenciesStart), /\$\{actualsTeamFilter\}/)
})

test('owner forecast actuals retain account-owner filtering', () => {
  const actualsStart = source.indexOf('), actuals as')
  const currenciesStart = source.indexOf('), currencies as', actualsStart)
  assert.ok(actualsStart >= 0 && currenciesStart > actualsStart, 'actuals CTE is defined')
  const actuals = source.slice(actualsStart, currenciesStart)

  assert.match(actuals, /crm_account_profiles cp/)
  assert.match(actuals, /cp\.owner_user_id = \$\{scope\.ownerUserId\}/)
})
