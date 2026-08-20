import 'server-only'
import { redirect } from 'next/navigation'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  evaluateBillsForRelease,
  evaluateVendorCompliance,
  loadRequirementPolicies,
  type BillReleaseDecision,
  type ComplianceState,
  type EvidenceRecord,
  type LienWaiverEnforcement,
  type LienWaiverType,
  type RequirementFinding,
  type RequirementPolicy,
  type WaiverRecord,
} from '@openbooks/engine/src/compliance.ts'
import { isFeatureEnabled } from './features'

/**
 * Server-side reads for the Subcontractor Compliance workspace.
 *
 * The DECISION logic lives in engine/src/compliance.ts and is shared with the
 * payment engine — this module only fetches and shapes. That split is what makes
 * the screen that shows a blocked payment and the code that refuses it the same
 * answer, always.
 */

// ---------------------------------------------------------------------------
// Feature gates
// ---------------------------------------------------------------------------

/** Page-boundary gate. Navigation hiding is presentation; this is the control. */
export async function requireComplianceFeature(orgId: string): Promise<void> {
  if (!(await isFeatureEnabled(orgId, 'subcontractorCompliance'))) redirect('/admin/setup/features')
}

/** API-boundary gate — a disabled module is indistinguishable from no API. */
export async function guardComplianceFeature(orgId: string): Promise<NextResponse | null> {
  if (await isFeatureEnabled(orgId, 'subcontractorCompliance')) return null
  return NextResponse.json({ error: 'subcontractor compliance feature is disabled' }, { status: 404 })
}

/**
 * Lien waivers are the one compliance surface that needs a project, so they
 * require BOTH gates. Insurance tracking and 1099 filing deliberately do not.
 */
export async function guardLienWaiverFeature(orgId: string): Promise<NextResponse | null> {
  const gate = await guardComplianceFeature(orgId)
  if (gate) return gate
  if (await isFeatureEnabled(orgId, 'projects')) return null
  return NextResponse.json({ error: 'projects feature is disabled' }, { status: 404 })
}

export async function requireLienWaiverFeature(orgId: string): Promise<void> {
  await requireComplianceFeature(orgId)
  if (!(await isFeatureEnabled(orgId, 'projects'))) redirect('/admin/setup/features')
}

// ---------------------------------------------------------------------------
// The vendor compliance matrix
// ---------------------------------------------------------------------------

export type ComplianceClassRow = {
  id: string
  code: string
  name: string
  lienWaiverEnforcement: LienWaiverEnforcement
  defaultLienWaiverType: LienWaiverType | null
  defaultInformationReturn: string
};

export interface MatrixRow {
  partyId: string
  vendorName: string
  classId: string | null
  className: string | null
  overall: ComplianceState
  blocksPayment: boolean
  blocksBill: boolean
  findings: RequirementFinding[]
  /** Posted, unpaid bill exposure for this vendor, base currency. */
  openBalance: string
  /** Soonest expiry across satisfied requirements. */
  nextExpiry: string | null
}

export interface ComplianceMatrix {
  asOf: string
  policies: RequirementPolicy[]
  classes: ComplianceClassRow[]
  rows: MatrixRow[]
}

export async function loadComplianceClasses(orgId: string): Promise<ComplianceClassRow[]> {
  const r = (await db.execute<ComplianceClassRow>(sql`
    select id, code, name,
           lien_waiver_enforcement as "lienWaiverEnforcement",
           default_lien_waiver_type as "defaultLienWaiverType",
           default_information_return as "defaultInformationReturn"
      from compliance_classes
     where org_id = ${orgId} and is_active
     order by code
  `))
  return r.rows
}

/**
 * Evaluate every classified vendor in three queries, then run the shared pure
 * resolver per vendor. Bulk-loading matters: the alternative is one round trip
 * per vendor per requirement, which turns a 300-subcontractor matrix into
 * thousands of queries.
 */
