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
const { withSimClock: pinClock } = await import('@openbooks/engine/src/platform/clock.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { postDocument } = await import('@openbooks/engine/src/ledger/posting.ts')
const { customerStrings } = await import('./customer-strings.ts')
const { customerData } = await import('./customer-data.ts')

function catalogTranslator(locale: string) {
  const analytics = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'messages', locale, 'analytics.json'), 'utf8'),
  )
  const t = createTranslator({ locale, messages: { analytics }, namespace: 'analytics' })
  return (key: string, values?: Record<string, string | number>): string =>
    t(key, values as Record<string, string | number | Date>)
}

/**
 * One customer owning all revenue is a concentrated book (HHI 10000): the
 * concentration insight fires, and a single-transaction customer carries the
 * "single transaction" churn factor. Both must render in the request locale.
 */
test('customer insights and churn factors render in the request locale', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Customer Controller', 'admin'))
    await withBypass(async () => {
      const id = randomUUID()
      await db.execute(sql`insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
         currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${id}, ${scratch.orgId}, 'customer_invoice', 'draft', ${id}, ${scratch.subsidiaryId},
          ${scratch.customerId}, '2026-07-02', 'CAD', '1', 100, 0, 100, ${actor})`)
      await db.execute(sql`insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
        values (${scratch.orgId}, ${id}, 1, ${scratch.accounts.revenue}, 1, 100, 100, 0, 100)`)
      await db.execute(sql`update documents set status = 'approved' where id = ${id}`)
      await postDocument(id, { control: { ar: scratch.accounts.ar, ap: scratch.accounts.ap, bank: scratch.accounts.bank } })
    })
    const P = { from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }
    await pinClock('2026-07-15', async () => {
      const fallback = await withOrgContext(scratch.orgId, () => customerData(P, scratch.orgId, null))
      const concentration = fallback.insights.find((i) => i.category === 'concentration')
      assert.equal(concentration?.title, 'Revenue Concentration Risk')
      assert.ok(fallback.rows[0]?.churnFactors.includes('Single transaction customer'))
      assert.equal(fallback.intelligence.label, 'Needs Attention')

      const fr = await withOrgContext(scratch.orgId, () => customerData(P, scratch.orgId, null, customerStrings(catalogTranslator('fr'), 'fr')))
      const frConcentration = fr.insights.find((i) => i.category === 'concentration')
      assert.equal(frConcentration?.title, "Risque de concentration du chiffre d'affaires")
      assert.ok(fr.rows[0]?.churnFactors.includes('Client à transaction unique'))
      assert.equal(fr.intelligence.label, "Nécessite de l'attention")
      assert.equal(fr.intelligence.grade, fallback.intelligence.grade)
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
