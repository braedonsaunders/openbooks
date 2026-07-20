import 'server-only'
import { sql } from 'drizzle-orm'
import { db, schema } from '@openbooks/engine/src/db.ts'
import { runRecordFlows } from '@openbooks/engine/src/flows/index.ts'
import { regenerateGlImpactTx, ClosedPeriodError } from '@openbooks/engine/src/posting.ts'
import { captureTransactionAuditSnapshot, recordTransactionAudit } from '@openbooks/engine/src/transaction-audit.ts'
import { promoteCrmAccount } from '@openbooks/engine/src/crm.ts'
import { computeBillTotals, nextDocumentNumber, taxRateMap, type BillLineInput } from './bills'
import { DOC_KINDS, docKindConfig, type DocKindConfig } from './document-kinds'
import { loadFieldDefs, validateCustomValues } from './custom-fields'
import { segmentRegistry, validateExtraDims } from './segments'
import { resolveOrgId } from './org-scope'

/**
 * Unified line-based posting-document machinery.
 *
 * The `documents` table is a single supertype keyed by `kind`; the posting
 * engine (engine/src/posting.ts) holds the per-kind GL rules. The UI for
 * vendor bills, customer invoices, credit memos, card charges, checks, and
 * transfers is structurally identical — a header (party or funding source +
 * dates + memo) and a line grid (account + amount + tax + dimensions). This
 * module is the single source of truth for how each kind is loaded and
 * draft-created, so the drawer, the API, and the list pages never diverge.
 *
 * The kind configuration (client-safe) lives in lib/document-kinds.ts and is
 * re-exported here. The shared math (number sequences, tax computation,
 * tax-rate lookup) lives in lib/bills.ts and is re-exported here; it is fully
 * kind-agnostic.
 */

export { computeBillTotals, taxRateMap, nextDocumentNumber, type BillLineInput } from './bills'
export {
  DOC_KINDS,
  AP_KINDS,
  AR_KINDS,
  BANK_KINDS,
  docKindConfig,
  createPermission,
  postPermission,
  readPermission,
  type DocKindConfig,
  type DocFamily,
  type PermNamespace,
} from './document-kinds'

// ---------------------------------------------------------------------------
// Draft creation + loading
// ---------------------------------------------------------------------------

/** Resolve the org's base currency (used when minting a draft). */
async function orgBaseCurrency(orgId: string): Promise<string> {
  const r = (await db.execute(
    sql`select base_currency from orgs where id = ${orgId}`,
  )) as unknown as { rows: { base_currency: string }[] }
  return r.rows[0]?.base_currency ?? 'CAD'
}

/** Org-level control accounts from orgs.settings.controlAccounts. */
export async function controlDeps(orgId: string) {
  const r = (await db.execute(sql`select settings->'controlAccounts' as c from orgs where id = ${orgId}`)) as any
  const c = r.rows[0]?.c ?? {}
  return {
    control: {
      ar: c.ar,
      ap: c.ap,
      bank: c.bank,
      taxCollected: c.taxCollected,
      taxPaid: c.taxPaid,
      employeePayable: c.employeePayable,
    },
  }
}

/** Instant-into-draft: mint an empty draft document for a kind, return id + number. */
export async function createDocumentDraft(orgId: string, userId: string, kind: string) {
  const cfg = docKindConfig(kind)
  if (!cfg) throw new Error(`unknown document kind "${kind}"`)
  const currency = await orgBaseCurrency(orgId)
  const root = (await db.execute(sql`
    select id from subsidiaries where org_id = ${orgId} and parent_id is null`)) as unknown as {
    rows: { id: string }[]
  }
  const subsidiaryId = root.rows[0]?.id ?? null
  const documentNumber = await nextDocumentNumber(orgId, kind, cfg.numberPrefix, subsidiaryId)
  const [doc] = await db
    .insert(schema.documents)
    .values({
      orgId,
      kind,
      subsidiaryId,
      documentNumber,
      documentDate: new Date().toISOString().slice(0, 10),
      currency,
      subtotal: '0',
      taxTotal: '0',
      total: '0',
      createdBy: userId,
    })
    .returning({ id: schema.documents.id, documentNumber: schema.documents.documentNumber })
  // on_create flows fire AFTER the insert commits. runRecordFlows never
  // throws into the caller (failures land on the flow_runs row), and it is
  // awaited — not detached — so it runs inside this request's RLS org scope.
  await runRecordFlows({ kind: 'on_create', source: 'ui' }, kind, doc.id, { orgId, userId })
  return doc
}

