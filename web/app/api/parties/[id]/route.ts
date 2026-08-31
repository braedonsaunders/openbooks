import { jsonObject, parseJsonBody } from '@/lib/api/json'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission, guardSubsidiaryScope, subsidiariesInScope } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { loadFieldDefs, validateCustomValues } from '../../../../lib/custom-fields'
import { isUuid } from '../../../../lib/list-params'
import { normalizeCountryCode } from '../../../../lib/countries'
import { loadParty } from '../_lib'
import { canonicalDecimal, compareDecimal, fixedDecimal } from '../../../../lib/exact-decimal'

export const runtime = 'nodejs'

const PARTY_KINDS = ['company', 'person'] as const
const PAYMENT_METHODS = ['eft', 'cheque', 'card', 'cash', 'other'] as const
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const CURRENCY_RE = /^[A-Za-z]{3}$/

function bad(error: string, fieldErrors?: Record<string, string>) {
  return NextResponse.json({ error, ...(fieldErrors ? { fieldErrors } : {}) }, { status: 422 })
}

class PartyPatchValidationError extends Error {
  constructor(readonly response: NextResponse) {
    super('party patch validation failed')
  }
}

class PartyPatchConflictError extends Error {
  constructor() {
    super('party changed while saving')
  }
}

function throwBad(error: string, fieldErrors?: Record<string, string>): never {
  throw new PartyPatchValidationError(bad(error, fieldErrors))
}

/** Trimmed string or null ('' and non-strings collapse to null). */
function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s === '' ? null : s
}

function uuidOrNull(v: unknown): string | null | 'invalid' {
  const s = strOrNull(v)
  if (s === null) return null
  return isUuid(s) ? s : 'invalid'
}

async function orgRefExists(
  kind: 'terms' | 'receivable' | 'payable' | 'expense' | 'tax' | 'salesRep' | 'department' | 'trade' | 'workerComp',
  id: string | null,
  orgId: string,
): Promise<boolean> {
  if (id === null) return true
  const query =
    kind === 'terms'
      ? sql`select 1 from payment_terms where id = ${id} and org_id = ${orgId} and is_active`
      : kind === 'receivable'
        ? sql`select 1 from accounts where id = ${id} and org_id = ${orgId} and is_active and not is_summary and type = 'asset_receivable'`
        : kind === 'payable'
          ? sql`select 1 from accounts where id = ${id} and org_id = ${orgId} and is_active and not is_summary and type = 'liability_payable'`
          : kind === 'expense'
            ? sql`select 1 from accounts where id = ${id} and org_id = ${orgId} and is_active and not is_summary and type in ('expense', 'expense_other', 'cogs')`
            : kind === 'tax'
              ? sql`select 1 from tax_codes where id = ${id} and org_id = ${orgId} and is_active`
              : kind === 'salesRep'
                ? sql`select 1 from parties p join employee_roles r on r.party_id = p.id and r.org_id = p.org_id and r.is_active where p.id = ${id} and p.org_id = ${orgId} and p.is_active`
                : kind === 'department'
                  ? sql`select 1 from departments where id = ${id} and org_id = ${orgId} and is_active`
                  : kind === 'workerComp'
                    ? sql`select 1 from worker_comp_groups where id = ${id} and org_id = ${orgId} and is_active`
                    : sql`select 1 from trades where id = ${id} and org_id = ${orgId} and is_active`
  const result = await db.execute(query)
  return result.rows.length === 1
}

