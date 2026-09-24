import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

// The detail loader must forward the caller's subsidiary scope into the
// filing read: an entity-restricted caller opening another legal entity's
// filing URL must see "not found", never the filing. (Was FilingDetail.scope
// source pins on the loadFiling call.)
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: 'data:text/javascript,' + encodeURIComponent(source),
})
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next/navigation') {
      return virtual(
        'export function redirect(url){ throw new Error("REDIRECT:" + url) }',
      )
    }
    return next(specifier, context)
  },
})

const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} = await import('@openbooks/engine/src/testing/fixtures.ts')
const { ensureFiling } = await import('@openbooks/engine/src/compliance/information-returns.ts')
const { loadFiling } = await import('../../../../lib/compliance')

const DB = !!process.env.OPENBOOKS_DB_URL

async function seedFilings() {
  const org = await withBypassContext(() => createScratchOrg())
  const hidden = randomUUID()
  const taxYear = Number(org.date.slice(0, 4)) - 1
  const actor = await withBypassContext(() => createScratchUser(org.orgId, 'IR reader', 'admin'))
  await withBypassContext(async () => {
    await db.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,subcontractorCompliance}', 'true'::jsonb, true)
       where id = ${org.orgId}`)
    await db.execute(sql`
      insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
      values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden entity','CAD','CA')`)
  })
  const hiddenFiling = await withBypassContext(() =>
    ensureFiling({ orgId: org.orgId, taxYear, formType: '1099-NEC', subsidiaryId: hidden, currency: 'USD', actorId: actor }),
  )
  const rootFiling = await withBypassContext(() =>
    ensureFiling({ orgId: org.orgId, taxYear, formType: '1099-NEC', subsidiaryId: null, currency: 'USD', actorId: actor }),
  )
  const visibleFiling = await withBypassContext(() =>
    ensureFiling({ orgId: org.orgId, taxYear, formType: '1099-NEC', subsidiaryId: org.subsidiaryId, currency: 'USD', actorId: actor }),
  )
  return { org, hiddenFiling, rootFiling, visibleFiling }
}

test('the detail read returns nothing outside the caller subsidiary scope', { skip: !DB }, async () => {
  const { org, hiddenFiling, rootFiling, visibleFiling } = await seedFilings()
  try {
    const scope = new Set([org.subsidiaryId])
    const own = await withBypassContext(() => loadFiling(org.orgId, visibleFiling.id, scope))
    assert.equal(own?.id, visibleFiling.id, 'the caller entity filing must load')
    assert.equal(
      await withBypassContext(() => loadFiling(org.orgId, hiddenFiling.id, scope)),
      null,
      "another entity's filing must read as missing",
    )
    assert.equal(
      await withBypassContext(() => loadFiling(org.orgId, rootFiling.id, scope)),
      null,
      'an org-root filing must read as missing for a restricted caller',
    )
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('the detail read returns every filing without a scope restriction', { skip: !DB }, async () => {
  const { org, hiddenFiling, rootFiling, visibleFiling } = await seedFilings()
  try {
    for (const filing of [hiddenFiling, rootFiling, visibleFiling]) {
      const loaded = await withBypassContext(() => loadFiling(org.orgId, filing.id, null))
      assert.equal(loaded?.id, filing.id, 'an unrestricted read must load every filing')
    }
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
