import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// Scoped master-data exports must filter by row identity (subsidiary_id),
// never by display label. Two codeless parties named 'Acme' in different
// legal entities — or two accounts named 'Cash' — share every label the old
// post-filter compared, so an A-scoped export carried B's full row
// (email, phone, legal name, custom fields).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { db, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)
const { getResource } = await import('./resources.ts')

const DB = !!process.env.OPENBOOKS_DB_URL

test(
  'a subsidiary-scoped export never carries another subsidiary’s same-named rows',
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg())
    const subB = randomUUID()
    try {
      await withBypass(() =>
        db.execute(sql`
          insert into subsidiaries (id, org_id, name, base_currency, country, parent_id, tax_ids, is_elimination, is_active, custom)
          values (${subB}, ${org.orgId}, 'Second Co', 'CAD', 'CA', ${org.subsidiaryId}, '{}'::jsonb, false, true, '{}'::jsonb)
        `),
      )
      await withBypass(() =>
        db.execute(sql`
          insert into parties (id, org_id, kind, display_name, short_code, email, subsidiary_id, is_active, custom)
          values (${randomUUID()}, ${org.orgId}, 'customer', 'Acme', null, 'a@example.com', ${org.subsidiaryId}, true, '{}'::jsonb),
                 (${randomUUID()}, ${org.orgId}, 'customer', 'Acme', null, 'b@example.com', ${subB}, true, '{}'::jsonb)
        `),
      )
      await withBypass(() =>
        db.execute(sql`
          insert into accounts (id, org_id, number, name, type, subsidiary_id)
          values (${randomUUID()}, ${org.orgId}, '9100', 'Cash', 'asset_bank', ${org.subsidiaryId}),
                 (${randomUUID()}, ${org.orgId}, '9200', 'Cash', 'asset_bank', ${subB})
        `),
      )

      await withOrgContext(org.orgId, async () => {
        const scopedParties = await getResource(org.orgId, 'parties', new Set([org.subsidiaryId]))
        assert.ok(scopedParties, 'parties resource resolves')
        const partyRows = (await scopedParties.read())?.rows ?? []
        const emails = partyRows.map((r) => String(r.email ?? ''))
        assert.ok(emails.includes('a@example.com'), 'scoped export keeps the visible subsidiary party')
        assert.ok(!emails.includes('b@example.com'), 'scoped export drops the same-named hidden party')

        const scopedAccounts = await getResource(org.orgId, 'accounts', new Set([org.subsidiaryId]))
        assert.ok(scopedAccounts, 'accounts resource resolves')
        const numbers = ((await scopedAccounts.read())?.rows ?? []).map((r) => String(r.number ?? ''))
        assert.ok(numbers.includes('9100'), 'scoped export keeps the visible subsidiary account')
        assert.ok(!numbers.includes('9200'), 'scoped export drops the same-named hidden account')

        const openParties = await getResource(org.orgId, 'parties', null)
        assert.ok(openParties, 'unrestricted parties resource resolves')
        const openEmails = ((await openParties.read())?.rows ?? []).map((r) => String(r.email ?? ''))
        assert.ok(openEmails.includes('a@example.com') && openEmails.includes('b@example.com'))

        const emptyScope = await getResource(org.orgId, 'parties', new Set())
        assert.ok(emptyScope, 'empty-scope parties resource resolves')
        assert.deepEqual((await emptyScope.read())?.rows ?? [], [])
      })
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)

test(
  'a subsidiary-scoped payroll export never carries a same-named hidden employee',
  { skip: !DB },
  async () => {
    // The old payroll post-filter compared the exported employee LABEL, so
    // two codeless employees both rendering as 'Sam Same' in different legal
    // entities shared every compared value. Scope must be decided by the
    // party row in SQL, in both the balances and entitlements reads.
    const org = await withBypass(() => createScratchOrg())
    const actorId = (await withBypass(() => seedFlowActors(org.orgId))).adminId
    const subB = randomUUID()
    const empA = randomUUID()
    const empB = randomUUID()
    try {
      await withBypass(() =>
        db.execute(sql`
          insert into subsidiaries (id, org_id, name, base_currency, country, parent_id, tax_ids, is_elimination, is_active, custom)
          values (${subB}, ${org.orgId}, 'Second Co', 'CAD', 'CA', ${org.subsidiaryId}, '{}'::jsonb, false, true, '{}'::jsonb)
        `),
      )
      await withBypass(() =>
        db.execute(sql`
          insert into parties (id, org_id, kind, display_name, short_code, subsidiary_id, is_active, custom)
          values (${empA}, ${org.orgId}, 'person', 'Sam Same', null, ${org.subsidiaryId}, true, '{}'::jsonb),
                 (${empB}, ${org.orgId}, 'person', 'Sam Same', null, ${subB}, true, '{}'::jsonb)
        `),
      )
      await withBypass(() =>
        db.execute(sql`
          insert into employee_roles (org_id, party_id, hired_on, terminated_on, is_active, created_by, updated_by)
          values (${org.orgId}, ${empA}, '2020-01-06', null, true, ${actorId}, ${actorId}),
                 (${org.orgId}, ${empB}, '2020-01-06', null, true, ${actorId}, ${actorId})
        `),
      )
      await withBypass(() =>
        db.execute(sql`
          insert into payroll_opening_balances (org_id, employee_party_id, tax_year, taxable_ytd, tax_ytd)
          values (${org.orgId}, ${empA}, 2026, 50000, 8000),
                 (${org.orgId}, ${empB}, 2026, 60000, 9000)
        `),
      )

      await withOrgContext(org.orgId, async () => {
        const scoped = await getResource(org.orgId, 'payroll-opening-balances', new Set([org.subsidiaryId]))
        assert.ok(scoped, 'payroll-opening-balances resource resolves')
        const rows = (await scoped.read())?.rows ?? []
        assert.equal(rows.length, 1, 'scoped export carries exactly the visible employee row')
        assert.equal(String(rows[0]!.employee ?? ''), 'Sam Same')
        assert.equal(Number(rows[0]!.taxableYtd ?? 0), 50000)
      })
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)