interface CustomerRoleInput {
  enabled?: boolean
  paymentTermsId?: string | null
  creditLimit?: string | null
  currency?: string | null
  arAccountId?: string | null
  salesRepId?: string | null
  taxCodeId?: string | null
  isOnHold?: boolean
  holdReason?: string | null
}
interface VendorRoleInput {
  enabled?: boolean
  paymentMethod?: string | null
  eftNotificationEmail?: string | null
  paymentTermsId?: string | null
  currency?: string | null
  is1099OrT4a?: boolean
  apAccountId?: string | null
  defaultExpenseAccountId?: string | null
  taxCodeId?: string | null
  isOnHold?: boolean
  holdReason?: string | null
}
interface EmployeeRoleInput {
  enabled?: boolean
  employeeNumber?: string | null
  jobTitle?: string | null
  departmentId?: string | null
  tradeId?: string | null
  workerCompGroupId?: string | null
  hiredOn?: string | null
}
interface AddressInput {
  label?: string | null
  line1?: string | null
  line2?: string | null
  city?: string | null
  region?: string | null
  postalCode?: string | null
  country?: string | null
  isDefaultBilling?: boolean
  isDefaultShipping?: boolean
}
interface ContactInput {
  firstName?: string | null
  lastName?: string | null
  name?: string | null
  title?: string | null
  role?: string | null
  email?: string | null
  phone?: string | null
  mobilePhone?: string | null
  isPrimary?: boolean
  isActive?: boolean
}

