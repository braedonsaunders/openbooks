import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/db.ts'
import {
  payrollSettings,
  seedPayrollComponents,
  statutoryHolidayPayEnabled,
  type PayrollSubsidiaryScope,
} from '@openbooks/engine/src/payroll-run.ts'
import {
  declaredRemittanceVendorSettingsKeys,
  packSlotState, PAYROLL_COUNTRY_PACKS, PayrollPackError, setPackSlotAccount, uninstallPayrollPack,
} from '@openbooks/engine/src/payroll/packs.ts'
import { assertValidPasswordExpression, pdfEncryptionAvailable } from '@openbooks/pdf'
import { payrollPaymentMethodSettings } from '@openbooks/engine/src/payroll-payment-method.ts'
import { payrollSetupState } from '@openbooks/engine/src/payroll-readiness.ts'
import { STUB_PASSWORD_TOKENS, stubPasswordPolicy } from '../../../../lib/payroll-outputs'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { guardRootSubsidiaryScope } from '../../../../lib/authz'
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

// Generic (jurisdiction-free) account slots. Statutory liabilities are NOT
// here: those are pack-declared slots written onto the seeded components
// (see engine/src/payroll/packs.ts). The old statutory settings keys are
// still accepted in PUT bodies for back-compat but no UI sends them.
const ACCOUNT_KEYS = [
  'wageExpenseAccountId',
  'burdenExpenseAccountId',
  'netPayAccountId',
  'cppPayableAccountId',
  'eiPayableAccountId',
  'taxPayableAccountId',
  'vacationPayableAccountId',
] as const

const ACCOUNT_TYPES_BY_KEY: Record<typeof ACCOUNT_KEYS[number], readonly string[]> = {
  wageExpenseAccountId: ['expense', 'expense_other', 'expense_deferred'],
  burdenExpenseAccountId: ['expense', 'expense_other', 'expense_deferred'],
  netPayAccountId: ['liability_payable', 'liability_current_other'],
  cppPayableAccountId: ['liability_payable', 'liability_current_other'],
  eiPayableAccountId: ['liability_payable', 'liability_current_other'],
  taxPayableAccountId: ['liability_payable', 'liability_current_other'],
  vacationPayableAccountId: ['liability_payable', 'liability_current_other'],
}

/**
 * Payroll jurisdiction packs the org can install — the pack REGISTRY's own
 * `installable` declaration, never a second list. A pack that exists but is
 * not yet installable (in development, superseded) is known for validation
 * but refused for install.
 */
const installableCountries = (): string[] =>
  Object.values(PAYROLL_COUNTRY_PACKS)
    .filter((pack) => pack.installable)
    .map((pack) => pack.country)

async function validatePayrollAccounts(
  orgId: string,
  body: Record<string, unknown>,
): Promise<NextResponse | null> {
  const requested = ACCOUNT_KEYS.flatMap((key) => {
    const value = body[key]
    return value == null ? [] : [[key, value as string] as const]
  })
  if (requested.length === 0) return null
  const rows = await db.execute<{
    id: string
    type: string
    isActive: boolean
    isSummary: boolean
  }>(sql`
    select id::text as id, type, is_active as "isActive", is_summary as "isSummary"
      from accounts
     where org_id = ${orgId}
       and id in (${sql.join(requested.map(([, id]) => sql`${id}`), sql`, `)})`)
  const byId = new Map(rows.rows.map((row) => [row.id, row]))
  for (const [key, id] of requested) {
    const row = byId.get(id)
    if (!row) {
      return NextResponse.json({ error: `invalid ${key}: account is not active in this organization` }, { status: 422 })
    }
    if (!row.isActive) {
      return NextResponse.json({ error: `invalid ${key}: account is inactive` }, { status: 422 })
    }
    if (row.isSummary) {
      return NextResponse.json({ error: `invalid ${key}: summary accounts cannot receive payroll postings` }, { status: 422 })
    }
    if (!ACCOUNT_TYPES_BY_KEY[key].includes(row.type)) {
      return NextResponse.json({ error: `invalid ${key}: account type ${row.type} is not compatible with payroll` }, { status: 422 })
    }
  }
  return null
}