/**
 * Full document payload for a drawer: header + lines. For open-item kinds
 * (invoices, credits) the applied amount is summed from un-reversed
 * applications against the posted entry's control open-item line, and
 * `balance_due` = total − applied.
 */
export async function loadDocument(id: string, orgId?: string) {
  const resolvedOrgId = await resolveOrgId(orgId)
  const doc = (await db.execute(sql`
    select d.*, p.display_name as party_name, e.id as entry_id,
           ${sql`case when d.status = 'posted' then ap.applied end`} as applied,
           ${sql`case when d.status = 'posted' then d.total - ap.applied end`} as balance_due
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      left join journal_entries e on e.id = d.posted_entry_id and e.org_id = d.org_id
      left join lateral (
        select coalesce(sum(a.amount), 0) as applied
          from journal_lines jl
          join applications a on a.org_id = jl.org_id and a.to_line_id = jl.id and a.unapplied_at is null
         where jl.org_id = d.org_id and jl.entry_id = d.posted_entry_id and jl.is_open_item
      ) ap on true
     where d.id = ${id} and d.org_id = ${resolvedOrgId}
  `)) as unknown as { rows: Record<string, unknown>[] }
  if (!doc.rows[0]) return null
  const lines = (await db.execute(sql`
    select l.id, l.line_number, l.account_id, l.item_id, l.description, l.quantity, l.unit,
           l.unit_price, l.amount, l.tax_code_id, l.tax_amount,
           l.tax_overridden, l.department_id, l.project_id, l.location_id, l.class_id,
           l.extra_dims, l.custom
      from document_lines l
     where l.document_id = ${id} and l.org_id = ${resolvedOrgId}
     order by l.line_number
  `)) as unknown as { rows: Record<string, unknown>[] }
  return { doc: doc.rows[0], lines: lines.rows }
}

// ---------------------------------------------------------------------------
// Shared edit service — the single source of truth for writing a posting
// document's header + lines. Both the interactive drawer route
// (app/api/documents/[id]/route.ts) and the public REST writer
// (lib/api/writers.ts) call this, so an API edit gets the exact same custom-
// field validation, GL re-materialization, transaction audit, CRM promotion,
// and on_update flows the UI does — no duplicated, drifting write logic.
// ---------------------------------------------------------------------------

/** A line as accepted on a document edit (built-ins + dimensions + custom). */
export interface DocumentLineInput extends BillLineInput {
  itemId?: string | null
  quantity?: string | null
  unit?: string | null
  unitPrice?: string | null
  /** Line entity: the customer/vendor/employee this line belongs to. */
  partyId?: string | null
  departmentId?: string | null
  projectId?: string | null
  locationId?: string | null
  classId?: string | null
  extraDims?: Record<string, string | null>
  custom?: Record<string, unknown>
}

/** The header + lines payload for a document edit. Every field is optional; an
 *  absent key leaves the stored value untouched (partial patch). */
export interface DocumentEditInput {
  partyId?: string | null
  paymentCardId?: string | null
  documentDate?: string
  dueDate?: string | null
  referenceNumber?: string | null
  memo?: string | null
  postingDate?: string | null
  departmentId?: string | null
  projectId?: string | null
  locationId?: string | null
  classId?: string | null
  extraDims?: Record<string, string | null>
  subsidiaryId?: string | null
  expectedPayDate?: string | null
  paymentHoldReason?: string | null
  internalNotes?: string | null
  billingMethod?: string | null
  isFinalInvoice?: boolean
  custom?: Record<string, unknown>
  lines?: DocumentLineInput[]
}