interface PatchBody {
  kind?: string
  displayName?: string
  legalName?: string | null
  shortCode?: string | null
  email?: string | null
  phone?: string | null
  website?: string | null
  custom?: Record<string, unknown>
  invoicingPreference?: Record<string, unknown> | null
  roles?: {
    customer?: CustomerRoleInput
    vendor?: VendorRoleInput
    employee?: EmployeeRoleInput
  }
  addresses?: AddressInput[]
  contacts?: ContactInput[]
  isActive?: boolean
  /** Primary subsidiary (null = org root). Only sent by multi-subsidiary orgs. */
  subsidiaryId?: string | null
  /** Full replacement of the ADDITIONAL subsidiaries the party transacts with
   *  (party_subsidiaries, diff-and-synced). Only sent by multi-subsidiary orgs. */
  additionalSubsidiaryIds?: string[]
  expectedUpdatedAt?: string
  changeReason?: string
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('parties.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // Parties are org-wide when their primary subsidiary is null (mirrors the
  // party lists' `is null or = any(...)` predicate).
  const scope = await db.execute<{ subsidiaryId: string | null }>(
    sql`select subsidiary_id as "subsidiaryId" from parties where id = ${id} and org_id = ${gate.user.orgId}`,
  )
  if (!scope.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(gate, scope.rows[0].subsidiaryId, { orgWideNull: true })
  if (denied) return denied
  const payload = await loadParty(id, gate.user.orgId)
  if (!payload) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(payload)
}

/**
 * Autosave for the party flyout: identity fields, custom values, role
 * enable/disable + role fields (upserts), full address replacement, and the
 * explicit activate/deactivate action. Bank accounts are intentionally NOT
 * writable here — add/approve flows belong to the Payments module.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('parties.manage')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const existing = await db.execute<{
    display_name: string
    is_active: boolean
    updated_at: Date
    customer_hold: boolean
    customer_hold_reason: string | null
    vendor_hold: boolean
    vendor_hold_reason: string | null
    subsidiaryId: string | null
    before: Record<string, unknown>
  }>(sql`
    select p.display_name, p.is_active, p.updated_at,
           p.subsidiary_id as "subsidiaryId",
           coalesce(cr.is_on_hold, false) as customer_hold,
           cr.hold_reason as customer_hold_reason,
           coalesce(vr.is_on_hold, false) as vendor_hold,
           vr.hold_reason as vendor_hold_reason,
           jsonb_build_object(
             'party', to_jsonb(p),
             'customerRole', case when cr.id is null then null else to_jsonb(cr) end,
             'vendorRole', case when vr.id is null then null else to_jsonb(vr) end
           ) as before
      from parties p
      left join customer_roles cr on cr.party_id = p.id and cr.org_id = p.org_id
      left join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id
     where p.id = ${id} and p.org_id = ${user.orgId}
  `)
  if (!existing.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const existingParty = existing.rows[0]
  const scopeDenied = guardSubsidiaryScope(gate, existingParty.subsidiaryId, { orgWideNull: true })
  if (scopeDenied) return scopeDenied

  const parsedBody = await parseJsonBody(req, jsonObject)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data as PatchBody
  // Worker-comp group is Payroll configuration living on the employee role.
  // Turning that switch off must refuse a new write; the stored link stays so
  // turning the feature back on restores the same assignment.
  if (body.roles?.employee?.workerCompGroupId !== undefined && !(await isFeatureEnabled(user.orgId, 'payroll'))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  // Customer/vendor currency is Multi-currency configuration living on the
  // role. Turning that switch off must refuse a new write; the stored code
  // stays so turning the feature back on restores the same currency.
  if (
    (body.roles?.customer?.currency !== undefined || body.roles?.vendor?.currency !== undefined) &&
    !(await isFeatureEnabled(user.orgId, 'multiCurrency'))
  ) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const displayName = body.displayName !== undefined ? body.displayName.trim() : undefined
  const completesPlaceholder =
    body.isActive === undefined &&
    existingParty.is_active === false &&
    existingParty.display_name === 'New party' &&
    Boolean(displayName && displayName !== 'New party')
  if (!body.expectedUpdatedAt || new Date(body.expectedUpdatedAt).getTime() !== new Date(existingParty.updated_at).getTime()) {
    return NextResponse.json(
      {
        error: 'this party changed after you opened it; reload and review the latest revision',
      },
      { status: 409 },
    )
  }
  const materialControlChange =
    (body.isActive !== undefined && body.isActive !== existingParty.is_active) ||
    (body.roles?.customer?.isOnHold !== undefined && body.roles.customer.isOnHold !== existingParty.customer_hold) ||
    (body.roles?.customer?.holdReason !== undefined && strOrNull(body.roles.customer.holdReason) !== existingParty.customer_hold_reason) ||
    (body.roles?.vendor?.isOnHold !== undefined && body.roles.vendor.isOnHold !== existingParty.vendor_hold) ||
    (body.roles?.vendor?.holdReason !== undefined && strOrNull(body.roles.vendor.holdReason) !== existingParty.vendor_hold_reason)
  const changeReason = body.changeReason?.trim() ?? ''
  if (materialControlChange && (changeReason.length < 5 || changeReason.length > 500)) {
    return bad('a reason between 5 and 500 characters is required for status and hold changes')
  }
  // Role fields are optional in PATCH bodies. Preserve the authoritative hold
  // controls unless the caller explicitly changes them; an explicit release
  // still flows through the material-control reason gate above.
  const customerOnHold = body.roles?.customer?.isOnHold ?? existingParty.customer_hold
  const customerHoldReason = body.roles?.customer?.holdReason !== undefined
    ? strOrNull(body.roles.customer.holdReason)
    : existingParty.customer_hold_reason
  const vendorOnHold = body.roles?.vendor?.isOnHold ?? existingParty.vendor_hold
  const vendorHoldReason = body.roles?.vendor?.holdReason !== undefined
    ? strOrNull(body.roles.vendor.holdReason)
    : existingParty.vendor_hold_reason
  if (
    body.roles?.customer !== undefined &&
    customerOnHold &&
    (customerHoldReason?.length ?? 0) < 5
  ) {
    return bad('Customer credit hold requires a reason of at least 5 characters')
  }
  if (
    body.roles?.vendor !== undefined &&
    vendorOnHold &&
    (vendorHoldReason?.length ?? 0) < 5
  ) {
    return bad('Vendor payment hold requires a reason of at least 5 characters')
  }
  if (body.isActive === false && existingParty.is_active) {
    const live = await db.execute<{
      in_flight: number
      open_balance_count: number
    }>(sql`
      select
        count(*) filter (
          where status in ('pending_approval', 'approved')
        )::int as in_flight,
        count(*) filter (
          where status = 'posted' and coalesce(open_balance, 0) <> 0
        )::int as open_balance_count
        from documents
       where org_id = ${user.orgId} and party_id = ${id}
    `)
    const row = live.rows[0]
    if ((row?.in_flight ?? 0) > 0 || (row?.open_balance_count ?? 0) > 0) {
      return bad('resolve in-flight transactions and open balances before deactivating this party')
    }
  }

  // -- identity ------------------------------------------------------------
  if (body.kind !== undefined && !PARTY_KINDS.includes(body.kind as (typeof PARTY_KINDS)[number])) {
    return bad('kind must be company or person')
  }
  const willBeActive = body.isActive ?? (completesPlaceholder ? true : existingParty.is_active)
  const effectiveName = displayName ?? existingParty.display_name.trim()
  if (willBeActive && (!effectiveName || effectiveName === 'New party')) {
    return bad(body.isActive === true ? 'Give the party a real name before activating it' : 'An active party needs a display name')
  }

  let cleanedCustom: Record<string, unknown> | null = null
  if (body.custom !== undefined) {
    const defs = await loadFieldDefs('parties')
    const v = validateCustomValues(defs, body.custom)
    if (!v.ok) return bad(Object.values(v.errors)[0]!, v.errors)
    cleanedCustom = v.cleaned
  }

  const website = body.website !== undefined ? strOrNull(body.website) : undefined
  if (website && !/^https?:\/\/|^[\w.-]+\.[a-z]{2,}/i.test(website)) {
    return bad('Website must be a URL or domain')
  }

  const subsidiaryId = body.subsidiaryId !== undefined ? uuidOrNull(body.subsidiaryId) : undefined
  if (subsidiaryId === 'invalid') return bad('Invalid subsidiary')
  let additionalSubsidiaryIds: string[] | undefined
  if (body.additionalSubsidiaryIds !== undefined) {
    if (!Array.isArray(body.additionalSubsidiaryIds) || body.additionalSubsidiaryIds.some((s) => !isUuid(s))) {
      return bad('Invalid additional subsidiaries')
    }
    additionalSubsidiaryIds = [...new Set(body.additionalSubsidiaryIds)].filter((s) => s !== subsidiaryId)
  }
  const requestedSubsidiaries = [
    ...new Set([...(typeof subsidiaryId === 'string' ? [subsidiaryId] : []), ...(additionalSubsidiaryIds ?? [])]),
  ]
  if (requestedSubsidiaries.length > 0) {
    const found = await db.execute<{ id: string }>(sql`
      select id from subsidiaries
       where org_id = ${user.orgId} and is_active and not is_elimination
         and id = any(${`{${requestedSubsidiaries.join(',')}}`}::uuid[])`)
    if (found.rows.length !== requestedSubsidiaries.length) return bad('Invalid subsidiary')
    // A restricted caller may only assign parties to subsidiaries they can see.
    if (!subsidiariesInScope(gate, requestedSubsidiaries)) return bad('Invalid subsidiary')
  }

  // Native customer-level invoicing override (a real column, not custom jsonb).
  let invoicingPref: Record<string, unknown> | null | undefined
  if (body.invoicingPreference !== undefined) {
    const p = body.invoicingPreference
    invoicingPref = p == null || (typeof p === 'object' && Object.values(p).every((v) => v == null)) ? null : p
  }

  try {
    await db.transaction(async (tx) => {
      const updatedParty = await tx.execute<{ id: string }>(sql`
      update parties set
        kind = coalesce(${body.kind ?? null}, kind),
        invoicing_preference = ${invoicingPref !== undefined ? (invoicingPref === null ? sql`null` : sql`${JSON.stringify(invoicingPref)}::jsonb`) : sql`invoicing_preference`},
        display_name = ${displayName !== undefined ? displayName : sql`display_name`},
        legal_name = ${body.legalName !== undefined ? strOrNull(body.legalName) : sql`legal_name`},
        short_code = ${body.shortCode !== undefined ? strOrNull(body.shortCode) : sql`short_code`},
        email = ${body.email !== undefined ? strOrNull(body.email) : sql`email`},
        phone = ${body.phone !== undefined ? strOrNull(body.phone) : sql`phone`},
        website = ${website !== undefined ? website : sql`website`},
        custom = coalesce(${cleanedCustom ? JSON.stringify(cleanedCustom) : null}::jsonb, custom),
        subsidiary_id = ${subsidiaryId !== undefined ? subsidiaryId : sql`subsidiary_id`},
        is_active = ${body.isActive !== undefined ? body.isActive : completesPlaceholder ? true : sql`is_active`},
        updated_at = now(), updated_by = ${user.id}
      where id = ${id} and org_id = ${user.orgId}
        and updated_at = ${existingParty.updated_at}
      returning id
      `)
      if (!updatedParty.rows[0]) {
        throw new PartyPatchConflictError()
      }

      if (additionalSubsidiaryIds !== undefined) {
        await tx.execute(sql`
          delete from party_subsidiaries where org_id = ${user.orgId} and party_id = ${id}`)
        for (const extraId of additionalSubsidiaryIds) {
          await tx.execute(sql`
            insert into party_subsidiaries
              (org_id, party_id, subsidiary_id, created_by, updated_by)
            values (${user.orgId}, ${id}, ${extraId}, ${user.id}, ${user.id})`)
        }
      } else if (typeof subsidiaryId === 'string') {
        await tx.execute(sql`
          delete from party_subsidiaries
           where org_id = ${user.orgId} and party_id = ${id} and subsidiary_id = ${subsidiaryId}`)
      }

      // -- roles ---------------------------------------------------------------
      if (body.roles?.customer) {
        const c = body.roles.customer
        if (c.enabled === false) {
          await tx.execute(sql`
            update customer_roles set is_active = false, updated_at = now(), updated_by = ${user.id}
            where party_id = ${id} and org_id = ${user.orgId}`)
        } else if (c.enabled === true) {
          if (customerOnHold && (customerHoldReason?.length ?? 0) < 5) {
            throwBad('Customer credit hold requires a reason of at least 5 characters')
          }
          const paymentTermsId = uuidOrNull(c.paymentTermsId)
          if (paymentTermsId === 'invalid') throwBad('Invalid customer payment terms')
          const arAccountId = uuidOrNull(c.arAccountId)
          if (arAccountId === 'invalid') throwBad('Invalid receivable account')
          const salesRepId = uuidOrNull(c.salesRepId)
          if (salesRepId === 'invalid') throwBad('Invalid sales representative')
          const taxCodeId = uuidOrNull(c.taxCodeId)
          if (taxCodeId === 'invalid') throwBad('Invalid customer tax code')
          if (!(await orgRefExists('terms', paymentTermsId, user.orgId))) throwBad('Invalid customer payment terms')
          if (!(await orgRefExists('receivable', arAccountId, user.orgId))) throwBad('Invalid receivable account')
          if (!(await orgRefExists('salesRep', salesRepId, user.orgId))) throwBad('Invalid sales representative')
          if (!(await orgRefExists('tax', taxCodeId, user.orgId))) throwBad('Invalid customer tax code')
          const creditLimitRaw = strOrNull(c.creditLimit)
          const creditLimitExact = creditLimitRaw === null ? null : canonicalDecimal(creditLimitRaw, 4)
          if (creditLimitRaw !== null && (creditLimitExact === null || compareDecimal(creditLimitExact, '0') < 0)) {
            throwBad('Credit limit must be a non-negative number')
          }
          const creditLimit = creditLimitExact === null ? null : fixedDecimal(creditLimitExact, 4)
          const currency = c.currency !== undefined ? (strOrNull(c.currency)?.toUpperCase() ?? null) : undefined
          if (currency && !CURRENCY_RE.test(currency)) throwBad('Customer currency must be a 3-letter code')
          await tx.execute(sql`
            insert into customer_roles (org_id, party_id, payment_terms_id, credit_limit, currency,
                                        ar_account_id, sales_rep_id, tax_code_id,
                                        is_on_hold, hold_reason, held_at, held_by,
                                        created_by, updated_by)
            values (${user.orgId}, ${id}, ${paymentTermsId}, ${creditLimit}, ${currency !== undefined ? currency : null},
                    ${arAccountId}, ${salesRepId}, ${taxCodeId},
                    ${customerOnHold}, ${customerOnHold ? customerHoldReason : null},
                    ${customerOnHold ? sql`now()` : null}, ${customerOnHold ? user.id : null},
                    ${user.id}, ${user.id})
            on conflict (party_id) do update set
              payment_terms_id = excluded.payment_terms_id,
              credit_limit = excluded.credit_limit,
              currency = ${currency !== undefined ? currency : sql`customer_roles.currency`},
              ar_account_id = excluded.ar_account_id,
              sales_rep_id = excluded.sales_rep_id,
              tax_code_id = excluded.tax_code_id,
              is_on_hold = excluded.is_on_hold,
              hold_reason = excluded.hold_reason,
              held_at = case
                when customer_roles.is_on_hold = excluded.is_on_hold
                 and customer_roles.hold_reason is not distinct from excluded.hold_reason
                then customer_roles.held_at
                else excluded.held_at
              end,
              held_by = case
                when customer_roles.is_on_hold = excluded.is_on_hold
                 and customer_roles.hold_reason is not distinct from excluded.hold_reason
                then customer_roles.held_by
                else excluded.held_by
              end,
              is_active = true,
              updated_at = now(), updated_by = ${user.id}
            where customer_roles.org_id = ${user.orgId}
          `)
        }
      }

      if (body.roles?.vendor) {
        const v = body.roles.vendor
        if (v.enabled === false) {
          await tx.execute(sql`
            update vendor_roles set is_active = false, updated_at = now(), updated_by = ${user.id}
            where party_id = ${id} and org_id = ${user.orgId}`)
        } else if (v.enabled === true) {
          if (vendorOnHold && (vendorHoldReason?.length ?? 0) < 5) {
            throwBad('Vendor payment hold requires a reason of at least 5 characters')
          }
          const paymentMethod = strOrNull(v.paymentMethod)
          if (paymentMethod && !PAYMENT_METHODS.includes(paymentMethod as (typeof PAYMENT_METHODS)[number])) {
            throwBad('Invalid vendor payment method')
          }
          const paymentTermsId = uuidOrNull(v.paymentTermsId)
          if (paymentTermsId === 'invalid') throwBad('Invalid vendor payment terms')
          const apAccountId = uuidOrNull(v.apAccountId)
          if (apAccountId === 'invalid') throwBad('Invalid payable account')
          const defaultExpenseAccountId = uuidOrNull(v.defaultExpenseAccountId)
          if (defaultExpenseAccountId === 'invalid') throwBad('Invalid default expense account')
          const taxCodeId = uuidOrNull(v.taxCodeId)
          if (taxCodeId === 'invalid') throwBad('Invalid vendor tax code')
          if (!(await orgRefExists('terms', paymentTermsId, user.orgId))) throwBad('Invalid vendor payment terms')
          if (!(await orgRefExists('payable', apAccountId, user.orgId))) throwBad('Invalid payable account')
          if (!(await orgRefExists('expense', defaultExpenseAccountId, user.orgId))) throwBad('Invalid default expense account')
          if (!(await orgRefExists('tax', taxCodeId, user.orgId))) throwBad('Invalid vendor tax code')
          const currency = v.currency !== undefined ? (strOrNull(v.currency)?.toUpperCase() ?? null) : undefined
          if (currency && !CURRENCY_RE.test(currency)) throwBad('Vendor currency must be a 3-letter code')
          await tx.execute(sql`
            insert into vendor_roles (org_id, party_id, payment_method, eft_notification_email,
                                      payment_terms_id, currency, is_t4a, ap_account_id,
                                      default_expense_account_id, tax_code_id,
                                      is_on_hold, hold_reason, held_at, held_by,
                                      created_by, updated_by)
            values (${user.orgId}, ${id}, ${paymentMethod}, ${strOrNull(v.eftNotificationEmail)},
                    ${paymentTermsId}, ${currency !== undefined ? currency : null}, ${v.is1099OrT4a === true}, ${apAccountId},
                    ${defaultExpenseAccountId}, ${taxCodeId},
                    ${vendorOnHold}, ${vendorOnHold ? vendorHoldReason : null},
                    ${vendorOnHold ? sql`now()` : null}, ${vendorOnHold ? user.id : null},
                    ${user.id}, ${user.id})
            on conflict (party_id) do update set
              payment_method = excluded.payment_method,
              eft_notification_email = excluded.eft_notification_email,
              payment_terms_id = excluded.payment_terms_id,
              currency = ${currency !== undefined ? currency : sql`vendor_roles.currency`},
              is_t4a = excluded.is_t4a,
              ap_account_id = excluded.ap_account_id,
              default_expense_account_id = excluded.default_expense_account_id,
              tax_code_id = excluded.tax_code_id,
              is_on_hold = excluded.is_on_hold,
              hold_reason = excluded.hold_reason,
              held_at = case
                when vendor_roles.is_on_hold = excluded.is_on_hold
                 and vendor_roles.hold_reason is not distinct from excluded.hold_reason
                then vendor_roles.held_at
                else excluded.held_at
              end,
              held_by = case
                when vendor_roles.is_on_hold = excluded.is_on_hold
                 and vendor_roles.hold_reason is not distinct from excluded.hold_reason
                then vendor_roles.held_by
                else excluded.held_by
              end,
              is_active = true,
              updated_at = now(), updated_by = ${user.id}
            where vendor_roles.org_id = ${user.orgId}
          `)
        }
      }

      if (body.roles?.employee) {
        const e = body.roles.employee
        if (e.enabled === false) {
          await tx.execute(sql`
            update employee_roles set is_active = false, updated_at = now(), updated_by = ${user.id}
            where party_id = ${id} and org_id = ${user.orgId}`)
        } else if (e.enabled === true) {
          const departmentId = uuidOrNull(e.departmentId)
          if (departmentId === 'invalid') throwBad('Invalid department')
          const tradeId = uuidOrNull(e.tradeId)
          if (tradeId === 'invalid') throwBad('Invalid trade')
          const workerCompGroupId = e.workerCompGroupId !== undefined ? uuidOrNull(e.workerCompGroupId) : undefined
          if (workerCompGroupId === 'invalid') throwBad('Invalid worker-comp group')
          if (!(await orgRefExists('department', departmentId, user.orgId))) throwBad('Invalid department')
          if (!(await orgRefExists('trade', tradeId, user.orgId))) throwBad('Invalid trade')
          if (workerCompGroupId !== undefined && !(await orgRefExists('workerComp', workerCompGroupId, user.orgId))) {
            throwBad('Invalid worker-comp group')
          }
          const hiredOn = strOrNull(e.hiredOn)
          if (hiredOn && !DATE_RE.test(hiredOn)) throwBad('Hired-on must be a date (YYYY-MM-DD)')
          await tx.execute(sql`
            insert into employee_roles (org_id, party_id, employee_number, job_title, department_id, trade_id,
                                        worker_comp_group_id, hired_on, created_by, updated_by)
            values (${user.orgId}, ${id}, ${strOrNull(e.employeeNumber)}, ${strOrNull(e.jobTitle)?.slice(0, 160) ?? null}, ${departmentId}, ${tradeId},
                    ${workerCompGroupId !== undefined ? workerCompGroupId : null}, ${hiredOn}, ${user.id}, ${user.id})
            on conflict (party_id) do update set
              employee_number = excluded.employee_number,
              job_title = excluded.job_title,
              department_id = excluded.department_id,
              trade_id = excluded.trade_id,
              worker_comp_group_id = ${workerCompGroupId !== undefined ? workerCompGroupId : sql`employee_roles.worker_comp_group_id`},
              hired_on = excluded.hired_on,
              is_active = true,
              updated_at = now(), updated_by = ${user.id}
            where employee_roles.org_id = ${user.orgId}
          `)
        }
      }

      // -- addresses: full replacement ----------------------------------------
      if (body.addresses) {
        const invalidCountry = body.addresses.some((address) => {
          const country = strOrNull(address.country)
          return country !== null && normalizeCountryCode(country) === null
        })
        if (invalidCountry) throwBad('Country must be a valid ISO country code')
        const rows = body.addresses
          .map((a) => ({
            label: strOrNull(a.label),
            line1: strOrNull(a.line1),
            line2: strOrNull(a.line2),
            city: strOrNull(a.city),
            region: strOrNull(a.region),
            postalCode: strOrNull(a.postalCode),
            country: normalizeCountryCode(a.country),
            isDefaultBilling: a.isDefaultBilling === true,
            isDefaultShipping: a.isDefaultShipping === true,
          }))
          .filter((a) => a.label || a.line1 || a.line2 || a.city || a.region || a.postalCode || a.country)
        // one default of each kind, at most
        let billingSeen = false
        let shippingSeen = false
        for (const a of rows) {
          if (a.isDefaultBilling) {
            if (billingSeen) a.isDefaultBilling = false
            billingSeen = true
          }
          if (a.isDefaultShipping) {
            if (shippingSeen) a.isDefaultShipping = false
            shippingSeen = true
          }
        }
        await tx.execute(sql`delete from addresses where party_id = ${id} and org_id = ${user.orgId}`)
        for (const a of rows) {
          await tx.execute(sql`
            insert into addresses (org_id, party_id, label, line1, line2, city, region, postal_code,
                                   country, is_default_billing, is_default_shipping, created_by, updated_by)
            values (${user.orgId}, ${id}, ${a.label}, ${a.line1}, ${a.line2}, ${a.city}, ${a.region},
                    ${a.postalCode}, ${a.country}, ${a.isDefaultBilling}, ${a.isDefaultShipping},
                    ${user.id}, ${user.id})
          `)
        }
      }

      // -- contacts: full replacement ----------------------------------------
      if (body.contacts) {
        const rows = body.contacts
          .map((contact) => {
            const firstName = strOrNull(contact.firstName)
            const lastName = strOrNull(contact.lastName)
            const explicitName = strOrNull(contact.name)
            return {
              firstName,
              lastName,
              name: explicitName ?? [firstName, lastName].filter(Boolean).join(' '),
              title: strOrNull(contact.title),
              role: strOrNull(contact.role),
              email: strOrNull(contact.email),
              phone: strOrNull(contact.phone),
              mobilePhone: strOrNull(contact.mobilePhone),
              isPrimary: contact.isPrimary === true,
              isActive: contact.isActive !== false,
            }
          })
          .filter((contact) => contact.name || contact.email || contact.phone || contact.mobilePhone)
        let primarySeen = false
        for (const contact of rows) {
          if (contact.isPrimary) {
            if (primarySeen) contact.isPrimary = false
            primarySeen = true
          }
        }
        await tx.execute(sql`delete from contacts where party_id = ${id} and org_id = ${user.orgId}`)
        for (const contact of rows) {
          await tx.execute(sql`
            insert into contacts (org_id, party_id, first_name, last_name, name, title, role,
                                  email, phone, mobile_phone, is_primary, is_active, created_by, updated_by)
            values (${user.orgId}, ${id}, ${contact.firstName}, ${contact.lastName}, ${contact.name},
                    ${contact.title}, ${contact.role}, ${contact.email}, ${contact.phone},
                    ${contact.mobilePhone}, ${contact.isPrimary}, ${contact.isActive}, ${user.id}, ${user.id})
          `)
        }
      }

      await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values (
          ${user.orgId}, 'parties', ${id}, 'update',
          ${JSON.stringify({
            mode: 'party_update',
            reason: changeReason || (completesPlaceholder ? 'initial party setup completed' : null),
            before: existingParty.before,
            materialControlChange,
          })}::jsonb ||
            jsonb_build_object('after', (
              select jsonb_build_object(
                'party', to_jsonb(party),
                'customerRole', case when customer_role.id is null then null else to_jsonb(customer_role) end,
                'vendorRole', case when vendor_role.id is null then null else to_jsonb(vendor_role) end
              )
                from parties party
                left join customer_roles customer_role
                  on customer_role.party_id = party.id and customer_role.org_id = party.org_id
                left join vendor_roles vendor_role
                  on vendor_role.party_id = party.id and vendor_role.org_id = party.org_id
               where party.id = ${id} and party.org_id = ${user.orgId}
            )),
          ${user.id}, 'ui'
        )
      `)
    })
  } catch (e: unknown) {
    if (e instanceof PartyPatchValidationError) return e.response
    if (e instanceof PartyPatchConflictError) {
      return NextResponse.json(
        {
          error: 'this party changed while you were saving; reload and review the latest revision',
        },
        { status: 409 },
      )
    }
    const msg = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? '')}` : String(e)
    if (msg.includes('parties_org_shortcode')) {
      return bad('That short code is already used by another party')
    }
    throw e
  }

  const payload = await loadParty(id, user.orgId)
  return NextResponse.json(payload)
}