export async function loadComplianceMatrix(args: {
  orgId: string
  asOf?: string
  classId?: string | null
  /** Only vendors whose worst state is in this set. */
  states?: readonly ComplianceState[]
}): Promise<ComplianceMatrix> {
  const asOf = args.asOf ?? new Date().toISOString().slice(0, 10)
  const [policies, classes, vendors, records, waivers] = await Promise.all([
    loadRequirementPolicies(args.orgId),
    loadComplianceClasses(args.orgId),
    db.execute(sql`
      select p.id as "partyId", p.display_name as "vendorName",
             vr.compliance_class_id as "classId", cc.name as "className",
             coalesce((
               select sum(d.open_balance) from documents d
                where d.org_id = p.org_id and d.party_id = p.id
                  and d.kind in ('vendor_bill', 'expense_report')
                  and d.status = 'posted' and coalesce(d.open_balance, 0) > 0
             ), 0) as "openBalance"
        from parties p
        join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id
        left join compliance_classes cc on cc.id = vr.compliance_class_id and cc.org_id = p.org_id
       where p.org_id = ${args.orgId} and p.is_active and vr.is_active
         and vr.compliance_class_id is not null
         and (${args.classId ?? null}::uuid is null or vr.compliance_class_id = ${args.classId ?? null}::uuid)
       order by p.display_name
    `),
    db.execute(sql`
      select party_id as "partyId", id, requirement_id as "requirementId", project_id as "projectId",
             status, effective_from as "effectiveFrom", expires_on as "expiresOn",
             coverage_amount as "coverageAmount", aggregate_amount as "aggregateAmount",
             coverage_currency as "coverageCurrency",
             additional_insured as "additionalInsured",
             waiver_of_subrogation as "waiverOfSubrogation",
             primary_noncontributory as "primaryNoncontributory",
             verified_at as "verifiedAt"
        from compliance_records
       where org_id = ${args.orgId} and status <> 'superseded'
    `),
    db.execute(sql`
      select party_id as "partyId", id, requirement_id as "requirementId", project_id as "projectId",
             effective_from as "effectiveFrom", expires_on as "expiresOn", revoked_at as "revokedAt"
        from compliance_waivers
       where org_id = ${args.orgId} and revoked_at is null
    `),
  ])

  const vendorRows = (vendors as unknown as {
    rows: { partyId: string; vendorName: string; classId: string | null; className: string | null; openBalance: string }[]
  }).rows
  const recordsByParty = new Map<string, EvidenceRecord[]>()
  for (const row of (records as unknown as { rows: (EvidenceRecord & { partyId: string })[] }).rows) {
    const list = recordsByParty.get(row.partyId) ?? []
    list.push(row)
    recordsByParty.set(row.partyId, list)
  }
  const waiversByParty = new Map<string, WaiverRecord[]>()
  for (const row of (waivers as unknown as { rows: (WaiverRecord & { partyId: string })[] }).rows) {
    const list = waiversByParty.get(row.partyId) ?? []
    list.push(row)
    waiversByParty.set(row.partyId, list)
  }

  const stateFilter = args.states && args.states.length > 0 ? new Set(args.states) : null
  const rows: MatrixRow[] = []
  for (const vendor of vendorRows) {
    const status = evaluateVendorCompliance({
      partyId: vendor.partyId,
      classId: vendor.classId,
      policies,
      records: recordsByParty.get(vendor.partyId) ?? [],
      waivers: waiversByParty.get(vendor.partyId) ?? [],
      asOf,
    })
    if (stateFilter && !stateFilter.has(status.overall)) continue
    const expiries = status.findings
      .map((f) => f.expiresOn)
      .filter((d): d is string => d !== null)
      .sort()
    rows.push({
      partyId: vendor.partyId,
      vendorName: vendor.vendorName,
      classId: vendor.classId,
      className: vendor.className,
      overall: status.overall,
      blocksPayment: status.blocksPayment,
      blocksBill: status.blocksBill,
      findings: status.findings,
      openBalance: vendor.openBalance,
      nextExpiry: expiries[0] ?? null,
    })
  }
  return { asOf, policies, classes, rows }
}

// ---------------------------------------------------------------------------
// Certificates for one vendor (the drawer)
// ---------------------------------------------------------------------------

export type CertificateRow = {
  id: string
  requirementId: string
  requirementCode: string
  requirementName: string
  category: string
  projectId: string | null
  projectName: string | null
  status: string
  issuerName: string | null
  policyNumber: string | null
  effectiveFrom: string
  expiresOn: string | null
  coverageAmount: string | null
  aggregateAmount: string | null
  coverageCurrency: string | null
  additionalInsured: boolean
  waiverOfSubrogation: boolean
  primaryNoncontributory: boolean
  verifiedAt: string | null
  verifiedByName: string | null
  rejectedReason: string | null
  notes: string | null
  createdAt: string
  createdById: string | null
  createdByName: string | null
  fileCount: number
};

