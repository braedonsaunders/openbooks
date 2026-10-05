import { parseJsonBody } from "@/lib/api/json";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { subsidiariesInScope } from '../../../lib/authz'
import { subsidiaryVisibleFilter } from '../../../lib/subsidiaries'
import { isFeatureEnabled } from '../../../lib/features'
import { resolveIdempotentReplay } from '../../../lib/api/idempotency'
import { findUnownedCustomReferences, loadFieldDefs, validateCustomValues } from '../../../lib/custom-fields'
import { isUuid } from '../../../lib/list-params'
import { normalizeCountryCode } from '../../../lib/countries'
import { isIsoCalendarDate } from '../../../lib/crm-dates'
import { loadParty } from './_lib'
import { canonicalDecimal, compareDecimal, fixedDecimal } from '../../../lib/exact-decimal'
import { notFound } from "@/lib/api/responses";
import { moneyRefusal } from '../../../lib/payroll-decimal-refusal'
import { wholeDigits } from "@openbooks/engine/money";


export const runtime = 'nodejs'

// The stored party vocabulary: role lists (customers/vendors/employees) are
// that kind by construction, and the drawer echoes the stored kind back on
// every save — so POST must accept every kind the column actually holds.
const PARTY_KINDS = ['company', 'person', 'customer', 'vendor', 'employee'] as const
const PAYMENT_METHODS = ['eft', 'cheque', 'card', 'cash', 'other'] as const
const CURRENCY_RE = /^[A-Za-z]{3}$/
// This label belongs to the unsaved new-party drawer and is never valid
// create input, so a request cannot mint a nameless inactive record.
const PLACEHOLDER_NAMES = new Set(['New lead'])

function bad(error: string, field?: string, status = 422) {
  return NextResponse.json({ error, ...(field ? { field } : {}) }, { status })
}

class PartyIdempotencyConflict extends Error {
  readonly status = 409
  readonly code = 'idempotency_key_conflict'
  readonly remedy = 'Close and reopen the drawer to try again with a fresh request.'

  constructor() {
    super('This idempotency key was already used for a different party create request. Close and reopen the drawer to try again with a fresh request.')
  }
}

const partyCreateBody = z.object({
  kind: z.enum(PARTY_KINDS).optional(),
  displayName: z.string(),
  legalName: z.string().nullable().optional(),
  shortCode: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  subsidiaryId: z.string().uuid().nullable().optional(),
  additionalSubsidiaryIds: z.array(z.string().uuid()).optional(),
  roles: z.object({
    customer: z.object({
      enabled: z.boolean().optional(), paymentTermsId: z.string().uuid().nullable().optional(),
      creditLimit: z.string().nullable().optional(), currency: z.string().nullable().optional(),
      arAccountId: z.string().uuid().nullable().optional(), salesRepId: z.string().uuid().nullable().optional(),
      taxCodeId: z.string().uuid().nullable().optional(), isOnHold: z.boolean().optional(),
      holdReason: z.string().nullable().optional(),
    }).strict().optional(),
    vendor: z.object({
      enabled: z.boolean().optional(), paymentMethod: z.enum(PAYMENT_METHODS).nullable().optional(),
      eftNotificationEmail: z.string().nullable().optional(), paymentTermsId: z.string().uuid().nullable().optional(),
      currency: z.string().nullable().optional(), is1099OrT4a: z.boolean().optional(),
      apAccountId: z.string().uuid().nullable().optional(), defaultExpenseAccountId: z.string().uuid().nullable().optional(),
      taxCodeId: z.string().uuid().nullable().optional(), isOnHold: z.boolean().optional(),
      holdReason: z.string().nullable().optional(),
    }).strict().optional(),
    employee: z.object({
      enabled: z.boolean().optional(), employeeNumber: z.string().nullable().optional(), jobTitle: z.string().nullable().optional(),
      departmentId: z.string().uuid().nullable().optional(), tradeId: z.string().uuid().nullable().optional(),
      workerCompGroupId: z.string().uuid().nullable().optional(), hiredOn: z.string().nullable().optional(),
    }).strict().optional(),
  }).strict().optional(),
  // Custom fields are org-configured JSON values; their field registry validates each value below.
  custom: z.record(z.string(), z.json()).optional(),
  invoicingPreference: z.object({
    defaultBasis: z.enum(['date_range', 'draw_amount', 'time_selection', 'milestone']).nullable().optional(),
    backupRequired: z.boolean().nullable().optional(),
    backupType: z.enum(['costed_timesheets', 'timesheets_purchases', 'purchases', 'purchases_shop_time', 'quote_only', 'none']).nullable().optional(),
  }).strict().nullable().optional(),
  addresses: z.array(z.object({
    label: z.string().nullable().optional(), line1: z.string().nullable().optional(), line2: z.string().nullable().optional(),
    city: z.string().nullable().optional(), region: z.string().nullable().optional(), postalCode: z.string().nullable().optional(),
    country: z.string().nullable().optional(), isDefaultBilling: z.boolean().optional(), isDefaultShipping: z.boolean().optional(),
  }).strict()).optional(),
  contacts: z.array(z.object({
    firstName: z.string().nullable().optional(), lastName: z.string().nullable().optional(), name: z.string().nullable().optional(),
    title: z.string().nullable().optional(), role: z.string().nullable().optional(), email: z.string().nullable().optional(),
    phone: z.string().nullable().optional(), mobilePhone: z.string().nullable().optional(), isPrimary: z.boolean().optional(),
    isActive: z.boolean().optional(),
  }).strict()).optional(),
}).strict()

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

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/**
 * Create one tenant-owned party with its roles, addresses, and contacts.
 *
 * The caller supplies a UUID idempotency key, which becomes the party ID.
 * Retrying the same request returns the same party without a duplicate
 * insert or audit event; a different payload under that key conflicts.
 *
 * This is the only write path for new parties: the directory opens an
 * unsaved drawer (zero writes) and this endpoint persists it exactly once.
 */
