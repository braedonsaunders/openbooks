import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(webRoot, 'lib/crm.ts'), 'utf8')
const forecast = source.slice(source.indexOf('export async function calculateForecast'))
const teamActuals = forecast.slice(forecast.indexOf('const teamActualsFilter'), forecast.indexOf('const rows ='))
const actuals = forecast.slice(forecast.indexOf('), actuals as'), forecast.indexOf('), currencies as')) + teamActuals

test('team-only forecast reuses one team opportunity boundary for pipeline and actuals', () => {
  assert.match(
    forecast,
    /const teamScopeFilter = scope\.salesTeamId \? sql`and o\.sales_team_id = \$\{scope\.salesTeamId\}` : sql``/,
  )
  assert.match(forecast, /with forecast_scope as \([\s\S]*\$\{teamScopeFilter\}[\s\S]*\), opportunity_base as/)
  assert.match(forecast, /from crm_opportunities o\s+join forecast_scope fo on fo\.id = o\.id/)
  assert.match(actuals, /join forecast_scope fo on fo\.id = od\.opportunity_id/)
})

test('the credit-attribution helper is declared before the filters that interpolate it', () => {
  // Both filters build their SQL eagerly when their scope key is set, so a
  // helper declared after them throws a temporal-dead-zone ReferenceError on
  // exactly the scoped calls it exists for (seen as a 500 on team snapshots).
  const helperAt = forecast.indexOf('const creditAppliesToScopedInvoice')
  assert.ok(helperAt !== -1, 'expected the credit-attribution helper to exist')
  assert.ok(helperAt < forecast.indexOf('const teamActualsFilter'), 'helper must precede the team filter')
  assert.ok(helperAt < forecast.indexOf('const ownerActualsFilter'), 'helper must precede the owner filter')
})

test('no-team forecast leaves the shared team boundary unrestricted', () => {
  assert.match(
    forecast,
    /const teamScopeFilter = scope\.salesTeamId \? [\s\S]* : sql``/,
  )
  assert.match(
    forecast,
    /const teamActualsFilter = scope\.salesTeamId \? [\s\S]* : sql``/,
  )
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
  assert.match(actuals, /where d\.org_id = \$\{scope\.orgId\} and d\.kind in \('customer_invoice', 'customer_credit'\)/)
  assert.match(actuals, /coalesce\(sum\(case when d\.kind = 'customer_invoice' then d\.subtotal else -d\.subtotal end\), 0\)::numeric\(19,4\) as closed_amount/)
  assert.match(actuals, /group by d\.currency/)
  assert.match(forecast, /left join actuals a on a\.currency = c\.currency/)
  assert.match(forecast, /coalesce\(sum\(o\.projected_amount\)[\s\S]*\)::text as pipeline_amount/)
})