async function validateRemittanceVendors(
  orgId: string,
  body: Record<string, unknown>,
): Promise<NextResponse | null> {
  const keys = declaredRemittanceVendorSettingsKeys()
  const requested = keys.flatMap((key) => {
    const value = body[key]
    return value == null ? [] : [[key, value as string] as const]
  })
  if (requested.length === 0) return null
  const rows = await db.execute<{
    id: string
    partyActive: boolean
    roleActive: boolean
  }>(sql`
    select p.id::text as id, p.is_active as "partyActive", v.is_active as "roleActive"
      from parties p
      join vendor_roles v on v.party_id = p.id and v.org_id = p.org_id
     where p.org_id = ${orgId}
       and p.id in (${sql.join(requested.map(([, id]) => sql`${id}`), sql`, `)})`)
  const byId = new Map(rows.rows.map((row) => [row.id, row]))
  for (const [key, id] of requested) {
    const row = byId.get(id)
    if (!row || !row.partyActive || !row.roleActive) {
      return NextResponse.json({ error: `invalid ${key}: active vendor in this organization is required` }, { status: 422 })
    }
  }
  return null
}

async function currentPayrollBlob(
  orgId: string,
  lock = false,
): Promise<Record<string, unknown>> {
  const r = (await db.execute<{ p: Record<string, unknown> | null }>(
    sql`select settings->'payroll' as p from orgs where id = ${orgId}${lock ? sql` for update` : sql``}`,
  ))
  return r.rows[0]?.p ?? {}
}

async function writePayrollBlob(
  orgId: string,
  actorId: string,
  before: Record<string, unknown>,
  settings: Record<string, unknown>,
): Promise<void> {
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{payroll}', ${JSON.stringify(settings)}::jsonb)
     where id = ${orgId}`)
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'orgs', ${orgId}, 'update',
            ${JSON.stringify({ before: { payroll: before }, after: { payroll: settings } })}, ${actorId})`)
}

async function currentSlotAccounts(
  orgId: string,
  slotAccounts: Record<string, Record<string, string | null>>,
): Promise<Record<string, Record<string, string | null>>> {
  const before: Record<string, Record<string, string | null>> = {}
  for (const [country, slots] of Object.entries(slotAccounts)) {
    const pack = PAYROLL_COUNTRY_PACKS[country]
    if (!pack) continue
    before[country] = {}
    for (const slotKey of Object.keys(slots)) {
      const slot = pack.statutorySlots.find((candidate) => candidate.key === slotKey)
      if (!slot) continue
      const componentCodes = `{${slot.components.map((component) => component.code).join(',')}}`
      const row = await db.execute<{ accountId: string | null }>(sql`
        select liability_account_id::text as "accountId"
          from pay_components
         where org_id = ${orgId} and code = any(${componentCodes}::text[])
         order by liability_account_id nulls last
         limit 1`)
      before[country][slotKey] = row.rows[0]?.accountId ?? null
    }
  }
  return before
}

async function pickerOptions(
  orgId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
) {
  const [accounts, vendors] = (await Promise.all([
    db.execute<{ id: string; number: string | null; name: string }>(sql`
      select id, number, name from accounts
       where org_id = ${orgId} and not is_summary and is_active
       order by number nulls last, name`),
    db.execute<{ id: string; name: string }>(sql`
      select p.id, p.display_name as name from parties p
       join vendor_roles v on v.party_id = p.id and v.org_id = p.org_id and v.is_active
       where p.org_id = ${orgId} and p.is_active
         and (${allowedSubsidiaryIds == null
           ? sql`true`
           : allowedSubsidiaryIds.size > 0
             ? sql`coalesce(p.subsidiary_id, (select root.id from subsidiaries root
                    where root.org_id = ${orgId} and root.parent_id is null and root.is_active
                    order by root.created_at limit 1)) in (${sql.join(
                      [...allowedSubsidiaryIds].map((id) => sql`${id}`), sql`, `,
                    )})`
             : sql`false`})
       order by p.display_name`),
  ]))
  return {
    accounts: accounts.rows.map((a) => ({ id: a.id, label: a.number ? `${a.number} · ${a.name}` : a.name })),
    vendors: vendors.rows.map((v) => ({ id: v.id, label: v.name })),
  }
}