export const POST = defineRoute({
  permission: 'parties.manage',
  feature: { none: 'Parties are shared master records; CRM capabilities do not gate their creation.' },
  handler: async ({ request, authz: gate }) => {
  const user = gate.user

  const requestId = request.headers.get('Idempotency-Key')?.trim() ?? ''
  if (!isUuid(requestId)) return bad('invalid_idempotency_key', undefined, 400)

  const parsedBody = await parseJsonBody(request, partyCreateBody)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data

  // Worker-comp group is Payroll configuration living on the employee role.
  // Turning that switch off must refuse a new write; the stored link stays so
  // turning the feature back on restores the same assignment.
  const employeeInput = asRecord(asRecord(body.roles).employee)
  if (employeeInput.workerCompGroupId !== undefined && !(await isFeatureEnabled(user.orgId, 'payroll'))) {
    return notFound("record")
  }
  // Customer/vendor currency is Multi-currency configuration living on the
  // role. Turning that switch off must refuse a new write; the stored code
  // stays so turning the feature back on restores the same currency.
  const customerInput = asRecord(asRecord(body.roles).customer)
  const vendorInput = asRecord(asRecord(body.roles).vendor)
  if (
    (customerInput.currency !== undefined || vendorInput.currency !== undefined) &&
    !(await isFeatureEnabled(user.orgId, 'multiCurrency'))
  ) {
    return notFound("record")
  }

  if (body.kind !== undefined && !PARTY_KINDS.includes(body.kind as (typeof PARTY_KINDS)[number])) {
    return bad('invalid_kind', 'kind')
  }
  const kind = (typeof body.kind === 'string' ? body.kind : 'company') as (typeof PARTY_KINDS)[number]
  // A customer/vendor/employee kind is a claim about the role rows: the
  // lists, the drawer tabs, and compliance all resolve the role, never the
  // kind column. Storing the kind without the role strands a "Kind: Vendor"
  // no read can back, so refuse it by name instead of persisting it.
  if (kind === 'customer' || kind === 'vendor' || kind === 'employee') {
    const roleInput = asRecord(asRecord(body.roles)[kind])
    if (roleInput.enabled !== true) {
      return bad(
        `kind "${kind}" needs the ${kind} role — enable roles.${kind}.enabled or use kind "company" or "person"`,
        'kind',
      )
    }
  }
  const displayName = strOrNull(body.displayName) ?? ''
  if (!displayName || PLACEHOLDER_NAMES.has(displayName)) {
    return bad('name_required', 'displayName')
  }
  if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
    return bad('isActive must be a boolean', 'isActive', 400)
  }
  const isActive = body.isActive !== false

  const website = body.website !== undefined ? strOrNull(body.website) : null
  if (website && !/^https?:\/\/|^[\w.-]+\.[a-z]{2,}/i.test(website)) {
    return bad('Website must be a URL or domain', 'website')
  }

  const subsidiaryId = body.subsidiaryId !== undefined ? uuidOrNull(body.subsidiaryId) : null
  if (subsidiaryId === 'invalid') return bad('Invalid subsidiary', 'subsidiaryId')
  let additionalSubsidiaryIds: string[] = []
  if (body.additionalSubsidiaryIds !== undefined) {
    if (!Array.isArray(body.additionalSubsidiaryIds) || body.additionalSubsidiaryIds.some((s) => !isUuid(String(s)))) {
      return bad('Invalid additional subsidiaries', 'additionalSubsidiaryIds')
    }
    additionalSubsidiaryIds = [...new Set(body.additionalSubsidiaryIds.map(String))].filter((s) => s !== subsidiaryId)
  }
  const requestedSubsidiaries = [
    ...new Set([...(typeof subsidiaryId === 'string' ? [subsidiaryId] : []), ...additionalSubsidiaryIds]),
  ]
  if (requestedSubsidiaries.length > 0) {
    const found = await db.execute<{ id: string }>(sql`
      select id from subsidiaries
       where org_id = ${user.orgId} and is_active and not is_elimination
         and id = any(${`{${requestedSubsidiaries.join(',')}}`}::uuid[])`)
    if (found.rows.length !== requestedSubsidiaries.length) return bad('Invalid subsidiary', 'subsidiaryId')
    // A restricted caller may only assign parties to subsidiaries they can see.
    if (!subsidiariesInScope(gate, requestedSubsidiaries)) return bad('Invalid subsidiary', 'subsidiaryId')
  }

  const defs = await loadFieldDefs('parties')
  const customResult = validateCustomValues(defs, asRecord(body.custom))
  if (!customResult.ok) return bad('invalid_custom_fields', 'custom')
  // Reference custom values are uuid-SHAPED at this point but nothing proves
  // the referenced row belongs to the caller: refuse foreign or dangling ids
  // instead of persisting a cross-tenant pointer.
  const unowned = await findUnownedCustomReferences(user.orgId, defs, customResult.cleaned)
  if (unowned.length > 0) return bad('unknown_custom_reference', 'custom')
  const custom = customResult.cleaned

  // Native customer-level invoicing override (a real column, not custom jsonb).
  const invoicingRaw = body.invoicingPreference
  const invoicingPreference =
    invoicingRaw == null || (typeof invoicingRaw === 'object' && Object.values(invoicingRaw).every((v) => v == null))
      ? null
      : invoicingRaw as Record<string, unknown>

  // -- roles ---------------------------------------------------------------
  let customer: Record<string, unknown> | null = null
  if (customerInput.enabled === true) {
    const paymentTermsId = uuidOrNull(customerInput.paymentTermsId)
    if (paymentTermsId === 'invalid') return bad('Invalid customer payment terms', 'roles')
    const arAccountId = uuidOrNull(customerInput.arAccountId)
    if (arAccountId === 'invalid') return bad('Invalid receivable account', 'roles')
    const salesRepId = uuidOrNull(customerInput.salesRepId)
    if (salesRepId === 'invalid') return bad('Invalid sales representative', 'roles')
    const taxCodeId = uuidOrNull(customerInput.taxCodeId)
    if (taxCodeId === 'invalid') return bad('Invalid customer tax code', 'roles')
    if (!(await orgRefExists('terms', paymentTermsId, user.orgId))) return bad('Invalid customer payment terms', 'roles')
    if (!(await orgRefExists('salesRep', salesRepId, user.orgId))) return bad('Invalid sales representative', 'roles')
    if (!(await orgRefExists('tax', taxCodeId, user.orgId))) return bad('Invalid customer tax code', 'roles')
    const creditLimitRaw = strOrNull(customerInput.creditLimit)
    const creditLimitExact = creditLimitRaw === null ? null : canonicalDecimal(creditLimitRaw, 4)
    if (creditLimitRaw !== null && creditLimitExact === null) {
      return bad(moneyRefusal('Credit limit', creditLimitRaw, 'an amount', 4, 15), 'roles')
    }
    if (creditLimitExact !== null && compareDecimal(creditLimitExact, '0') < 0) {
      return bad('Credit limit must be a non-negative amount', 'roles')
    }
    if (creditLimitExact !== null && wholeDigits(creditLimitExact) > 15) {
      return bad(moneyRefusal('Credit limit', creditLimitRaw, 'an amount', 4, 15), 'roles')
    }
    const creditLimit = creditLimitExact === null ? null : fixedDecimal(creditLimitExact, 4)
    const currency = customerInput.currency !== undefined ? (strOrNull(customerInput.currency)?.toUpperCase() ?? null) : null
    if (currency && !CURRENCY_RE.test(currency)) return bad('Customer currency must be a 3-letter code', 'roles')
    const isOnHold = customerInput.isOnHold === true
    const holdReason = strOrNull(customerInput.holdReason)
    if (isOnHold && (holdReason?.length ?? 0) < 5) {
      return bad('Customer credit hold requires a reason of at least 5 characters', 'roles')
    }
    customer = {
      paymentTermsId, creditLimit, currency, arAccountId, salesRepId, taxCodeId,
      isOnHold, holdReason: isOnHold ? holdReason : null,
    }
  }

  let vendor: Record<string, unknown> | null = null
  if (vendorInput.enabled === true) {
    const paymentMethod = strOrNull(vendorInput.paymentMethod)
    if (paymentMethod && !PAYMENT_METHODS.includes(paymentMethod as (typeof PAYMENT_METHODS)[number])) {
      return bad('Invalid vendor payment method', 'roles')
    }
    const paymentTermsId = uuidOrNull(vendorInput.paymentTermsId)
    if (paymentTermsId === 'invalid') return bad('Invalid vendor payment terms', 'roles')
    const apAccountId = uuidOrNull(vendorInput.apAccountId)
    if (apAccountId === 'invalid') return bad('Invalid payable account', 'roles')
    const defaultExpenseAccountId = uuidOrNull(vendorInput.defaultExpenseAccountId)
    if (defaultExpenseAccountId === 'invalid') return bad('Invalid default expense account', 'roles')
    const taxCodeId = uuidOrNull(vendorInput.taxCodeId)
    if (taxCodeId === 'invalid') return bad('Invalid vendor tax code', 'roles')
    if (!(await orgRefExists('terms', paymentTermsId, user.orgId))) return bad('Invalid vendor payment terms', 'roles')
    if (!(await orgRefExists('tax', taxCodeId, user.orgId))) return bad('Invalid vendor tax code', 'roles')
    const currency = vendorInput.currency !== undefined ? (strOrNull(vendorInput.currency)?.toUpperCase() ?? null) : null
    if (currency && !CURRENCY_RE.test(currency)) return bad('Vendor currency must be a 3-letter code', 'roles')
    const isOnHold = vendorInput.isOnHold === true
    const holdReason = strOrNull(vendorInput.holdReason)
    if (isOnHold && (holdReason?.length ?? 0) < 5) {
      return bad('Vendor payment hold requires a reason of at least 5 characters', 'roles')
    }
    vendor = {
      paymentMethod, eftNotificationEmail: strOrNull(vendorInput.eftNotificationEmail),
      paymentTermsId, currency, is1099OrT4a: vendorInput.is1099OrT4a === true,
      apAccountId, defaultExpenseAccountId, taxCodeId,
      isOnHold, holdReason: isOnHold ? holdReason : null,
    }
  }

  let employee: Record<string, unknown> | null = null
  if (employeeInput.enabled === true) {
    const departmentId = uuidOrNull(employeeInput.departmentId)
    if (departmentId === 'invalid') return bad('Invalid department', 'roles')
    const tradeId = uuidOrNull(employeeInput.tradeId)
    if (tradeId === 'invalid') return bad('Invalid trade', 'roles')
    const workerCompGroupId = employeeInput.workerCompGroupId !== undefined ? uuidOrNull(employeeInput.workerCompGroupId) : null
    if (workerCompGroupId === 'invalid') return bad('Invalid worker-comp group', 'roles')
    if (!(await orgRefExists('department', departmentId, user.orgId))) return bad('Invalid department', 'roles')
    if (!(await orgRefExists('trade', tradeId, user.orgId))) return bad('Invalid trade', 'roles')
    if (workerCompGroupId !== null && !(await orgRefExists('workerComp', workerCompGroupId, user.orgId))) {
      return bad('Invalid worker-comp group', 'roles')
    }
    const hiredOn = strOrNull(employeeInput.hiredOn)
    if (hiredOn && !isIsoCalendarDate(hiredOn)) return bad('Hired-on must be a valid calendar date (YYYY-MM-DD)', 'roles')
    employee = {
      employeeNumber: strOrNull(employeeInput.employeeNumber),
      jobTitle: strOrNull(employeeInput.jobTitle)?.slice(0, 160) ?? null,
      departmentId, tradeId, workerCompGroupId, hiredOn,
    }
  }

  // -- addresses: blank rows never persist; one default of each kind --------
  const rawAddresses = Array.isArray(body.addresses) ? body.addresses : []
  for (const raw of rawAddresses) {
    const country = strOrNull(asRecord(raw).country)
    if (country !== null && normalizeCountryCode(country) === null) {
      return bad('Country must be a valid ISO country code', 'addresses')
    }
  }
  const addressRows = rawAddresses.map((a) => {
    const r = asRecord(a)
    return {
      label: strOrNull(r.label),
      line1: strOrNull(r.line1),
      line2: strOrNull(r.line2),
      city: strOrNull(r.city),
      region: strOrNull(r.region),
      postalCode: strOrNull(r.postalCode),
      country: normalizeCountryCode(strOrNull(r.country)),
      isDefaultBilling: r.isDefaultBilling === true,
      isDefaultShipping: r.isDefaultShipping === true,
    }
  })
  const addresses = addressRows.filter((a) => a.label || a.line1 || a.line2 || a.city || a.region || a.postalCode || a.country)
  {
    let billingSeen = false
    let shippingSeen = false
    for (const a of addresses) {
      if (a.isDefaultBilling) {
        if (billingSeen) a.isDefaultBilling = false
        billingSeen = true
      }
      if (a.isDefaultShipping) {
        if (shippingSeen) a.isDefaultShipping = false
        shippingSeen = true
      }
    }
  }

  // -- contacts: blank rows never persist; one primary at most --------------
  const contacts = (
    Array.isArray(body.contacts)
      ? body.contacts.map((c) => {
          const r = asRecord(c)
          const firstName = strOrNull(r.firstName)
          const lastName = strOrNull(r.lastName)
          return {
            firstName,
            lastName,
            name: strOrNull(r.name) ?? [firstName, lastName].filter(Boolean).join(' '),
            title: strOrNull(r.title),
            role: strOrNull(r.role),
            email: strOrNull(r.email),
            phone: strOrNull(r.phone),
            mobilePhone: strOrNull(r.mobilePhone),
            isPrimary: r.isPrimary === true,
            isActive: r.isActive !== false,
          }
        })
      : []
  ).filter((c) => c.name || c.email || c.phone || c.mobilePhone)
  {
    let primarySeen = false
    for (const c of contacts) {
      if (c.isPrimary) {
        if (primarySeen) c.isPrimary = false
        primarySeen = true
      }
    }
  }

  const snapshot = {
    id: requestId,
    org_id: user.orgId,
    kind,
    display_name: displayName,
    legal_name: strOrNull(body.legalName),
    short_code: strOrNull(body.shortCode),
    email: strOrNull(body.email),
    phone: strOrNull(body.phone),
    website,
    custom,
    invoicing_preference: invoicingPreference,
    subsidiary_id: subsidiaryId,
    additional_subsidiary_ids: additionalSubsidiaryIds,
    is_active: isActive,
    roles: { customer, vendor, employee },
    addresses,
    contacts,
  }

  let created = false
  try {
    created = await db.transaction(async (tx) => {
      // An id collision is the expected duplicate-retry shape; the immutable
      // insert audit snapshot below decides whether that retry may replay.
      const inserted = (await tx.execute<{ id: string }>(sql`
        insert into parties
          (id, org_id, kind, display_name, legal_name, short_code, email, phone,
           website, custom, invoicing_preference, subsidiary_id, is_active,
           created_by, updated_by)
        values
          (${requestId}, ${user.orgId}, ${kind}, ${displayName},
           ${strOrNull(body.legalName)}, ${strOrNull(body.shortCode)},
           ${strOrNull(body.email)}, ${strOrNull(body.phone)}, ${website},
           ${JSON.stringify(custom)}::jsonb,
           ${invoicingPreference === null ? sql`null` : sql`${JSON.stringify(invoicingPreference)}::jsonb`},
           ${subsidiaryId}, ${isActive}, ${user.id}, ${user.id})
        -- A retry is accepted only after the existing audited create payload is verified below.
        on conflict (id) do nothing
        returning id
      `))
      if (!inserted.rows[0]) {
        const replay = await resolveIdempotentReplay(tx, {
          orgId: user.orgId,
          table: 'parties',
          key: requestId,
          match: snapshot,
        })
        if (replay !== 'replay') throw new PartyIdempotencyConflict()
        return false
      }
      if (customer?.arAccountId) {
        const account = await tx.execute(sql`
          select a.id from accounts a
           where a.id = ${customer.arAccountId as string} and a.org_id = ${user.orgId}
             and a.is_active and not a.is_summary and a.type = 'asset_receivable'
             and (a.subsidiary_id is null or a.subsidiary_id = ${subsidiaryId}::uuid)
             ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, gate.allowedSubsidiaryIds, { orgWideNull: true })}
           for key share`)
        if (!account.rows.length) throw new Error('invalid_receivable_account_for_party_subsidiary')
      }
      if (vendor?.apAccountId) {
        const account = await tx.execute(sql`
          select a.id from accounts a
           where a.id = ${vendor.apAccountId as string} and a.org_id = ${user.orgId}
             and a.is_active and not a.is_summary and a.type = 'liability_payable'
             and (a.subsidiary_id is null or a.subsidiary_id = ${subsidiaryId}::uuid)
             ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, gate.allowedSubsidiaryIds, { orgWideNull: true })}
           for key share`)
        if (!account.rows.length) throw new Error('invalid_payable_account_for_party_subsidiary')
      }
      if (vendor?.defaultExpenseAccountId) {
        const account = await tx.execute(sql`
          select a.id from accounts a
           where a.id = ${vendor.defaultExpenseAccountId as string} and a.org_id = ${user.orgId}
             and a.is_active and not a.is_summary and a.type in ('expense', 'expense_other', 'cogs')
             and (a.subsidiary_id is null or a.subsidiary_id = ${subsidiaryId}::uuid)
             ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, gate.allowedSubsidiaryIds, { orgWideNull: true })}
           for key share`)
        if (!account.rows.length) throw new Error('invalid_default_expense_account_for_party_subsidiary')
      }
      if (customer) {
        await tx.execute(sql`
          insert into customer_roles (org_id, party_id, payment_terms_id, credit_limit, currency,
                                      ar_account_id, sales_rep_id, tax_code_id,
                                      is_on_hold, hold_reason, held_at, held_by,
                                      created_by, updated_by)
          values (${user.orgId}, ${requestId}, ${customer.paymentTermsId as string | null},
                  ${customer.creditLimit as string | null}, ${customer.currency as string | null},
                  ${customer.arAccountId as string | null}, ${customer.salesRepId as string | null},
                  ${customer.taxCodeId as string | null},
                  ${customer.isOnHold as boolean}, ${customer.holdReason as string | null},
                  ${customer.isOnHold ? sql`now()` : null}, ${customer.isOnHold ? user.id : null},
                  ${user.id}, ${user.id})
        `)
      }
      if (vendor) {
        await tx.execute(sql`
          insert into vendor_roles (org_id, party_id, payment_method, eft_notification_email,
                                    payment_terms_id, currency, is_t4a, ap_account_id,
                                    default_expense_account_id, tax_code_id,
                                    is_on_hold, hold_reason, held_at, held_by,
                                    created_by, updated_by)
          values (${user.orgId}, ${requestId}, ${vendor.paymentMethod as string | null},
                  ${vendor.eftNotificationEmail as string | null}, ${vendor.paymentTermsId as string | null},
                  ${vendor.currency as string | null}, ${vendor.is1099OrT4a as boolean},
                  ${vendor.apAccountId as string | null}, ${vendor.defaultExpenseAccountId as string | null},
                  ${vendor.taxCodeId as string | null},
                  ${vendor.isOnHold as boolean}, ${vendor.holdReason as string | null},
                  ${vendor.isOnHold ? sql`now()` : null}, ${vendor.isOnHold ? user.id : null},
                  ${user.id}, ${user.id})
        `)
      }
      if (employee) {
        await tx.execute(sql`
          insert into employee_roles (org_id, party_id, employee_number, job_title, department_id, trade_id,
                                      worker_comp_group_id, hired_on, created_by, updated_by)
          values (${user.orgId}, ${requestId}, ${employee.employeeNumber as string | null},
                  ${employee.jobTitle as string | null}, ${employee.departmentId as string | null},
                  ${employee.tradeId as string | null}, ${employee.workerCompGroupId as string | null},
                  ${employee.hiredOn as string | null}, ${user.id}, ${user.id})
        `)
      }
      for (const a of addresses) {
        await tx.execute(sql`
          insert into addresses (org_id, party_id, label, line1, line2, city, region, postal_code,
                                 country, is_default_billing, is_default_shipping, created_by, updated_by)
          values (${user.orgId}, ${requestId}, ${a.label}, ${a.line1}, ${a.line2}, ${a.city}, ${a.region},
                  ${a.postalCode}, ${a.country}, ${a.isDefaultBilling}, ${a.isDefaultShipping},
                  ${user.id}, ${user.id})
        `)
      }
      for (const c of contacts) {
        await tx.execute(sql`
          insert into contacts (org_id, party_id, first_name, last_name, name, title, role,
                                email, phone, mobile_phone, is_primary, is_active, created_by, updated_by)
          values (${user.orgId}, ${requestId}, ${c.firstName}, ${c.lastName}, ${c.name},
                  ${c.title}, ${c.role}, ${c.email}, ${c.phone},
                  ${c.mobilePhone}, ${c.isPrimary}, ${c.isActive}, ${user.id}, ${user.id})
        `)
      }
      for (const extraId of additionalSubsidiaryIds) {
        await tx.execute(sql`
          insert into party_subsidiaries
            (org_id, party_id, subsidiary_id, created_by, updated_by)
          values (${user.orgId}, ${requestId}, ${extraId}, ${user.id}, ${user.id})`)
      }
      await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values
          (${user.orgId}, 'parties', ${requestId}, 'insert',
           ${JSON.stringify({ before: null, after: snapshot })}::jsonb,
           ${user.id}, ${requestId})
      `)
      return true
    })
  } catch (error) {
    const message = error instanceof Error
      ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}`
      : String(error)
    if (error instanceof PartyIdempotencyConflict) throw error
    if (message.includes('parties_org_shortcode')) return bad('That short code is already used by another party', 'shortCode')
    if (message.includes('invalid_receivable_account_for_party_subsidiary')) return bad('Invalid receivable account for this party subsidiary', 'roles')
    if (message.includes('invalid_payable_account_for_party_subsidiary')) return bad('Invalid payable account for this party subsidiary', 'roles')
    if (message.includes('invalid_default_expense_account_for_party_subsidiary')) return bad('Invalid default expense account for this party subsidiary', 'roles')
    throw error
  }

  const payload = await loadParty(requestId, user.orgId, gate.allowedSubsidiaryIds)
  if (!payload) return bad('save_failed', undefined, 500)
  return NextResponse.json(payload, { status: created ? 201 : 200 })
  },
})
