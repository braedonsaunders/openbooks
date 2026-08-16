import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { caPayrollConfig, payrollSettings, seedPayrollComponents, usPayrollConfig } from '@openbooks/engine/src/payroll-run.ts'
import {
  declaredRemittanceVendorSettingsKeys,
  packSlotState, PAYROLL_COUNTRY_PACKS, PayrollPackError, setPackSlotAccount, uninstallPayrollPack,
} from '@openbooks/engine/src/payroll/packs.ts'
import { US_STATES } from '@openbooks/engine/src/payroll/us/rates.ts'
import { assertValidPasswordExpression, pdfEncryptionAvailable } from '@openbooks/pdf'
import { payrollPaymentMethodSettings } from '@openbooks/engine/src/payroll-payment-method.ts'
import { STUB_PASSWORD_TOKENS, stubPasswordPolicy } from '../../../../lib/payroll-outputs'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { canonicalDecimal, compareDecimal } from '../../../../lib/exact-decimal'
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
  const [settings, blob, options] = await Promise.all([
    payrollSettings(gate.user.orgId),
    currentPayrollBlob(gate.user.orgId),
    pickerOptions(gate.user.orgId),
  ])
  const installed = Array.isArray(blob.countries) ? blob.countries.map(String) : []
  const [packs, us, ca, stubPassword, encryptionAvailable] = await Promise.all([
    packSlotState(gate.user.orgId, installed, blob),
    usPayrollConfig(gate.user.orgId),
    caPayrollConfig(gate.user.orgId),
    stubPasswordPolicy(gate.user.orgId),
    pdfEncryptionAvailable(),
  ])
  const paymentMethods = await payrollPaymentMethodSettings(gate.user.orgId)
  return NextResponse.json({
    settings, packs, us, ca, stubPassword, encryptionAvailable, paymentMethods,
    statutoryHolidayPay: blob.statutoryHolidayPay === true,
    installable: installableCountries(),
    ...options,
  })
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
  // Statutory remittance vendors — exactly the settings keys the pack
  // declarations name (the CRA vendor, the Revenu Québec vendor for the CA
  // pack's QC-scoped components), never a literal list here.
  for (const vendorKey of declaredRemittanceVendorSettingsKeys()) {
    if (!(vendorKey in body)) continue
    const party = body[vendorKey] ?? null
    if (party !== null && !isUuid(party)) {
      return NextResponse.json({ error: `invalid ${vendorKey}` }, { status: 422 })
    }
    settings[vendorKey] = party
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

  // US pack configuration: effective FUTA rate (credit-reduction states) and
  // per-state SUI rates/wage bases — experience-rated, so always org-entered.
  if ('us' in body) {
    const us = body.us
    if (typeof us !== 'object' || us === null || Array.isArray(us)) {
      return NextResponse.json({ error: 'invalid us config' }, { status: 422 })
    }
    const clean: { futaRate?: string; sui: Record<string, { rate: string; wageBase: string }> } = { sui: {} }
    if (us.futaRate !== null && us.futaRate !== undefined && us.futaRate !== '') {
      const rate = canonicalDecimal(us.futaRate, 4)
      if (rate === null || compareDecimal(rate, '0') < 0 || compareDecimal(rate, '0.2') > 0) {
        return NextResponse.json({ error: 'invalid us.futaRate' }, { status: 422 })
      }
      clean.futaRate = rate
    }
    const sui = us.sui ?? {}
    if (typeof sui !== 'object' || sui === null || Array.isArray(sui)) {
      return NextResponse.json({ error: 'invalid us.sui' }, { status: 422 })
    }
    for (const [state, entry] of Object.entries(sui as Record<string, { rate?: unknown; wageBase?: unknown }>)) {
      if (!(US_STATES as readonly string[]).includes(state)) {
        return NextResponse.json({ error: `invalid SUI state ${state}` }, { status: 422 })
      }
      const rate = canonicalDecimal(entry?.rate, 4)
      const wageBase = canonicalDecimal(entry?.wageBase, 2)
      if (rate === null || compareDecimal(rate, '0') < 0 || compareDecimal(rate, '0.2') > 0
        || wageBase === null || compareDecimal(wageBase, '0') < 0) {
        return NextResponse.json({ error: `invalid SUI entry for ${state}` }, { status: 422 })
      }
      clean.sui[state] = { rate, wageBase }
    }
    settings.us = clean
  }

  // CA pack configuration: Ontario EHT. The rate is org-specific (it scales
  // with total Ontario payroll) and the exemption is shared across associated
  // employers, so both are always org-entered. WCB rates live on worker-comp
  // groups (per rate class), not here.
  if ('ca' in body) {
    const ca = body.ca
    if (typeof ca !== 'object' || ca === null || Array.isArray(ca)) {
      return NextResponse.json({ error: 'invalid ca config' }, { status: 422 })
    }
    const eht = (ca as Record<string, unknown>).eht ?? {}
    if (typeof eht !== 'object' || eht === null || Array.isArray(eht)) {
      return NextResponse.json({ error: 'invalid ca.eht' }, { status: 422 })
    }
    const raw = eht as Record<string, unknown>
    const clean: { eht: { enabled: boolean; rate?: string; annualExemption?: string } } = {
      eht: { enabled: raw.enabled === true },
    }
    if (raw.rate !== null && raw.rate !== undefined && raw.rate !== '') {
      const rate = canonicalDecimal(raw.rate, 4)
      if (rate === null || compareDecimal(rate, '0') < 0 || compareDecimal(rate, '10') > 0) {
        return NextResponse.json({ error: 'invalid ca.eht.rate' }, { status: 422 })
      }
      clean.eht.rate = rate
    }
    if (raw.annualExemption !== null && raw.annualExemption !== undefined && raw.annualExemption !== '') {
      const exemption = canonicalDecimal(raw.annualExemption, 2)
      if (exemption === null || compareDecimal(exemption, '0') < 0) {
        return NextResponse.json({ error: 'invalid ca.eht.annualExemption' }, { status: 422 })
      }
      clean.eht.annualExemption = exemption
    }
    settings.ca = clean
  }

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
    for (const [country, slots] of Object.entries(slotAccounts as Record<string, Record<string, string | null>>)) {
      for (const [slotKey, accountId] of Object.entries(slots)) {
        await setPackSlotAccount(orgId, gate.user.id, country, slotKey, accountId)
      }
    }
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'pay_components', ${orgId}, 'update',
              ${JSON.stringify({ payrollSlotAccounts: body.slotAccounts })}, ${gate.user.id})`)
  }

  await writePayrollBlob(orgId, gate.user.id, settings)
  return NextResponse.json({ ok: true })
}

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('payroll.manage', 'payroll')
  if (gate instanceof NextResponse) return gate
  const body = await req.json().catch(() => ({}))
  if (body.action === 'seed-components') {
    // The pack names its own component set; the registry is the only
    // validator. The old `body.country === 'US' ? 'US' : 'CA'` cast turned
    // every unrecognised value — a typo, a pack nobody wrote — into Canada
    // and seeded CPP/EI for it.
    const country = String(body.country ?? '')
    if (!installableCountries().includes(country)) {
      return NextResponse.json({ error: 'unknown country pack' }, { status: 422 })
    }
    await seedPayrollComponents(gate.user.orgId, gate.user.id, country)
    return NextResponse.json({ ok: true })
  }
  if (body.action === 'install-pack') {
    const country = String(body.country ?? '')
    if (!installableCountries().includes(country)) {
      return NextResponse.json({ error: 'unknown country pack' }, { status: 422 })
    }
    // A pack = its statutory component set (the engine wiring) plus the pack
    // marker the setup workspace and wizard read back.
    await seedPayrollComponents(gate.user.orgId, gate.user.id, country)
    const settings = await currentPayrollBlob(gate.user.orgId)
    const countries = Array.isArray(settings.countries) ? settings.countries.map(String) : []
    // A NEW payroll org (first pack, nothing decided yet) starts with
    // statutory holiday pay ON; an existing tenant's stubs must not change on
    // an upgrade or a second-pack install, so an absent key stays absent.
    if (countries.length === 0 && !('statutoryHolidayPay' in settings)) {
      settings.statutoryHolidayPay = true
    }
    settings.countries = [...new Set([...countries, country])]
    await writePayrollBlob(gate.user.orgId, gate.user.id, settings)
    return NextResponse.json({ ok: true })
  }
  if (body.action === 'uninstall-pack') {
    const country = String(body.country ?? '')
    if (!(country in PAYROLL_COUNTRY_PACKS)) {
      return NextResponse.json({ error: 'unknown country pack' }, { status: 422 })
    }
    try {
      const result = await uninstallPayrollPack(gate.user.orgId, gate.user.id, country)
      return NextResponse.json({ ok: true, ...result })
    } catch (error) {
      if (error instanceof PayrollPackError) {
        return NextResponse.json({ error: error.message }, { status: 409 })
      }
      throw error
    }
  }
  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
