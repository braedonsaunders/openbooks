import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { createTranslator } from 'next-intl'

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })

const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { utilizationStrings } = await import('./utilization-strings.ts')
const { utilizationData } = await import('./utilization-data.ts')

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
 * All-non-billable hours with no item or department: billable % is 0, so the
 * below-target alert fires; the employee has no dominant labour class, so
 * the title falls back; history always carries the prior June label. The
 * loader keeps byte-identical English without a bundle and renders the
 * request locale with one.
 */
test('utilization alerts, titles and history render in the request locale', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const emp = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${emp}, ${org.orgId}, 'employee', 'Sam', ${org.subsidiaryId}, true, '{}'::jsonb)`)
      await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, status, is_billable, cost_rate, cost_rate_currency, cost_rate_subsidiary_id, custom)
        values (${randomUUID()}, ${org.orgId}, ${emp}, ${D}, '10.0000', 'approved', false, '50.0000', 'CAD', ${org.subsidiaryId}, '{}'::jsonb)`)
    })
    await withOrgContext(org.orgId, async () => {
      const fallback = await utilizationData(org.orgId, JULY, null)
      assert.deepEqual(fallback.company.alerts, [{ type: 'warning', message: 'Billable % below 70% target' }])
      assert.equal(fallback.employees[0]?.title, 'No Title')
      const june = fallback.history.periods[0]!
      assert.equal(june.label, "Jun '26")

      const fr = utilizationStrings(catalogTranslator('fr'), 'fr')
      const localized = await utilizationData(org.orgId, JULY, null, fr)
      assert.deepEqual(localized.company.alerts, [{ type: 'warning', message: 'Part facturable sous la cible de 70 %' }])
      assert.equal(localized.employees[0]?.title, 'Sans titre')
      assert.equal(localized.history.periods[0]?.label, "juin '26")
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
