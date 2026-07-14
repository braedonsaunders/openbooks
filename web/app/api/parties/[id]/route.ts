import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../lib/authz'
import { loadFieldDefs, validateCustomValues } from '../../../../lib/custom-fields'
import { isUuid } from '../../../../lib/list-params'
import { loadParty } from '../_lib'

export const runtime = 'nodejs'

const PARTY_KINDS = ['company', 'person'] as const
const PAYMENT_METHODS = ['eft', 'cheque', 'card', 'cash', 'other'] as const
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const CURRENCY_RE = /^[A-Za-z]{3}$/

function bad(error: string, fieldErrors?: Record<string, string>) {
  return NextResponse.json({ error, ...(fieldErrors ? { fieldErrors } : {}) }, { status: 422 })
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

interface CustomerRoleInput {
  enabled?: boolean
  paymentTermsId?: string | null
  creditLimit?: string | null
  currency?: string | null
}
interface VendorRoleInput {
  enabled?: boolean
  paymentMethod?: string | null
  eftNotificationEmail?: string | null
  paymentTermsId?: string | null
  currency?: string | null
  is1099OrT4a?: boolean
}
interface EmployeeRoleInput {
  enabled?: boolean
  employeeNumber?: string | null
  departmentId?: string | null
  tradeId?: string | null
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

interface PatchBody {
  kind?: string
  displayName?: string
  legalName?: string | null
  shortCode?: string | null
  email?: string | null
  phone?: string | null
  website?: string | null
  custom?: Record<string, unknown>
  roles?: {
    customer?: CustomerRoleInput
    vendor?: VendorRoleInput
    employee?: EmployeeRoleInput
  }
  addresses?: AddressInput[]
  isActive?: boolean
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('parties.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
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

  const existing = (await db.execute(sql`
    select display_name, is_active from parties where id = ${id} and org_id = ${user.orgId}
  `)) as unknown as { rows: { display_name: string; is_active: boolean }[] }
  if (!existing.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const body = (await req.json()) as PatchBody

  // -- identity ------------------------------------------------------------
  if (body.kind !== undefined && !PARTY_KINDS.includes(body.kind as (typeof PARTY_KINDS)[number])) {
    return bad('kind must be company or person')
  }
  const displayName = body.displayName !== undefined ? body.displayName.trim() : undefined

  const willBeActive = body.isActive ?? existing.rows[0].is_active
  const effectiveName = displayName ?? existing.rows[0].display_name.trim()
  if (willBeActive && (!effectiveName || effectiveName === 'New party')) {
    return bad(
      body.isActive === true
        ? 'Give the party a real name before activating it'
        : 'An active party needs a display name',
    )
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

  try {
    await db.execute(sql`
      update parties set
        kind = coalesce(${body.kind ?? null}, kind),
        display_name = ${displayName !== undefined ? displayName : sql`display_name`},
        legal_name = ${body.legalName !== undefined ? strOrNull(body.legalName) : sql`legal_name`},
        short_code = ${body.shortCode !== undefined ? strOrNull(body.shortCode) : sql`short_code`},
        email = ${body.email !== undefined ? strOrNull(body.email) : sql`email`},
        phone = ${body.phone !== undefined ? strOrNull(body.phone) : sql`phone`},
        website = ${website !== undefined ? website : sql`website`},
        custom = coalesce(${cleanedCustom ? JSON.stringify(cleanedCustom) : null}::jsonb, custom),
        is_active = ${body.isActive !== undefined ? body.isActive : sql`is_active`},
        updated_at = now(), updated_by = ${user.id}
      where id = ${id}
    `)
  } catch (e: unknown) {
    const msg = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? '')}` : String(e)
    if (msg.includes('parties_org_shortcode')) {
      return bad('That short code is already used by another party')
    }
    throw e
  }

  // -- roles ---------------------------------------------------------------
  if (body.roles?.customer) {
    const c = body.roles.customer
    if (c.enabled === false) {
      await db.execute(sql`
        update customer_roles set is_active = false, updated_at = now(), updated_by = ${user.id}
        where party_id = ${id}`)
    } else if (c.enabled === true) {
      const paymentTermsId = uuidOrNull(c.paymentTermsId)
      if (paymentTermsId === 'invalid') return bad('Invalid customer payment terms')
      const creditLimitRaw = strOrNull(c.creditLimit)
      if (creditLimitRaw !== null && (Number.isNaN(Number(creditLimitRaw)) || Number(creditLimitRaw) < 0)) {
        return bad('Credit limit must be a non-negative number')
      }
      const creditLimit = creditLimitRaw === null ? null : Number(creditLimitRaw).toFixed(4)
      const currency = strOrNull(c.currency)?.toUpperCase() ?? null
      if (currency && !CURRENCY_RE.test(currency)) return bad('Customer currency must be a 3-letter code')
      await db.execute(sql`
        insert into customer_roles (org_id, party_id, payment_terms_id, credit_limit, currency, created_by, updated_by)
        values (${user.orgId}, ${id}, ${paymentTermsId}, ${creditLimit}, ${currency}, ${user.id}, ${user.id})
        on conflict (party_id) do update set
          payment_terms_id = excluded.payment_terms_id,
          credit_limit = excluded.credit_limit,
          currency = excluded.currency,
          is_active = true,
          updated_at = now(), updated_by = ${user.id}
      `)
    }
  }

  if (body.roles?.vendor) {
    const v = body.roles.vendor
    if (v.enabled === false) {
      await db.execute(sql`
        update vendor_roles set is_active = false, updated_at = now(), updated_by = ${user.id}
        where party_id = ${id}`)
    } else if (v.enabled === true) {
      const paymentMethod = strOrNull(v.paymentMethod)
      if (paymentMethod && !PAYMENT_METHODS.includes(paymentMethod as (typeof PAYMENT_METHODS)[number])) {
        return bad('Invalid vendor payment method')
      }
      const paymentTermsId = uuidOrNull(v.paymentTermsId)
      if (paymentTermsId === 'invalid') return bad('Invalid vendor payment terms')
      const currency = strOrNull(v.currency)?.toUpperCase() ?? null
      if (currency && !CURRENCY_RE.test(currency)) return bad('Vendor currency must be a 3-letter code')
      await db.execute(sql`
        insert into vendor_roles (org_id, party_id, payment_method, eft_notification_email,
                                  payment_terms_id, currency, is_t4a, created_by, updated_by)
        values (${user.orgId}, ${id}, ${paymentMethod}, ${strOrNull(v.eftNotificationEmail)},
                ${paymentTermsId}, ${currency}, ${v.is1099OrT4a === true}, ${user.id}, ${user.id})
        on conflict (party_id) do update set
          payment_method = excluded.payment_method,
          eft_notification_email = excluded.eft_notification_email,
          payment_terms_id = excluded.payment_terms_id,
          currency = excluded.currency,
          is_t4a = excluded.is_t4a,
          is_active = true,
          updated_at = now(), updated_by = ${user.id}
      `)
    }
  }

  if (body.roles?.employee) {
    const e = body.roles.employee
    if (e.enabled === false) {
      await db.execute(sql`
        update employee_roles set is_active = false, updated_at = now(), updated_by = ${user.id}
        where party_id = ${id}`)
    } else if (e.enabled === true) {
      const departmentId = uuidOrNull(e.departmentId)
      if (departmentId === 'invalid') return bad('Invalid department')
      const tradeId = uuidOrNull(e.tradeId)
      if (tradeId === 'invalid') return bad('Invalid trade')
      const hiredOn = strOrNull(e.hiredOn)
      if (hiredOn && !DATE_RE.test(hiredOn)) return bad('Hired-on must be a date (YYYY-MM-DD)')
      await db.execute(sql`
        insert into employee_roles (org_id, party_id, employee_number, department_id, trade_id,
                                    hired_on, created_by, updated_by)
        values (${user.orgId}, ${id}, ${strOrNull(e.employeeNumber)}, ${departmentId}, ${tradeId},
                ${hiredOn}, ${user.id}, ${user.id})
        on conflict (party_id) do update set
          employee_number = excluded.employee_number,
          department_id = excluded.department_id,
          trade_id = excluded.trade_id,
          hired_on = excluded.hired_on,
          is_active = true,
          updated_at = now(), updated_by = ${user.id}
      `)
    }
  }

  // -- addresses: full replacement ------------------------------------------
  if (body.addresses) {
    const rows = body.addresses
      .map((a) => ({
        label: strOrNull(a.label),
        line1: strOrNull(a.line1),
        line2: strOrNull(a.line2),
        city: strOrNull(a.city),
        region: strOrNull(a.region),
        postalCode: strOrNull(a.postalCode),
        country: strOrNull(a.country),
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
    await db.execute(sql`delete from addresses where party_id = ${id}`)
    for (const a of rows) {
      await db.execute(sql`
        insert into addresses (org_id, party_id, label, line1, line2, city, region, postal_code,
                               country, is_default_billing, is_default_shipping, created_by, updated_by)
        values (${user.orgId}, ${id}, ${a.label}, ${a.line1}, ${a.line2}, ${a.city}, ${a.region},
                ${a.postalCode}, ${a.country}, ${a.isDefaultBilling}, ${a.isDefaultShipping},
                ${user.id}, ${user.id})
      `)
    }
  }

  const payload = await loadParty(id, user.orgId)
  return NextResponse.json(payload)
}
