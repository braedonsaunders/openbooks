import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createTranslator } from 'next-intl'

const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { trueCostStrings } = await import('./true-cost-strings.ts')
const { trueCostData } = await import('./true-cost-data.ts')

function catalogTranslator(locale: string) {
  const analytics = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'messages', locale, 'analytics.json'), 'utf8'),
  )
  const t = createTranslator({ locale, messages: { analytics }, namespace: 'analytics' })
  return (key: string, values?: Record<string, string | number>): string =>
    t(key, values as Record<string, string | number | Date>)
}

const D = '2026-07-14'
const JULY = { from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }

/**
 * One department with billed + non-billable hours: the native time category
 * exists, the July month label renders, and the untouched org carries the
 * seeded default profile using the request locale.
 */
test('true cost names and month labels render in the request locale', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const dept = randomUUID()
    const emp = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`insert into departments (id, org_id, name, is_active, custom)
        values (${dept}, ${org.orgId}, 'Ops', true, '{}'::jsonb)`)
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${emp}, ${org.orgId}, 'employee', 'Sam', ${org.subsidiaryId}, true, '{}'::jsonb)`)
      await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, status, is_billable, department_id, cost_rate, cost_rate_currency, cost_rate_subsidiary_id, custom)
        values (${randomUUID()}, ${org.orgId}, ${emp}, ${D}, '10.0000', 'approved', true, ${dept}, '50.0000', 'CAD', ${org.subsidiaryId}, '{}'::jsonb),
               (${randomUUID()}, ${org.orgId}, ${emp}, ${D}, '10.0000', 'approved', false, ${dept}, '50.0000', 'CAD', ${org.subsidiaryId}, '{}'::jsonb)`)
    })
    await withOrgContext(org.orgId, async () => {
      const fr = trueCostStrings(catalogTranslator('fr'), 'fr', 'CAD')
      const localized = await trueCostData(org.orgId, JULY, null, fr)
      const timeCatFr = localized.categories.find((c) => c.key === 'nonbillable_time')!
      assert.equal(timeCatFr.name, 'Temps non facturable')
      assert.equal(localized.monthly[0]?.label, "juil. '26")
      assert.equal(localized.config.profiles[0]?.name, 'Par défaut')
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

/**
 * Every composite-level refusal renders in all seven locales: the message
 * carries the real category and department names (never UUIDs) and
 * translated rate-format labels (never raw enum keys like `per_hour`).
 */
test('true cost refusals render translated names and format labels in every locale', () => {
  const RAW_FORMAT_KEYS = ['per_hour', 'percent_labor', 'percent_cost', 'per_fte', 'per_unit']
  for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'pt-BR', 'zh']) {
    const strings = trueCostStrings(catalogTranslator(locale), locale, 'CAD')
    const messages = [
      strings.refusalMixedUnits(
        [strings.rateFormatLabel('per_hour'), strings.rateFormatLabel('percent_labor')].join(', '),
        '"Office rent", "Wages"',
      ),
      strings.refusalCascadingNoLabor(),
      strings.refusalCascadingNoLaborDept('Atelier'),
      strings.refusalPerFteNoHours('Office rent'),
      strings.refusalPerFteNoHoursDept('Office rent', 'Atelier'),
      strings.refusalMissingBase('Office rent', strings.rateFormatLabel('per_hour'), strings.allocationBaseLabel('labor_dollars')),
      strings.refusalFormulaReference('Markup', 'cat.typo'),
      strings.refusalFormulaNegative('Markup', '-5.0000'),
      strings.refusalUnreadableAmount('Office rent'),
    ]
    assert.equal(messages.length, 9)
    for (const message of messages) {
      assert.ok(message.length > 0, `${locale}: refusal must render`)
      assert.ok(!message.includes('{') && !message.includes('undefined'), `${locale}: no unfilled slots: ${message}`)
      for (const raw of RAW_FORMAT_KEYS) assert.ok(!message.includes(raw), `${locale}: raw enum key leaks: ${message}`)
    }
    assert.ok(messages[0]!.includes('Office rent'), `${locale}: mixed-unit refusal names the categories`)
    assert.ok(messages[3]!.includes('Office rent'), `${locale}: per-FTE refusal names the category`)
    assert.ok(messages[4]!.includes('Atelier'), `${locale}: department refusal names the department`)
  }
})