export async function loadVendorCertificates(orgId: string, partyId: string): Promise<CertificateRow[]> {
  const r = (await db.execute<CertificateRow>(sql`
    select cr.id, cr.requirement_id as "requirementId", req.code as "requirementCode",
           req.name as "requirementName", req.category, cr.project_id as "projectId",
           case when pj.id is null then null
                else coalesce(pj.code || ' · ' || pj.name, pj.name) end as "projectName",
           cr.status, cr.issuer_name as "issuerName", cr.policy_number as "policyNumber",
           cr.effective_from as "effectiveFrom", cr.expires_on as "expiresOn",
           cr.coverage_amount as "coverageAmount", cr.aggregate_amount as "aggregateAmount",
           cr.coverage_currency as "coverageCurrency",
           cr.additional_insured as "additionalInsured",
           cr.waiver_of_subrogation as "waiverOfSubrogation",
           cr.primary_noncontributory as "primaryNoncontributory",
           cr.verified_at as "verifiedAt", vu.name as "verifiedByName",
           cr.rejected_reason as "rejectedReason", cr.notes, cr.created_at as "createdAt",
           cr.created_by as "createdById", cu.name as "createdByName",
           (select count(*)::int from file_attachments fa
             where fa.org_id = cr.org_id and fa.target_table = 'compliance_records'
               and fa.target_id = cr.id) as "fileCount"
      from compliance_records cr
      join compliance_requirements req on req.id = cr.requirement_id
      left join projects pj on pj.id = cr.project_id and pj.org_id = cr.org_id
      left join users vu on vu.id = cr.verified_by
      left join users cu on cu.id = cr.created_by
     where cr.org_id = ${orgId} and cr.party_id = ${partyId}
     order by req.code, cr.effective_from desc
  `))
  return r.rows
}

export type ExceptionRow = {
  id: string
  requirementCode: string
  requirementName: string
  projectName: string | null
  reason: string
  effectiveFrom: string
  expiresOn: string
  approvedByName: string | null
  approvedAt: string
};

export async function loadVendorWaivers(orgId: string, partyId: string): Promise<ExceptionRow[]> {
  const r = (await db.execute<ExceptionRow>(sql`
    select w.id, req.code as "requirementCode", req.name as "requirementName",
           case when pj.id is null then null
                else coalesce(pj.code || ' · ' || pj.name, pj.name) end as "projectName",
           w.reason, w.effective_from as "effectiveFrom", w.expires_on as "expiresOn",
           u.name as "approvedByName", w.approved_at as "approvedAt"
      from compliance_waivers w
      join compliance_requirements req on req.id = w.requirement_id
      left join projects pj on pj.id = w.project_id and pj.org_id = w.org_id
      left join users u on u.id = w.approved_by
     where w.org_id = ${orgId} and w.party_id = ${partyId} and w.revoked_at is null
     order by w.expires_on desc
  `))
  return r.rows
}

// ---------------------------------------------------------------------------
// Payment exposure
// ---------------------------------------------------------------------------

export interface BlockedBillRow extends BillReleaseDecision {
  documentDate: string
  openBalance: string
  currency: string
  projectName: string | null
}

/**
 * Posted, unpaid subcontractor bills whose release the control would refuse
 * right now. The same function the pay run calls, over the whole AP ledger.
 */
export async function loadBlockedBills(orgId: string, limit = 200): Promise<BlockedBillRow[]> {
  const bills = (await db.execute<{
      id: string
      document_number: string
      party_id: string
      vendor: string
      project_id: string | null
      document_date: string
      currency: string
      open_balance: string
      project_name: string | null
    }>(sql`
    select d.id, d.document_number, d.party_id, p.display_name as vendor,
           d.project_id, d.document_date, d.currency, coalesce(d.open_balance, 0) as open_balance,
           case when pj.id is null then null
                else coalesce(pj.code || ' · ' || pj.name, pj.name) end as project_name
      from documents d
      join parties p on p.id = d.party_id
      join vendor_roles vr on vr.party_id = p.id and vr.org_id = d.org_id
      left join projects pj on pj.id = d.project_id and pj.org_id = d.org_id
     where d.org_id = ${orgId} and d.kind in ('vendor_bill', 'expense_report')
       and d.status = 'posted' and coalesce(d.open_balance, 0) > 0
       and vr.compliance_class_id is not null
     order by d.document_date
     limit ${limit}
  `))
  if (bills.rows.length === 0) return []
  const decisions = await evaluateBillsForRelease({
    orgId,
    bills: bills.rows.map((b) => ({
      documentId: b.id,
      documentNumber: b.document_number,
      partyId: b.party_id,
      vendorName: b.vendor,
      projectId: b.project_id,
      documentDate: b.document_date,
      amount: b.open_balance,
      currency: b.currency,
    })),
  })
  return decisions
    .map((decision, i) => ({
      ...decision,
      documentDate: bills.rows[i]!.document_date,
      openBalance: bills.rows[i]!.open_balance,
      currency: bills.rows[i]!.currency,
      projectName: bills.rows[i]!.project_name,
    }))
    .filter((row) => row.decision !== 'cleared')
    .sort((a, b) => (a.decision === b.decision ? 0 : a.decision === 'blocked' ? -1 : 1))
}