export async function GET() {
  const gate = await guardFeaturePermission('payroll.manage', 'payroll')
  if (gate instanceof NextResponse) return gate
  const scopeDenied = await guardRootSubsidiaryScope(gate)
  if (scopeDenied) return scopeDenied
  const [settings, blob, options] = await Promise.all([
    payrollSettings(gate.user.orgId, gate.allowedSubsidiaryIds),
    currentPayrollBlob(gate.user.orgId),
    pickerOptions(gate.user.orgId, gate.allowedSubsidiaryIds),
  ])
  const installed = Array.isArray(blob.countries) ? blob.countries.map(String) : []
  const [packs, stubPassword, encryptionAvailable, setup] = await Promise.all([
    packSlotState(gate.user.orgId, installed, blob),
    stubPasswordPolicy(gate.user.orgId),
    pdfEncryptionAvailable(),
    // The setup wizard's step state — the same org-level checks the pay-run
    // readiness pre-flight performs, so the two surfaces cannot disagree.
    payrollSetupState(gate.user.orgId, gate.allowedSubsidiaryIds),
  ])
  const paymentMethods = await payrollPaymentMethodSettings(gate.user.orgId)
  const statutoryHolidayPay = await statutoryHolidayPayEnabled(
    gate.user.orgId,
    undefined,
    gate.allowedSubsidiaryIds,
  )
  return NextResponse.json({
    settings, packs, stubPassword, encryptionAvailable, paymentMethods, setup,
    statutoryHolidayPay,
    installable: installableCountries(),
    ...options,
  })
}

