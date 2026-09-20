import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { createTranslator } from 'next-intl'
import type { Authz } from '../authz.ts'
import type { SessionUser } from '../auth.ts'

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })

const { sql } = await import('drizzle-orm')
const { db, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { sentinelStrings } = await import('./sentinel-strings.ts')
const { sentinelData } = await import('./sentinel-data.ts')

function catalogTranslator(locale: string) {
  const analytics = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'messages', locale, 'analytics.json'), 'utf8'),
  )
  const t = createTranslator({ locale, messages: { analytics }, namespace: 'analytics' })
  return (key: string, values?: Record<string, string | number>): string =>
    t(key, values as Record<string, string | number | Date>)
}

/**
 * Two identical vendor bills inside the duplicate window flag a duplicate
 * group. The flagged reason must render in the request locale, and conformity
 * must be a stable code (never translated text).
 */
test('sentinel flag reasons render in the request locale', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, 'Forensic reviewer', 'forensic_reviewer'))
    await withBypass(async () => {
      for (const [number, date] of [['DUP-1', '2026-07-02'], ['DUP-2', '2026-07-04']] as const) {
        const id = randomUUID()
        await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,party_id,subsidiary_id,currency,subtotal,tax_total,total)
          values (${id},${org.orgId},'vendor_bill',${number},${date},${org.vendorId},${org.subsidiaryId},'CAD',5000,0,5000)`)
        await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount)
          values (${org.orgId},${id},1,${org.accounts.cogs},1,5000,5000)`)
        await db.execute(sql`update documents set status='approved' where id=${id}`)
      }
    })
    const user: SessionUser = { id: actor, orgId: org.orgId, name: 'Forensic reviewer', email: 'forensics@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
    const authz: Authz = { user, permissions: new Set(['reports.read', 'admin.audit.read']), allowedSubsidiaryIds: null }
    await withOrgContext(org.orgId, async () => {
      const P = { from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }
      const fallback = await sentinelData(org.orgId, P, authz)
      const dup = fallback.flagged.find((f) => f.flagType === 'duplicate')
      assert.ok(dup, 'expected a flagged duplicate pair')
      assert.equal(dup.reason, '2 matching documents — same vendor, kind, amount (CAD 5000) (2 days span): DUP-2')
      assert.ok(['excellent', 'acceptable', 'marginal', 'nonConforming'].includes(fallback.benford1D.conformity))

      const fr = await sentinelData(org.orgId, P, authz, sentinelStrings(catalogTranslator('fr'), 'fr'))
      const frDup = fr.flagged.find((f) => f.flagType === 'duplicate')
      assert.equal(frDup?.reason, '2 documents correspondants — même fournisseur, nature et montant (CAD 5000) (écart de 2 jours) : DUP-2')
      assert.equal(fr.benford1D.conformity, fallback.benford1D.conformity)
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