/** The pre-edit snapshot a caller loads under its own org scope. */
export interface DocumentEditCurrent {
  kind: string
  status: string
  total: string
  taxTotal: string
  partyId: string | null
}

export interface DocumentEditContext {
  orgId: string
  userId: string
  /** Provenance recorded on the transaction audit + flow events. */
  source: 'ui' | 'api'
  /** Fire on_update record flows after the edit commits (default true). */
  runFlows?: boolean
}

/** A validation/period failure with the HTTP status the callers should return. */
export class DocumentEditError extends Error {
  status: number
  fieldErrors?: Record<string, string>
  constructor(status: number, message: string, fieldErrors?: Record<string, string>) {
    super(message)
    this.name = 'DocumentEditError'
    this.status = status
    this.fieldErrors = fieldErrors
  }
}

/**
 * A document-layer signature of everything that shapes a posting document's GL
 * impact. Comparing before vs after a save tells us whether the edit was
 * GL-affecting WITHOUT assuming the stored entry was produced by our own
 * posting rules (migrated docs carry the source system's GL). Non-GL edits
 * (memo, reference #) leave this unchanged and never touch the ledger.
 */
async function glSignature(
  tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
  id: string,
  orgId: string,
): Promise<string> {
  const r = (await tx.execute(sql`
    select md5(
      coalesce(d.party_id::text,'') || '~' || coalesce(d.payment_card_id::text,'') || '~' ||
      coalesce(d.document_date::text,'') || '~' || coalesce(d.posting_date::text,'') || '~' ||
      coalesce(d.currency,'') || '~' || coalesce(d.fx_rate::text,'') || '~' ||
      coalesce(d.subsidiary_id::text,'') || '~' ||
      coalesce(d.extra_dims::text,'{}') || '~' ||
      coalesce((select string_agg(
        coalesce(account_id::text,'') || ':' || coalesce(item_id::text,'') || ':' || amount::text || ':' ||
        coalesce(tax_code_id::text,'') || ':' || tax_amount::text || ':' ||
        coalesce(party_id::text,'') || ':' ||
        coalesce(department_id::text,'') || ':' || coalesce(project_id::text,'') || ':' ||
        coalesce(location_id::text,'') || ':' || coalesce(class_id::text,'') || ':' ||
        coalesce(subsidiary_id::text,'') || ':' || coalesce(extra_dims::text,'{}'),
        '|' order by line_number)
        from document_lines where org_id = d.org_id and document_id = d.id), '')
    ) as sig
    from documents d where d.id = ${id} and d.org_id = ${orgId}`)) as { rows: { sig: string }[] }
  return r.rows[0]?.sig ?? ''
}

/**
 * Apply a header + lines edit to a posting document. Draft/approved docs edit
 * freely (no GL yet). A POSTED doc is editable in place, NetSuite-style: its
 * journal entry is a derived projection re-materialized on save
 * (regenerateGlImpactTx) — a non-GL change is a ledger no-op; a GL change
 * regenerates the entry's lines and is blocked only if the period is closed.
 * Throws DocumentEditError (422) on validation / closed-period failures.
 *
 * Callers own auth + status/lock guards; this owns validation, the write, GL,
 * audit, and flows.
 */
