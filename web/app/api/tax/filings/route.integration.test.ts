import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '@/lib/auth'

// Live-Postgres regression for the Prepare route: the engine clamps the
// requested window into the registration's reportable window (a registration
// effective mid-quarter reports from its effective date) and STORES the
// clamped window as the filing's identity (tax_filings_period_version), but
// the route used to take its advisory lock and compute the next version from
// the caller's UNCLAMPED dates. Two prepares of the same quarter therefore
// both computed version 1 on the same stored key, the second one failed with
// a raw unique-violation surfaced as a 422, and no second version of that
// quarter's return could ever be prepared. The route now derives both from
// the persisted (clamped) window — the same key mark-filed serializes on.

const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __taxFilingPrepareUser: state })
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: 'data:text/javascript,' + encodeURIComponent(source),
})
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (
      (specifier === './auth' || specifier.endsWith('/lib/auth')) &&
      context.parentURL?.endsWith('/web/lib/authz.ts')
    ) {
      return virtual('export async function currentUser(){ return globalThis.__taxFilingPrepareUser.user }')
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const routeUrl = './route.ts?prepare-window'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')

const DB = !!process.env.OPENBOOKS_DB_URL

const prepare = (body: unknown) =>
  POST(
    new Request('http://openbooks.test/api/tax/filings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

test('two prepares inside one filing period version the stored (clamped) window', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Tax filer', 'tax_filer'))
    const formCode = 'QTR-RETURN'
    const year = org.date.slice(0, 4)
    await withBypassContext(async () => {
      await db.execute(sql`
        update app_roles set permissions = '["compliance.file"]'::jsonb, subsidiary_restriction = '{"mode":"all"}'::jsonb
         where org_id = ${org.orgId} and key = 'tax_filer'`)
      await db.execute(sql`
        insert into tax_return_forms (org_id, code, name, submission_channel, is_active)
        values (${org.orgId}, ${formCode}, 'Quarterly return', 'portal_manual', true)`)
      await db.execute(sql`
        insert into tax_report_lines (org_id, report_code, line_code, label, formula)
        values (${org.orgId}, ${formCode}, 'amount', 'Amount', '0')`)
      const jurisdictionId = randomUUID()
      await db.execute(sql`
        insert into tax_jurisdictions (id, org_id, code, name, country, level, tax_type, is_active)
        values (${jurisdictionId}, ${org.orgId}, 'ZZ', 'Test jurisdiction', 'ZZ', 'country', 'vat', true)`)
      // Registered mid-quarter: the Apr–Jun return reports Apr 15 – Jun 30.
      await db.execute(sql`
        insert into tax_registrations
          (org_id, jurisdiction_id, filing_frequency, return_form_code, effective_from, is_active)
        values (${org.orgId}, ${jurisdictionId}, 'quarterly', ${formCode}, ${`${year}-04-15`}, true)`)
    })
    state.user = {
      id: actor,
      orgId: org.orgId,
      name: 'Tax filer',
      email: 'filer@scratch.test',
      roles: [],
      isSuperAdmin: false,
      envKind: 'production',
      productionOrgId: org.orgId,
      homeOrgId: org.orgId,
      homeUserId: actor,
    }

    await withOrgContext(org.orgId, async () => {
      // The filer asks for the whole quarter twice; both clamp to Apr 15 – Jun 30.
      const first = await prepare({ code: formCode, from: `${year}-04-01`, to: `${year}-06-30` })
      assert.equal(first.status, 201, JSON.stringify(await first.clone().json()))
      const firstBody = (await first.json()) as { id: string; version: number }
      assert.equal(firstBody.version, 1)

      const second = await prepare({ code: formCode, from: `${year}-04-01`, to: `${year}-06-30` })
      assert.equal(second.status, 201, JSON.stringify(await second.clone().json()))
      const secondBody = (await second.json()) as { id: string; version: number }
      assert.equal(secondBody.version, 2)

      const stored = await db.execute<{ id: string; period_from: string; period_to: string; version: number }>(sql`
        select id, period_from::text, period_to::text, version
          from tax_filings
         where org_id = ${org.orgId} and form_code = ${formCode}
         order by version`)
      assert.deepEqual(
        stored.rows.map((row) => ({ ...row })),
        [
          { id: firstBody.id, period_from: `${year}-04-15`, period_to: `${year}-06-30`, version: 1 },
          { id: secondBody.id, period_from: `${year}-04-15`, period_to: `${year}-06-30`, version: 2 },
        ],
      )
      // The audit evidence names the persisted window and version, one row per prepare.
      const audits = await db.execute<{ changes: { from: string; to: string; version: number } }>(sql`
        select changes from audit_log
         where org_id = ${org.orgId} and table_name = 'tax_filings' and action = 'insert'
         order by at`)
      assert.deepEqual(
        audits.rows.map((row) => [row.changes.from, row.changes.to, row.changes.version]),
        [[`${year}-04-15`, `${year}-06-30`, 1], [`${year}-04-15`, `${year}-06-30`, 2]],
      )
    })
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