// ---------------------------------------------------------------------------
// Lien waivers
// ---------------------------------------------------------------------------

export type LienWaiverRow = {
  id: string
  waiverNumber: string
  direction: 'received' | 'issued'
  partyId: string
  partyName: string
  projectId: string
  projectName: string
  waiverType: LienWaiverType
  status: string
  throughDate: string
  amount: string
  currency: string
  jurisdiction: string | null
  billDocumentId: string | null
  billNumber: string | null
  payApplicationId: string | null
  signedByName: string | null
  signedByTitle: string | null
  signedAt: string | null
  notarized: boolean
  rejectedReason: string | null
  voidReason: string | null
  notes: string | null
  requestedAt: string | null
  createdAt: string
};

export async function loadLienWaivers(args: {
  orgId: string
  direction?: 'received' | 'issued' | null
  status?: string | null
  projectId?: string | null
  partyId?: string | null
  limit?: number
}): Promise<LienWaiverRow[]> {
  const r = (await db.execute<LienWaiverRow>(sql`
    select lw.id, lw.waiver_number as "waiverNumber", lw.direction,
           lw.party_id as "partyId", p.display_name as "partyName",
           lw.project_id as "projectId",
           coalesce(pj.code || ' · ' || pj.name, pj.name) as "projectName",
           lw.waiver_type as "waiverType", lw.status,
           lw.through_date as "throughDate", lw.amount, lw.currency, lw.jurisdiction,
           lw.bill_document_id as "billDocumentId", bill.document_number as "billNumber",
           lw.pay_application_id as "payApplicationId",
           lw.signed_by_name as "signedByName", lw.signed_by_title as "signedByTitle",
           lw.signed_at as "signedAt", lw.notarized,
           lw.rejected_reason as "rejectedReason", lw.void_reason as "voidReason",
           lw.notes, lw.requested_at as "requestedAt", lw.created_at as "createdAt"
      from lien_waivers lw
      join parties p on p.id = lw.party_id
      join projects pj on pj.id = lw.project_id
      left join documents bill on bill.id = lw.bill_document_id
     where lw.org_id = ${args.orgId}
       and (${args.direction ?? null}::text is null or lw.direction = ${args.direction ?? null})
       and (${args.status ?? null}::text is null or lw.status = ${args.status ?? null})
       and (${args.projectId ?? null}::uuid is null or lw.project_id = ${args.projectId ?? null}::uuid)
       and (${args.partyId ?? null}::uuid is null or lw.party_id = ${args.partyId ?? null}::uuid)
     order by lw.through_date desc, lw.waiver_number desc
     limit ${args.limit ?? 300}
  `))
  return r.rows
}

// ---------------------------------------------------------------------------
// Information returns
// ---------------------------------------------------------------------------

export type FilingListRow = {
  id: string
  taxYear: number
  formType: string
  status: string
  threshold: string
  currency: string
  subsidiaryName: string | null
  computedAt: string | null
  finalizedAt: string | null
  filedAt: string | null
  filingChannel: string | null
  filingReference: string | null
  includedCount: number
  excludedCount: number
  missingTinCount: number
  filedTotal: string
};