export async function applyDocumentEdit(
  id: string,
  current: DocumentEditCurrent,
  body: DocumentEditInput,
  ctx: DocumentEditContext,
): Promise<void> {
  const cfg = docKindConfig(current.kind)
  if (!cfg) throw new DocumentEditError(422, `kind "${current.kind}" is not editable`)
  const { orgId, userId } = ctx

  // Kinds with a party role (vendor/customer) must keep a party — an explicit
  // null would strand the document without the entity its posting depends on.
  if (cfg.partyRole && body.partyId === null) {
    throw new DocumentEditError(422, `a ${current.kind} requires a ${cfg.partyRole}; the party cannot be removed`)
  }
  if (body.subsidiaryId !== undefined && body.subsidiaryId !== null) {
    const subsidiary = (await db.execute(sql`
      select 1 from subsidiaries
       where id = ${body.subsidiaryId} and org_id = ${orgId}
         and is_active and not is_elimination`)) as any
    if (!subsidiary.rows.length) throw new DocumentEditError(422, 'invalid subsidiary')
  }

  // custom-field validation (header + line) against the live definitions
  const [headerDefs, lineDefs, segments] = await Promise.all([
    loadFieldDefs('documents', current.kind),
    loadFieldDefs('document_lines', current.kind),
    segmentRegistry(orgId),
  ])
  const headerDims = body.extraDims === undefined ? null : validateExtraDims(body.extraDims, segments)
  if (headerDims && !headerDims.ok) throw new DocumentEditError(422, headerDims.error!)
  let headerCustom: Record<string, unknown> | null = null
  if (body.custom !== undefined) {
    const v = validateCustomValues(headerDefs, body.custom)
    if (!v.ok) throw new DocumentEditError(422, Object.values(v.errors)[0]!, v.errors)
    headerCustom = v.cleaned
  }

  // Pre-validate + prepare lines before touching the DB, so a bad line fails
  // without a partial write.
  let totals: { subtotal: string; taxTotal: string; total: string } | null = null
  let preparedLines:
    | { accountId: string; itemId: string | null; description: string | null; quantity: string | null; unit: string | null; unitPrice: string | null; amount: string; taxCodeId: string | null; taxAmount: string; taxOverridden: boolean; partyId: string | null; departmentId: string | null; projectId: string | null; locationId: string | null; classId: string | null; extraDims: Record<string, string>; custom: Record<string, unknown> }[]
    | null = null
  if (body.lines) {
    const valid = body.lines.filter((l) => l.accountId && Number(l.amount) > 0)
    const computed = computeBillTotals(valid, await taxRateMap(orgId))
    totals = computed
    // A transfer moves one amount between two accounts; its two legs carry the
    // same amount, so the document total is that amount — NOT the summed legs.
    if (current.kind === 'transfer' && computed.lines.length > 0) {
      const amt = computed.lines[0]!.amount
      totals = { subtotal: amt, taxTotal: '0', total: amt }
    }
    preparedLines = []
    for (let i = 0; i < computed.lines.length; i++) {
      const l = computed.lines[i]! as (typeof computed.lines)[number] & DocumentLineInput
      const lv = validateCustomValues(lineDefs, l.custom)
      if (!lv.ok) throw new DocumentEditError(422, `Line ${i + 1}: ${Object.values(lv.errors)[0]}`, lv.errors)
      const lineDims = validateExtraDims(l.extraDims ?? {}, segments)
      if (!lineDims.ok) throw new DocumentEditError(422, `Line ${i + 1}: ${lineDims.error}`)
      preparedLines.push({
        accountId: l.accountId!,
        itemId: l.itemId ?? null,
        description: l.description ?? null,
        quantity: l.quantity ?? null,
        unit: l.unit ?? null,
        unitPrice: l.unitPrice ?? null,
        amount: l.amount,
        taxCodeId: l.taxCodeId ?? null,
        taxAmount: l.taxAmount,
        taxOverridden: l.taxOverridden === true,
        partyId: l.partyId ?? null,
        departmentId: l.departmentId ?? null,
        projectId: l.projectId ?? null,
        locationId: l.locationId ?? null,
        classId: l.classId ?? null,
        extraDims: lineDims.cleaned,
        custom: lv.cleaned,
      })
    }
  }

  // Pre-edit line snapshot for line-level change detection (the on_update
  // "re-approval on material edit" pattern).
  const oldLines = ((await db.execute(sql`
    select line_number as "lineNumber", account_id as "accountId", department_id as "departmentId",
           project_id as "projectId", amount
      from document_lines where document_id = ${id} order by line_number
  `)) as unknown as { rows: { lineNumber: number; accountId: string | null; departmentId: string | null; projectId: string | null; amount: string }[] }).rows

  const deps = await controlDeps(orgId)

  // All writes + the GL-Impact re-materialization happen in one transaction, so
  // a GL edit into a closed period rolls the whole edit back (nothing partial).
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('openbooks.amend', 'on', true)`)
      const auditCandidate = await captureTransactionAuditSnapshot(tx, id)
      const auditBefore = auditCandidate?.document.status === 'posted' ? auditCandidate : null
      const sigBefore = await glSignature(tx, id, orgId)

      if (preparedLines) {
        await tx.execute(sql`delete from document_lines where document_id = ${id} and org_id = ${orgId}`)
        for (let i = 0; i < preparedLines.length; i++) {
          const l = preparedLines[i]!
          await tx.execute(sql`
            insert into document_lines (org_id, document_id, line_number, account_id, item_id, description,
                                        quantity, unit, unit_price, amount, tax_code_id, tax_amount, tax_overridden,
                                        party_id, department_id, project_id, location_id, class_id, extra_dims, custom)
            values (${orgId}, ${id}, ${i + 1}, ${l.accountId}, ${l.itemId}, ${l.description},
                    ${l.quantity ?? '1'}, ${l.unit}, ${l.unitPrice ?? l.amount}, ${l.amount},
                    ${l.taxCodeId}, ${l.taxAmount}, ${l.taxOverridden},
                    ${l.partyId}, ${l.departmentId}, ${l.projectId}, ${l.locationId}, ${l.classId},
                    ${JSON.stringify(l.extraDims)}::jsonb, ${JSON.stringify(l.custom)})
          `)
        }
      }

      await tx.execute(sql`
        update documents set
          party_id = ${body.partyId !== undefined ? body.partyId : sql`party_id`},
          payment_card_id = ${body.paymentCardId !== undefined ? body.paymentCardId : sql`payment_card_id`},
          document_date = coalesce(${body.documentDate ?? null}, document_date),
          due_date = ${body.dueDate !== undefined ? body.dueDate : sql`due_date`},
          reference_number = ${body.referenceNumber !== undefined ? body.referenceNumber : sql`reference_number`},
          memo = ${body.memo !== undefined ? body.memo : sql`memo`},
          posting_date = ${body.postingDate !== undefined ? body.postingDate : sql`posting_date`},
          department_id = ${body.departmentId !== undefined ? body.departmentId : sql`department_id`},
          project_id = ${body.projectId !== undefined ? body.projectId : sql`project_id`},
          location_id = ${body.locationId !== undefined ? body.locationId : sql`location_id`},
          class_id = ${body.classId !== undefined ? body.classId : sql`class_id`},
          extra_dims = ${headerDims ? JSON.stringify(headerDims.cleaned) : sql`extra_dims`}::jsonb,
          subsidiary_id = ${body.subsidiaryId !== undefined ? body.subsidiaryId : sql`subsidiary_id`},
          expected_pay_date = ${body.expectedPayDate !== undefined ? body.expectedPayDate : sql`expected_pay_date`},
          payment_hold_reason = ${body.paymentHoldReason !== undefined ? body.paymentHoldReason : sql`payment_hold_reason`},
          internal_notes = ${body.internalNotes !== undefined ? body.internalNotes : sql`internal_notes`},
          billing_method = ${body.billingMethod !== undefined ? body.billingMethod : sql`billing_method`},
          is_final_invoice = ${body.isFinalInvoice !== undefined ? body.isFinalInvoice : sql`is_final_invoice`},
          custom = coalesce(${headerCustom ? JSON.stringify(headerCustom) : null}::jsonb, custom),
          subtotal = coalesce(${totals?.subtotal ?? null}, subtotal),
          tax_total = coalesce(${totals?.taxTotal ?? null}, tax_total),
          total = coalesce(${totals?.total ?? null}, total),
          updated_at = now(), updated_by = ${userId}
        where id = ${id} and org_id = ${orgId}
      `)

      const effectivePartyId = body.partyId !== undefined ? body.partyId : current.partyId
      if (effectivePartyId && ['customer_invoice', 'customer_credit', 'customer_payment'].includes(current.kind)) {
        await promoteCrmAccount(tx, {
          orgId,
          partyId: effectivePartyId,
          actorId: userId,
          toStage: 'customer',
          sourceKind: current.kind,
          sourceId: id,
        })
      }

      if ((await glSignature(tx, id, orgId)) !== sigBefore) {
        await regenerateGlImpactTx(tx, id, deps, userId)
      }
      if (auditBefore) {
        const auditAfter = await captureTransactionAuditSnapshot(tx, id)
        if (!auditAfter) throw new Error(`document ${id} disappeared during amendment`)
        await recordTransactionAudit(tx, {
          orgId,
          documentId: id,
          action: 'update',
          actorId: userId,
          source: ctx.source,
          before: auditBefore,
          after: auditAfter,
        })
      }
    })
  } catch (e) {
    if (e instanceof ClosedPeriodError) throw new DocumentEditError(422, e.message)
    throw e
  }

  // on_update flows fire AFTER the edit commits (unless the caller opts out).
  // The edit-shape data rides on the EVENT (previousTotal / totalChanged /
  // changedFields / changedLineFields). runRecordFlows never throws into the
  // caller and cannot veto the saved edit; it is awaited so it runs inside the
  // caller's RLS org scope.
  if (ctx.runFlows === false) return
  const newTotal = totals?.total ?? current.total
  const newTaxTotal = totals?.taxTotal ?? current.taxTotal
  const changedFields: string[] = []
  if (Number(newTotal) !== Number(current.total)) changedFields.push('total')
  if (Number(newTaxTotal) !== Number(current.taxTotal)) changedFields.push('taxTotal')
  if (body.partyId !== undefined && body.partyId !== current.partyId) changedFields.push('partyId')
  const changedLineFields = new Set<string>()
  if (preparedLines) {
    const maxLen = Math.max(oldLines.length, preparedLines.length)
    for (let i = 0; i < maxLen; i++) {
      const o = oldLines[i]
      const n = preparedLines[i]
      if (!o || !n) {
        changedLineFields.add('accountId').add('departmentId').add('projectId').add('amount')
        break
      }
      if (o.accountId !== n.accountId) changedLineFields.add('accountId')
      if ((o.departmentId ?? null) !== (n.departmentId ?? null)) changedLineFields.add('departmentId')
      if ((o.projectId ?? null) !== (n.projectId ?? null)) changedLineFields.add('projectId')
      if (Number(o.amount) !== Number(n.amount)) changedLineFields.add('amount')
    }
  }
  await runRecordFlows(
    {
      kind: 'on_update',
      source: ctx.source,
      previousTotal: current.total,
      totalChanged: Number(newTotal) !== Number(current.total),
      changedFields,
      changedLineFields: [...changedLineFields],
      old: { total: current.total, taxTotal: current.taxTotal },
    },
    current.kind,
    id,
    { orgId, userId },
  )
}

// ---------------------------------------------------------------------------
// Picker option loaders (shared by every list page's drawer hydration)
// ---------------------------------------------------------------------------

export interface Opt {
  id: string
  display_name?: string
  number?: string
  name?: string
  code?: string
  rate?: string
  label?: string
  last_four?: string
  network?: string
  liability_account_id?: string
  /** Party pickers carry the party's primary subsidiary (drafts default to it). */
  subsidiary_id?: string | null
}

export async function partyOptions(role: 'vendor' | 'customer', orgId?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId)
  const filter =
    role === 'vendor'
      ? sql`custom->>'nsKind' = 'vendor'`
      : sql`(custom->>'nsKind' = 'customer'
             or exists (select 1 from customer_roles cr where cr.org_id = ${resolvedOrgId} and cr.party_id = parties.id))`
  const r = (await db.execute(sql`
    select id, display_name, subsidiary_id from parties
     where org_id = ${resolvedOrgId} and ${filter} and is_active
     order by display_name limit 2000
  `)) as unknown as { rows: Opt[] }
  return r.rows
}

export async function accountOptions(cfg: DocKindConfig, orgId?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId)
  const typeFilter = cfg.accountTypes
    ? sql` and a.type in (${sql.join(cfg.accountTypes.map((ty) => sql`${ty}`), sql`, `)})`
    : sql``
  const r = (await db.execute(sql`
    select id, number, name from accounts a
     where a.org_id = ${resolvedOrgId} and a.is_active and not a.is_summary ${typeFilter}
     order by a.number nulls last
  `)) as unknown as { rows: Opt[] }
  return r.rows
}

export async function taxCodeOptions(orgId?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId)
  const r = (await db.execute(sql`
    select tc.id, tc.code, tc.name, coalesce(tr.rate_percent, 0) as rate
      from tax_codes tc
      left join lateral (
        select rate_percent from tax_rates
         where org_id = ${resolvedOrgId} and tax_code_id = tc.id and effective_from <= now()
         order by effective_from desc limit 1) tr on true
     where tc.org_id = ${resolvedOrgId} and tc.is_active order by tc.code
  `)) as unknown as { rows: Opt[] }
  return r.rows
}

export async function dimensionOptions(orgId?: string) {
  const resolvedOrgId = await resolveOrgId(orgId)
  const [departments, projects, locations, classes, registry] = await Promise.all([
    db.execute(sql`select id, name from departments where org_id = ${resolvedOrgId} and is_active order by name`) as any,
    db.execute(sql`select id, name from projects where org_id = ${resolvedOrgId} and is_active order by name limit 2000`) as any,
    db.execute(sql`select id, name from locations where org_id = ${resolvedOrgId} and is_active order by name`) as any,
    db.execute(sql`select id, name from classes where org_id = ${resolvedOrgId} and is_active order by name`) as any,
    segmentRegistry(resolvedOrgId),
  ])
  return {
    departments: departments.rows as Opt[],
    projects: projects.rows as Opt[],
    locations: locations.rows as Opt[],
    classes: classes.rows as Opt[],
    segments: registry.filter((segment) => segment.sourceKind === 'custom'),
    builtinSegments: registry.filter((segment) => segment.sourceKind === 'builtin'),
  }
}

/** Active catalog items (for the optional line `item` column). */
export async function itemOptions(orgId?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId)
  const r = (await db.execute(sql`
    select id, code, name from items where org_id = ${resolvedOrgId} and is_active order by coalesce(code, name), name limit 2000
  `)) as unknown as { rows: Opt[] }
  return r.rows
}

/** Active corporate cards (for card_charge / card_refund funding source). */
export async function cardOptions(orgId?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId)
  const r = (await db.execute(sql`
    select pc.id, pc.label, pc.last_four, pc.network, pc.liability_account_id, p.display_name as holder
      from payment_cards pc
      left join parties p on p.id = pc.holder_party_id and p.org_id = pc.org_id
     where pc.org_id = ${resolvedOrgId} and pc.is_active
     order by pc.label
  `)) as unknown as { rows: any[] }
  return r.rows.map((c) => ({
    id: c.id,
    label: c.last_four ? `${c.label}` : c.label,
    display_name: c.last_four ? `${c.network ?? ''} •••• ${c.last_four} — ${c.holder ?? ''}`.trim() : c.label,
    last_four: c.last_four,
    network: c.network,
    liability_account_id: c.liability_account_id,
  }))
}

/** Reconcilable bank accounts (for check funding source + transfer legs). */
export async function bankAccountOptions(orgId?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId)
  const r = (await db.execute(sql`
    select id, number, name from accounts
     where org_id = ${resolvedOrgId} and is_active and not is_summary and reconcilable and type = 'asset_bank'
     order by number nulls last
  `)) as unknown as { rows: Opt[] }
  return r.rows
}
