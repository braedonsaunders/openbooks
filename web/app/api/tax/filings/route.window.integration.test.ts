import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { SessionUser } from '@/lib/auth'

// A prepare request whose window spans several filing periods of the form's
// registration used to be narrowed silently to the first period, leaving the
// rest of the window on no return. It now refuses by name, listing the
// periods; a window inside one period stores and echoes that period's window
// as the filing's identity.

const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __taxFilingWindowUser: state })
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: 'data:text/javascript,' + encodeURIComponent(source),
})
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (
      (specifier === './auth' || specifier.endsWith('/lib/auth')) &&
      context.parentURL?.endsWith('/web/lib/authz.ts')
    ) {
      return virtual('export async function currentUser(){ return globalThis.__taxFilingWindowUser.user }')
    }
    return next(specifier, context)
  },
})
const routeUrl = './route.ts?prepare-window-echo'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')


const prepare = (body: unknown) =>
  POST(
    new Request('http://openbooks.test/api/tax/filings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

test('a year-wide prepare refuses by name; one quarter stores and echoes its window', async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Tax filer', 'tax_filer'))
    const formCode = 'QTR-WINDOW'
    const year = org.date.slice(0, 4)
    await withBypassContext(async () => {
      await db.execute(sql`
        update app_roles set permissions = '["compliance.file"]'::jsonb, subsidiary_restriction = '{"mode":"all"}'::jsonb
         where org_id = ${org.orgId} and key = 'tax_filer'`)
      await db.execute(sql`
        insert into tax_return_forms (org_id, code, name, submission_channel, is_active)
        values (${org.orgId}, ${formCode}, 'Quarterly window return', 'portal_manual', true)`)
      await db.execute(sql`
        insert into tax_report_lines (org_id, report_code, line_code, label, formula)
        values (${org.orgId}, ${formCode}, 'amount', 'Amount', '0')`)
      const jurisdictionId = randomUUID()
      await db.execute(sql`
        insert into tax_jurisdictions (id, org_id, code, name, country, level, tax_type, is_active)
        values (${jurisdictionId}, ${org.orgId}, 'ZZ', 'Test jurisdiction', 'ZZ', 'country', 'vat', true)`)
      await db.execute(sql`
        insert into tax_registrations
          (org_id, jurisdiction_id, filing_frequency, return_form_code, is_active)
        values (${org.orgId}, ${jurisdictionId}, 'quarterly', ${formCode}, true)`)
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
      // The whole year spans four quarters: refused, nothing stored.
      const yearWide = await prepare({ code: formCode, from: `${year}-01-01`, to: `${year}-12-31` })
      assert.equal(yearWide.status, 422)
      assert.match(JSON.stringify(await yearWide.json()), new RegExp(`spans 4 filing periods.*${year}-04-01 to ${year}-06-30.*prepare one return per filing period`))
      const response = await prepare({ code: formCode, from: `${year}-01-01`, to: `${year}-03-31` })
      assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
      const body = (await response.json()) as {
        id: string
        version: number
        formCode: string
        from: string
        to: string
      }
      assert.equal(body.version, 1)
      assert.equal(body.formCode, formCode)
      assert.equal(body.from, `${year}-01-01`)
      assert.equal(body.to, `${year}-03-31`)

      const stored = await db.execute<{ id: string; period_from: string; period_to: string }>(sql`
        select id, period_from::text, period_to::text
          from tax_filings
         where org_id = ${org.orgId} and form_code = ${formCode}`)
      assert.equal(stored.rows.length, 1)
      assert.equal(stored.rows[0]!.id, body.id)
      assert.equal(stored.rows[0]!.period_from, body.from, 'response window matches the stored filing identity')
      assert.equal(stored.rows[0]!.period_to, body.to, 'response window matches the stored filing identity')
    })
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
