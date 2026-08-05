import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { payrollSettings, seedPayrollComponents } from '@openbooks/engine/src/payroll-run.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'

export const dynamic = 'force-dynamic'

/**
 * Payroll org settings (orgs.settings.payroll) — the control accounts the
 * commit projection posts to, the wages destination, the CRA remittance
 * vendor, and the installed country packs. PUT merges into the payroll
 * subtree only (jsonb_set, same shape as the labor-costing route) so sibling
 * settings keys are never clobbered; keys absent from the body keep their
 * stored value. POST { action: 'seed-components' } installs the statutory
 * component set; POST { action: 'install-pack', country } seeds it AND
 * records the pack under settings.payroll.countries.
 */

const ACCOUNT_KEYS = [
  'wageExpenseAccountId',
  'burdenExpenseAccountId',
  'netPayAccountId',
  'cppPayableAccountId',
  'eiPayableAccountId',
  'taxPayableAccountId',
  'vacationPayableAccountId',
] as const

/** Payroll jurisdiction packs the org can install (US is announced, not shipped). */
const INSTALLABLE_COUNTRIES = ['CA'] as const
const KNOWN_COUNTRIES = ['CA', 'US'] as const

async function currentPayrollBlob(orgId: string): Promise<Record<string, unknown>> {
  const r = (await db.execute(
    sql`select settings->'payroll' as p from orgs where id = ${orgId}`,
  )) as unknown as { rows: { p: Record<string, unknown> | null }[] }
  return r.rows[0]?.p ?? {}
}

async function writePayrollBlob(
  orgId: string,
  actorId: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{payroll}', ${JSON.stringify(settings)}::jsonb)
     where id = ${orgId}`)
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'orgs', ${orgId}, 'update', ${JSON.stringify({ payroll: settings })}, ${actorId})`)
}

async function pickerOptions(orgId: string) {
  const [accounts, vendors] = (await Promise.all([
    db.execute(sql`
      select id, number, name from accounts
       where org_id = ${orgId} and not is_summary and is_active
       order by number nulls last, name`),
    db.execute(sql`
      select p.id, p.display_name as name from parties p
       join vendor_roles v on v.party_id = p.id and v.org_id = p.org_id and v.is_active
       where p.org_id = ${orgId} and p.is_active order by p.display_name`),
  ])) as unknown as [
    { rows: { id: string; number: string | null; name: string }[] },
    { rows: { id: string; name: string }[] },
  ]
  return {
    accounts: accounts.rows.map((a) => ({ id: a.id, label: a.number ? `${a.number} · ${a.name}` : a.name })),
    vendors: vendors.rows.map((v) => ({ id: v.id, label: v.name })),
  }
}

export async function GET() {
  const gate = await guardFeaturePermission('payroll.manage', 'payroll')
  if (gate instanceof NextResponse) return gate
  const [settings, options] = await Promise.all([
    payrollSettings(gate.user.orgId),
    pickerOptions(gate.user.orgId),
  ])
  return NextResponse.json({ settings, ...options })
}

export async function PUT(req: Request) {
  const gate = await guardFeaturePermission('payroll.manage', 'payroll')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const body = await req.json().catch(() => ({}))

  const settings: Record<string, unknown> = await currentPayrollBlob(orgId)
  for (const key of ACCOUNT_KEYS) {
    if (!(key in body)) continue
    const v = body[key] ?? null
    if (v !== null && !isUuid(v)) return NextResponse.json({ error: `invalid ${key}` }, { status: 422 })
    settings[key] = v
  }
  if ('craRemittancePartyId' in body) {
    const party = body.craRemittancePartyId ?? null
    if (party !== null && !isUuid(party)) {
      return NextResponse.json({ error: 'invalid craRemittancePartyId' }, { status: 422 })
    }
    settings.craRemittancePartyId = party
  }
  if ('wagesTo' in body) {
    settings.wagesTo = body.wagesTo === 'labor_clearing' ? 'labor_clearing' : 'expense'
  }
  if ('countries' in body) {
    const countries = body.countries
    if (
      !Array.isArray(countries)
      || countries.some((c) => !(KNOWN_COUNTRIES as readonly string[]).includes(String(c)))
    ) {
      return NextResponse.json({ error: 'invalid countries' }, { status: 422 })
    }
    settings.countries = [...new Set(countries.map(String))]
  }

  await writePayrollBlob(orgId, gate.user.id, settings)
  return NextResponse.json({ ok: true })
}

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('payroll.manage', 'payroll')
  if (gate instanceof NextResponse) return gate
  const body = await req.json().catch(() => ({}))
  if (body.action === 'seed-components') {
    await seedPayrollComponents(gate.user.orgId, gate.user.id)
    return NextResponse.json({ ok: true })
  }
  if (body.action === 'install-pack') {
    const country = String(body.country ?? '')
    if (!(INSTALLABLE_COUNTRIES as readonly string[]).includes(country)) {
      return NextResponse.json({ error: 'unknown country pack' }, { status: 422 })
    }
    // The Canada pack = the statutory component set (T4127 engine wiring) plus
    // the pack marker the setup workspace and wizard read back.
    await seedPayrollComponents(gate.user.orgId, gate.user.id)
    const settings = await currentPayrollBlob(gate.user.orgId)
    const countries = Array.isArray(settings.countries) ? settings.countries.map(String) : []
    settings.countries = [...new Set([...countries, country])]
    await writePayrollBlob(gate.user.orgId, gate.user.id, settings)
    return NextResponse.json({ ok: true })
  }
  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
