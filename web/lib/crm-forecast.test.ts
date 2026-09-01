import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(webRoot, 'lib/crm.ts'), 'utf8')
const forecast = source.slice(source.indexOf('export async function calculateForecast'))
const teamActualsStart = forecast.indexOf('const teamActualsFilter')
const rowsStart = forecast.indexOf('const rows =', teamActualsStart)
const teamActuals = forecast.slice(teamActualsStart, rowsStart)
const actualsStart = forecast.indexOf('), actuals as')
const currenciesStart = forecast.indexOf('), currencies as', actualsStart)
const actuals = forecast.slice(actualsStart, currenciesStart) + teamActuals

test('team-only forecast reuses one team opportunity boundary for pipeline and actuals', () => {
  assert.match(
    forecast,
    /const teamScopeFilter = scope\.salesTeamId \? sql`and o\.sales_team_id = \$\{scope\.salesTeamId\}` : sql``/,
  )
  assert.match(forecast, /with forecast_scope as \([\s\S]*\$\{teamScopeFilter\}[\s\S]*\), opportunity_base as/)
  assert.match(forecast, /from crm_opportunities o\s+join forecast_scope fo on fo\.id = o\.id/)
  assert.match(actuals, /join forecast_scope fo on fo\.id = od\.opportunity_id/)
})

test('no-team forecast leaves the shared team boundary unrestricted', () => {
  assert.match(forecast, /const teamScopeFilter = scope\.salesTeamId \? [\s\S]* : sql``/)
  assert.match(forecast, /const teamActualsFilter = scope\.salesTeamId \? [\s\S]* : sql``/)
  assert.match(actuals, /\$\{teamActualsFilter\}/)
})

test('cross-team actuals require a document link to an opportunity in the selected team', () => {
  assert.match(actuals, /from crm_opportunity_documents od/)
  assert.match(actuals, /od\.document_id = d\.id/)
  assert.match(actuals, /where od\.org_id = \$\{scope\.orgId\}/)
  assert.doesNotMatch(actuals, /d\.org_id = \$\{scope\.orgId\}[\s\S]*sales_team_id/)
})

test('unrestricted/admin forecasts retain organization and currency boundaries', () => {
  assert.match(forecast, /where o\.org_id = \$\{scope\.orgId\}/)
  assert.match(actuals, /where d\.org_id = \$\{scope\.orgId\} and d\.kind = 'customer_invoice'/)
  assert.match(actuals, /coalesce\(sum\(d\.total\), 0\)::numeric\(19,4\) as closed_amount/)
  assert.match(actuals, /group by d\.currency/)
  assert.match(forecast, /left join actuals a on a\.currency = c\.currency/)
  assert.match(forecast, /coalesce\(sum\(o\.projected_amount\)[\s\S]*\)::text as pipeline_amount/)
})

test('owner forecast actuals retain account-owner filtering', () => {
  assert.match(actuals, /crm_account_profiles cp/)
  assert.match(actuals, /cp\.owner_user_id = \$\{scope\.ownerUserId\}/)
})
