import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { sealSecret } from '@openbooks/engine/src/platform/secrets.ts'
import { FORM_TYPES, type FormType } from '@openbooks/engine/src/compliance/information-returns.ts'
import { guardPermission, guardSubsidiaryScope } from '@/lib/authz'
import { guardComplianceFeature } from '@/lib/compliance'
import { complianceWriteFailure } from '@/lib/compliance-errors'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'

const TAX_CLASSIFICATIONS = new Set([
  'individual',
  'sole_proprietor',
  'partnership',
  'c_corp',
  's_corp',
  'llc',
  'trust_estate',
  'government',
  'nonprofit',
  'other',
])
const TIN_TYPES = new Set(['ssn', 'ein', 'itin', 'atin', 'sin', 'bn', 'unknown'])

/**
 * The compliance mutation's audit envelope is a complete snapshot of every
 * field this route owns, plus row identity/attribution.  `tin_encrypted` is
 * intentionally represented only by presence: ciphertext is sensitive too,
 * while `tin_last4` gives the reviewer enough evidence to identify a change.
 */
const VENDOR_ROLE_AUDIT_COLUMNS = sql`
  id, org_id, party_id, compliance_class_id, information_return_form,
  information_return_box, tax_classification,
  (tin_encrypted is not null) as tin_present, tin_last4, tin_type,
  backup_withholding, is_t4a, is_active, created_at, created_by,
  updated_at, updated_by`

type VendorRoleAuditRow = Record<string, unknown>

/** Every compliance save is attributable even when the UI supplies no note. */
function auditReason(raw: unknown): string {
  return typeof raw === 'string' && raw.trim()
    ? raw.trim().slice(0, 500)
    : 'vendor compliance updated'
}