export async function loadFilings(orgId: string): Promise<FilingListRow[]> {
  const r = (await db.execute<FilingListRow>(sql`
    select f.id, f.tax_year as "taxYear", f.form_type as "formType", f.status,
           f.threshold, f.currency, s.name as "subsidiaryName",
           f.computed_at as "computedAt", f.finalized_at as "finalizedAt",
           f.filed_at as "filedAt", f.filing_channel as "filingChannel",
           f.filing_reference as "filingReference",
           coalesce(agg.included, 0) as "includedCount",
           coalesce(agg.excluded, 0) as "excludedCount",
           coalesce(agg.missing_tin, 0) as "missingTinCount",
           coalesce(agg.total, 0) as "filedTotal"
      from information_return_filings f
      left join subsidiaries s on s.id = f.subsidiary_id
      left join lateral (
        select count(*) filter (where r.status = 'included')::int as included,
               count(*) filter (where r.status = 'excluded')::int as excluded,
               count(*) filter (where r.status = 'included' and r.tin_last4 is null)::int as missing_tin,
               -- The filed figure is computed + adjustment across every box, less
               -- the withholding boxes, which are tax remitted rather than paid.
               sum((
                 select coalesce(sum((value)::numeric), 0)
                   from jsonb_each_text(r.computed_amounts)
                  where key not in ('nec4', 'misc4', 't4a022')
               ) + (
                 select coalesce(sum((value)::numeric), 0)
                   from jsonb_each_text(r.adjustments)
                  where key not in ('nec4', 'misc4', 't4a022')
               )) filter (where r.status = 'included') as total
          from information_return_recipients r
         where r.filing_id = f.id
      ) agg on true
     where f.org_id = ${orgId}
     order by f.tax_year desc, f.form_type
  `))
  return r.rows
}

export interface RecipientRow {
  id: string
  partyId: string
  vendorName: string
  legalName: string | null
  tinLast4: string | null
  tinType: string | null
  taxClassification: string | null
  computedAmounts: Record<string, string>
  adjustments: Record<string, string>
  adjustmentReason: string | null
  taxWithheld: string
  status: string
  exclusionReason: string | null
  paymentIds: string[]
  address: Record<string, string | null>
  furnishedAt: string | null
}

export interface FilingDetail extends FilingListRow {
  payerSnapshot: Record<string, unknown>
  notes: string | null
  recipients: RecipientRow[]
}

export async function loadFiling(orgId: string, filingId: string): Promise<FilingDetail | null> {
  const filings = await loadFilings(orgId)
  const filing = filings.find((f) => f.id === filingId)
  if (!filing) return null
  const [meta, recipients] = await Promise.all([
    db.execute(sql`
      select payer_snapshot as "payerSnapshot", notes
        from information_return_filings where org_id = ${orgId} and id = ${filingId}`),
    db.execute(sql`
      select r.id, r.party_id as "partyId", p.display_name as "vendorName",
             r.recipient_snapshot->>'legalName' as "legalName",
             r.tin_last4 as "tinLast4", r.tin_type as "tinType",
             r.recipient_snapshot->>'taxClassification' as "taxClassification",
             r.computed_amounts as "computedAmounts", r.adjustments,
             r.adjustment_reason as "adjustmentReason",
             r.tax_withheld as "taxWithheld", r.status,
             r.exclusion_reason as "exclusionReason",
             coalesce(r.recipient_snapshot->'paymentIds', '[]'::jsonb) as "paymentIds",
             coalesce(r.recipient_snapshot->'address', '{}'::jsonb) as address,
             r.furnished_at as "furnishedAt"
        from information_return_recipients r
        join parties p on p.id = r.party_id
       where r.org_id = ${orgId} and r.filing_id = ${filingId}
       order by r.status, p.display_name`),
  ])
  return {
    ...filing,
    payerSnapshot: (meta as unknown as { rows: { payerSnapshot: Record<string, unknown> }[] }).rows[0]?.payerSnapshot ?? {},
    notes: (meta as unknown as { rows: { notes: string | null }[] }).rows[0]?.notes ?? null,
    recipients: (recipients as unknown as { rows: RecipientRow[] }).rows,
  }
}

/**
 * Vendors that look reportable but are not ready to file: the queue that has to
 * be empty before January. Deliberately computed against the CURRENT vendor
 * record, not the filing snapshot, so fixing a W-9 clears the row immediately.
 */
export type ReadinessRow = {
  partyId: string
  vendorName: string
  reportable: boolean
  resolvedForm: string | null
  hasTin: boolean
  taxClassification: string | null
  paidThisYear: string
};