export async function PUT(req: Request) {
  const gate = await guardFeaturePermission('payroll.manage', 'payroll')
  if (gate instanceof NextResponse) return gate
  const scopeDenied = await guardRootSubsidiaryScope(gate)
  if (scopeDenied) return scopeDenied
  const orgId = gate.user.orgId
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data

  return withOrgTransaction(orgId, async () => {
  const settings: Record<string, unknown> = await currentPayrollBlob(orgId, true)
  const before = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>
  for (const key of ACCOUNT_KEYS) {
    if (!(key in body)) continue
    const v = body[key] ?? null
    if (v !== null && !isUuid(v)) return NextResponse.json({ error: `invalid ${key}` }, { status: 422 })
  }
  const accountError = await validatePayrollAccounts(orgId, body)
  if (accountError) return accountError
  for (const key of ACCOUNT_KEYS) {
    if (key in body) settings[key] = body[key] ?? null
  }
  // Statutory remittance vendors — exactly the settings keys the pack
  // declarations name (the CRA vendor, the Revenu Québec vendor for the CA
  // pack's QC-scoped components), never a literal list here.
  for (const vendorKey of declaredRemittanceVendorSettingsKeys()) {
    if (!(vendorKey in body)) continue
    const party = body[vendorKey] ?? null
    if (party !== null && !isUuid(party)) {
      return NextResponse.json({ error: `invalid ${vendorKey}` }, { status: 422 })
    }
  }
  const vendorError = await validateRemittanceVendors(orgId, body)
  if (vendorError) return vendorError
  for (const vendorKey of declaredRemittanceVendorSettingsKeys()) {
    if (vendorKey in body) settings[vendorKey] = body[vendorKey] ?? null
  }
  // The cheque safety net. On by default: a payroll that refuses to run
  // because one employee's void cheque has not been keyed yet fails everybody
  // else on the run. Turning it OFF is the deliberate strict posture — an
  // employee configured for EFT with no bank details blocks the run instead of
  // being paid on paper.
  if ('eftFallbackToCheque' in body) {
    if (typeof body.eftFallbackToCheque !== 'boolean') {
      return NextResponse.json({ error: 'invalid eftFallbackToCheque' }, { status: 422 })
    }
    settings.eftFallbackToCheque = body.eftFallbackToCheque
  }
  if ('wagesTo' in body) {
    settings.wagesTo = body.wagesTo === 'labor_clearing' ? 'labor_clearing' : 'expense'
  }
  if ('t4Transmitter' in body) {
    const cfg = body.t4Transmitter
    if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) {
      return NextResponse.json({ error: 'invalid t4Transmitter' }, { status: 422 })
    }
    const keys = ['bn', 'transmitterNumber', 'name', 'contactName', 'contactEmail', 'contactPhone']
    const clean: Record<string, string> = {}
    for (const key of keys) {
      const v = (cfg as Record<string, unknown>)[key]
      if (v != null && typeof v !== 'string') return NextResponse.json({ error: `invalid ${key}` }, { status: 422 })
      if (typeof v === 'string' && v.trim()) clean[key] = v.trim()
    }
    settings.t4Transmitter = clean
  }
  // Emailed pay stubs carry wage data, so the org may require the PDF to be
  // encrypted. The password RULE is configuration (employers publish their own
  // to staff); it is validated here so a bad expression is refused at save
  // time rather than at stub-email time. No password is ever stored.
  if ('stubPassword' in body) {
    const policy = body.stubPassword
    if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
      return NextResponse.json({ error: 'invalid stubPassword' }, { status: 422 })
    }
    const expression = typeof policy.expression === 'string' ? policy.expression.trim() : ''
    const enabled = policy.enabled === true
    if (enabled) {
      try {
        assertValidPasswordExpression(expression, STUB_PASSWORD_TOKENS)
      } catch (e) {
        return NextResponse.json({ error: (e as Error).message }, { status: 422 })
      }
      if (!(await pdfEncryptionAvailable())) {
        return NextResponse.json(
          { error: 'PDF encryption is unavailable on this server (qpdf is not installed)' },
          { status: 422 },
        )
      }
    }
    settings.stubPassword = { enabled, expression }
  }
  if ('countries' in body) {
    const countries = body.countries
    if (
      !Array.isArray(countries)
      || countries.some((c) => !(String(c) in PAYROLL_COUNTRY_PACKS))
    ) {
      return NextResponse.json({ error: 'invalid countries' }, { status: 422 })
    }
    settings.countries = [...new Set(countries.map(String))]
  }
  // Statutory holiday pay (engine/src/payroll-run.ts phase 2). Org-level
  // gate; default OFF for tenants that predate the feature because it changes
  // gross pay.
  if ('statutoryHolidayPay' in body) {
    if (typeof body.statutoryHolidayPay !== 'boolean') {
      return NextResponse.json({ error: 'invalid statutoryHolidayPay' }, { status: 422 })
    }
    settings.statutoryHolidayPay = body.statutoryHolidayPay
  }

  // NOTE: the pre-scoping `us` / `ca` rate blobs are deliberately NOT writable
  // here any more. A SUI rate is experience-rated per filing account, the FUTA
  // credit reduction is published per state per year, and each province levies
  // its own employer health tax — none of which an org-level blob can hold. They
  // now live in payroll_statutory_rates at the scope the pack declares, written
  // through /api/payroll/settings/rates. The stored blobs are still READ as a
  // resolution fallback (engine/src/payroll/statutory-rates.ts), so an untouched
  // tenant calculates byte-identically; accepting writes to both would be two
  // sources of truth for one statutory number.

  // Pack-declared statutory slots: { [country]: { [slotKey]: accountId|null } }.
  // Writes land on the mapped components' liability accounts, never in the blob.
  if ('slotAccounts' in body) {
    const slotAccounts = body.slotAccounts
    if (typeof slotAccounts !== 'object' || slotAccounts === null || Array.isArray(slotAccounts)) {
      return NextResponse.json({ error: 'invalid slotAccounts' }, { status: 422 })
    }
    for (const [country, slots] of Object.entries(slotAccounts as Record<string, unknown>)) {
      const pack = PAYROLL_COUNTRY_PACKS[country]
      if (!pack || typeof slots !== 'object' || slots === null) {
        return NextResponse.json({ error: `invalid pack ${country}` }, { status: 422 })
      }
      for (const [slotKey, accountId] of Object.entries(slots as Record<string, unknown>)) {
        if (!pack.statutorySlots.some((slot) => slot.key === slotKey)) {
          return NextResponse.json({ error: `invalid slot ${country}/${slotKey}` }, { status: 422 })
        }
        if (accountId !== null && (typeof accountId !== 'string' || !isUuid(accountId))) {
          return NextResponse.json({ error: `invalid account for ${country}/${slotKey}` }, { status: 422 })
        }
      }
    }
    const slotAccountsBefore = await currentSlotAccounts(
      orgId,
      slotAccounts as Record<string, Record<string, string | null>>,
    )
    for (const [country, slots] of Object.entries(slotAccounts as Record<string, Record<string, string | null>>)) {
      for (const [slotKey, accountId] of Object.entries(slots)) {
        await setPackSlotAccount(orgId, gate.user.id, country, slotKey, accountId)
      }
    }
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'pay_components', ${orgId}, 'update',
              ${JSON.stringify({ before: { payrollSlotAccounts: slotAccountsBefore }, after: { payrollSlotAccounts: body.slotAccounts } })}, ${gate.user.id})`)
  }

  await writePayrollBlob(orgId, gate.user.id, before, settings)
  return NextResponse.json({ ok: true })
  })
}

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('payroll.manage', 'payroll')
  if (gate instanceof NextResponse) return gate
  const scopeDenied = await guardRootSubsidiaryScope(gate)
  if (scopeDenied) return scopeDenied
  const parsedBody2 = await parseJsonBody(req, jsonObject);
  if (!parsedBody2.ok) return parsedBody2.response;
  const body = parsedBody2.data
  if (body.action === 'seed-components') {
    // The pack names its own component set; the registry is the only
    // validator. The old `body.country === 'US' ? 'US' : 'CA'` cast turned
    // every unrecognised value — a typo, a pack nobody wrote — into Canada
    // and seeded CPP/EI for it.
    const country = String(body.country ?? '')
    if (!installableCountries().includes(country)) {
      return NextResponse.json({ error: 'unknown country pack' }, { status: 422 })
    }
    return withOrgTransaction(gate.user.orgId, async () => {
      await seedPayrollComponents(
        gate.user.orgId, gate.user.id, country, gate.allowedSubsidiaryIds,
      )
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${gate.user.orgId}, 'pay_components', ${gate.user.orgId}, 'insert',
                ${JSON.stringify({ before: null, after: { payrollPack: country } })}, ${gate.user.id})`)
      return NextResponse.json({ ok: true })
    })
  }
  if (body.action === 'install-pack') {
    const country = String(body.country ?? '')
    if (!installableCountries().includes(country)) {
      return NextResponse.json({ error: 'unknown country pack' }, { status: 422 })
    }
    // A pack = its statutory component set (the engine wiring) plus the pack
    // marker the setup workspace and wizard read back.
    return withOrgTransaction(gate.user.orgId, async () => {
      await seedPayrollComponents(
        gate.user.orgId, gate.user.id, country, gate.allowedSubsidiaryIds,
      )
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${gate.user.orgId}, 'pay_components', ${gate.user.orgId}, 'insert',
                ${JSON.stringify({ before: null, after: { payrollPack: country } })}, ${gate.user.id})`)
      const settings = await currentPayrollBlob(gate.user.orgId, true)
      const before = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>
      const countries = Array.isArray(settings.countries) ? settings.countries.map(String) : []
      // A NEW payroll org (first pack, nothing decided yet) starts with
      // statutory holiday pay ON; an existing tenant's stubs must not change on
      // an upgrade or a second-pack install, so an absent key stays absent.
      if (countries.length === 0 && !('statutoryHolidayPay' in settings)) {
        settings.statutoryHolidayPay = true
      }
      settings.countries = [...new Set([...countries, country])]
      await writePayrollBlob(gate.user.orgId, gate.user.id, before, settings)
      return NextResponse.json({ ok: true })
    })
  }
  if (body.action === 'uninstall-pack') {
    const country = String(body.country ?? '')
    if (!(country in PAYROLL_COUNTRY_PACKS)) {
      return NextResponse.json({ error: 'unknown country pack' }, { status: 422 })
    }
    try {
      return await withOrgTransaction(gate.user.orgId, async () => {
        const before = await currentPayrollBlob(gate.user.orgId, true)
        const result = await uninstallPayrollPack(gate.user.orgId, gate.user.id, country)
        const after = await currentPayrollBlob(gate.user.orgId)
        await db.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${gate.user.orgId}, 'orgs', ${gate.user.orgId}, 'update',
                  ${JSON.stringify({ before: { payroll: before }, after: { payroll: after } })}, ${gate.user.id})`)
        return NextResponse.json({ ok: true, ...result })
      })
    } catch (error) {
      if (error instanceof PayrollPackError) {
        return NextResponse.json({ error: error.message }, { status: 409 })
      }
      throw error
    }
  }
  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