/**
 * A vendor's compliance classification and taxpayer identification.
 *
 * Kept off the general party route on purpose: the compliance class decides
 * whether this vendor's money can be released, and a TIN is regulated personal
 * data. Both belong behind `compliance.manage`, not behind the permission that
 * lets someone fix a phone number.
 *
 * The TIN is sealed with the org data key before it is stored; only the last
 * four digits are kept in plaintext, and only those are ever read back.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ partyId: string }> }) {
  const gate = await guardPermission('compliance.manage')
  if (gate instanceof NextResponse) return gate
  const blocked = await guardComplianceFeature(gate.user.orgId)
  if (blocked) return blocked
  const { orgId, id: actorId } = gate.user
  const { partyId } = await params
  if (!isUuid(partyId)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // The vendor is the record boundary: a restricted caller may only touch
  // compliance identity for parties inside their fence (null-subsidiary
  // parties are org-wide, mirroring the party lists and the bank-detail
  // route). Without this, a hidden-entity TIN could be overwritten blind.
  const partyScope = await db.execute<{ subsidiaryId: string | null }>(sql`
    select subsidiary_id as "subsidiaryId" from parties
     where id = ${partyId} and org_id = ${orgId}`)
  if (!partyScope.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const scopeDenied = guardSubsidiaryScope(gate, partyScope.rows[0].subsidiaryId, { orgWideNull: true })
  if (scopeDenied) return scopeDenied

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    complianceClassId?: string | null
    informationReturnForm?: string | null
    informationReturnBox?: string | null
    taxClassification?: string | null
    /** Full TIN — sealed here and never returned. Omit to leave unchanged. */
    tin?: string | null
    tinType?: string | null
    backupWithholding?: boolean
    reportable?: boolean
    reason?: string
  }

  if (body.complianceClassId && !isUuid(body.complianceClassId)) {
    return NextResponse.json({ error: 'invalid compliance class' }, { status: 400 })
  }
  if (
    body.informationReturnForm &&
    body.informationReturnForm !== 'none' &&
    !FORM_TYPES.includes(body.informationReturnForm as FormType)
  ) {
    return NextResponse.json({ error: 'unknown information return form' }, { status: 400 })
  }
  if (body.taxClassification && !TAX_CLASSIFICATIONS.has(body.taxClassification)) {
    return NextResponse.json({ error: 'unknown tax classification' }, { status: 400 })
  }
  if (body.tinType && !TIN_TYPES.has(body.tinType)) {
    return NextResponse.json({ error: 'unknown TIN type' }, { status: 400 })
  }
  // Both toggles ride into coalesce() against boolean columns: Postgres would
  // parse 'yes'/'no' but die on anything else, surfacing the full vendor_roles
  // UPDATE through the catch below. Refuse non-booleans with a named 400.
  for (const key of ['backupWithholding', 'reportable'] as const) {
    if (body[key] !== undefined && body[key] !== null && typeof body[key] !== 'boolean') {
      return NextResponse.json({ error: `${key} must be a boolean` }, { status: 400 })
    }
  }

  // A TIN is digits; separators are cosmetic. Reject anything else rather than
  // storing a half-typed number that will fail at the filing channel in January.
  let tinEncrypted: string | null | undefined
  let tinLast4: string | null | undefined
  if (body.tin !== undefined) {
    if (body.tin === null || body.tin.trim() === '') {
      tinEncrypted = null
      tinLast4 = null
    } else {
      const digits = body.tin.replace(/[\s-]/g, '')
      if (!/^\d{9}$/.test(digits)) {
        return NextResponse.json({ error: 'a taxpayer identification number is exactly 9 digits' }, { status: 400 })
      }
      tinEncrypted = sealSecret(digits)
      tinLast4 = digits.slice(-4)
    }
  }

  // The class check runs before the write transaction, not inside it: the
  // catch below maps every unclassified failure to a generic 500, so a
  // computed refusal raised in there would never reach the operator.
  if (body.complianceClassId) {
    const exists = await db.execute(sql`
      select 1 from compliance_classes
       where org_id = ${orgId} and id = ${body.complianceClassId} and is_active`)
    if (exists.rows.length === 0) {
      return NextResponse.json({ error: 'unknown compliance class' }, { status: 400 })
    }
  }

  const reason = auditReason(body.reason)
  let notFound = false
  try {
    await withOrgTransaction(orgId, async () => {
      // Lock the authoritative tenant row before reading its before-state.
      // Every subsequent write and the audit insert participates in this same
      // pinned transaction, so concurrent saves serialize and an audit error
      // rolls the sensitive compliance/TIN mutation back with it.
      const role = await db.execute<VendorRoleAuditRow>(sql`
        select ${VENDOR_ROLE_AUDIT_COLUMNS}
          from vendor_roles
         where org_id = ${orgId} and party_id = ${partyId}
         for update`)
      const before = role.rows[0]
      if (!before) {
        notFound = true
        return
      }

      const updated = await db.execute<VendorRoleAuditRow>(sql`
        update vendor_roles set
          compliance_class_id = ${body.complianceClassId === undefined ? sql`compliance_class_id` : sql`${body.complianceClassId}::uuid`},
          information_return_form = ${body.informationReturnForm === undefined ? sql`information_return_form` : sql`${body.informationReturnForm}`},
          information_return_box = ${body.informationReturnBox === undefined ? sql`information_return_box` : sql`${body.informationReturnBox}`},
          tax_classification = ${body.taxClassification === undefined ? sql`tax_classification` : sql`${body.taxClassification}`},
          tin_encrypted = ${tinEncrypted === undefined ? sql`tin_encrypted` : sql`${tinEncrypted}`},
          tin_last4 = ${tinLast4 === undefined ? sql`tin_last4` : sql`${tinLast4}`},
          tin_type = ${body.tinType === undefined ? sql`tin_type` : sql`${body.tinType}`},
          backup_withholding = coalesce(${body.backupWithholding ?? null}, backup_withholding),
          is_t4a = coalesce(${body.reportable ?? null}, is_t4a),
          updated_at = now(), updated_by = ${actorId}
        where org_id = ${orgId} and party_id = ${partyId}
        returning ${VENDOR_ROLE_AUDIT_COLUMNS}`)
      const after = updated.rows[0]
      // The row was locked by this transaction's own read, so a zero-row
      // update means it vanished under the lock — still the vendor-missing
      // refusal, raised through the flag like the pre-lock read.
      if (!after) {
        notFound = true
        return
      }

      // The audit row is immutable at the database layer. Its actor_id and at
      // columns are written by PostgreSQL, while changes.reason and the exact
      // secret-free before/after snapshots make the evidence attributable and
      // complete without ever persisting TIN ciphertext in the trail.
      await db.execute(sql`
        insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'vendor_roles', ${partyId}, 'update',
                ${JSON.stringify({ reason, before, after })}::jsonb, ${actorId})`)
    })
    if (notFound) return NextResponse.json({ error: 'this party is not a vendor' }, { status: 404 })
    return NextResponse.json({ partyId })
  } catch (e) {
    return complianceWriteFailure(e)
  }
}