export async function loadInformationReturnReadiness(orgId: string, taxYear: number): Promise<ReadinessRow[]> {
  const r = (await db.execute<ReadinessRow>(sql`
    select p.id as "partyId", p.display_name as "vendorName",
           coalesce(vr.is_t4a, false) as reportable,
           coalesce(vr.information_return_form, cc.default_information_return) as "resolvedForm",
           vr.tin_last4 is not null as "hasTin",
           vr.tax_classification as "taxClassification",
           coalesce(paid.total, 0) as "paidThisYear"
      from parties p
      join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id
      left join compliance_classes cc on cc.id = vr.compliance_class_id and cc.org_id = p.org_id
      join lateral (
        select coalesce(-sum(jl.amount) filter (where jl.amount < 0 and not jl.is_open_item), 0) as total
          from documents d
          join journal_entries je on je.id = d.posted_entry_id and je.status in ('posted', 'reversed')
          join journal_lines jl on jl.entry_id = je.id
         where d.org_id = p.org_id and d.party_id = p.id
           and d.kind = 'vendor_payment' and d.status = 'posted'
           and d.document_date between ${`${taxYear}-01-01`} and ${`${taxYear}-12-31`}
      ) paid on true
     where p.org_id = ${orgId}
       and (
         -- Reportable-but-unready, or unflagged-but-paid-enough-to-question.
         (coalesce(vr.is_t4a, false) and (vr.tin_last4 is null
            or coalesce(vr.information_return_form, cc.default_information_return, 'none') = 'none'))
         or (not coalesce(vr.is_t4a, false) and coalesce(paid.total, 0) >= 600
             and coalesce(vr.tax_classification, '') not in ('c_corp', 's_corp'))
       )
     order by paid.total desc, p.display_name
     limit 200
  `))
  return r.rows
}

// ---------------------------------------------------------------------------
// Cockpit
// ---------------------------------------------------------------------------

export interface ComplianceOverview {
  asOf: string
  taxYear: number
  trackedVendors: number
  byState: Record<ComplianceState, number>
  blockedVendors: number
  expiringSoon: MatrixRow[]
  blockedBills: BlockedBillRow[]
  blockedExposure: string
  outstandingWaivers: LienWaiverRow[]
  readiness: ReadinessRow[]
  filings: FilingListRow[]
  policyCount: number
  configured: boolean
}

const EMPTY_STATES: Record<ComplianceState, number> = {
  compliant: 0,
  expiring: 0,
  waived: 0,
  missing: 0,
  expired: 0,
  insufficient: 0,
  awaiting_verification: 0,
  rejected: 0,
}

/** Everything the /compliance cockpit renders, in one pass. */
export async function loadComplianceOverview(orgId: string, taxYear: number): Promise<ComplianceOverview> {
  const asOf = new Date().toISOString().slice(0, 10)
  const [matrix, blocked, waivers, readiness, filings] = await Promise.all([
    loadComplianceMatrix({ orgId, asOf }),
    loadBlockedBills(orgId),
    loadLienWaivers({ orgId, direction: 'received', limit: 50 }),
    loadInformationReturnReadiness(orgId, taxYear),
    loadFilings(orgId),
  ])
  const byState = { ...EMPTY_STATES }
  for (const row of matrix.rows) byState[row.overall] += 1
  const blockedExposure = blocked
    .filter((b) => b.decision === 'blocked')
    .reduce((total, b) => total + Number(b.openBalance), 0)
  return {
    asOf,
    taxYear,
    trackedVendors: matrix.rows.length,
    byState,
    blockedVendors: matrix.rows.filter((r) => r.blocksPayment || r.blocksBill).length,
    expiringSoon: matrix.rows
      .filter((r) => r.overall === 'expiring')
      .sort((a, b) => (a.nextExpiry ?? '').localeCompare(b.nextExpiry ?? ''))
      .slice(0, 12),
    blockedBills: blocked.slice(0, 12),
    blockedExposure: blockedExposure.toFixed(2),
    outstandingWaivers: waivers.filter((w) => w.status === 'requested' || w.status === 'received').slice(0, 12),
    readiness: readiness.slice(0, 12),
    filings,
    policyCount: matrix.policies.length,
    configured: matrix.policies.length > 0 && matrix.classes.length > 0,
  }
}

// ---------------------------------------------------------------------------
// Shared display helpers
// ---------------------------------------------------------------------------

/** Badge tone for a compliance state — one mapping, used by every surface. */
export function stateTone(state: ComplianceState): 'success' | 'warning' | 'destructive' | 'secondary' {
  switch (state) {
    case 'compliant':
      return 'success'
    case 'expiring':
    case 'awaiting_verification':
      return 'warning'
    case 'waived':
      return 'secondary'
    default:
      return 'destructive'
  }
}
