import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { regenerateGlImpactTx, ClosedPeriodError } from '@openbooks/engine/src/posting.ts'
import { deleteDocument, DeleteError } from '@openbooks/engine/src/document-delete.ts'
import { captureTransactionAuditSnapshot, recordTransactionAudit } from '@openbooks/engine/src/transaction-audit.ts'
import { runRecordFlows, checkFlowLock, userRoleKeys } from '@openbooks/engine/src/flows/index.ts'
import { getAuthz, guardPermission, can } from '../../../../lib/authz'
import {
  controlDeps,
  loadDocument,
  DOC_KINDS,
  createPermission,
  readPermission,
  computeBillTotals,
  taxRateMap,
  type BillLineInput,
} from '../../../../lib/documents'
import { loadFieldDefs, validateCustomValues } from '../../../../lib/custom-fields'
import { isUuid } from '../../../../lib/list-params'
import { segmentRegistry, validateExtraDims } from '../../../../lib/segments'
import { promoteCrmAccount } from '@openbooks/engine/src/crm.ts'

export const runtime = 'nodejs'

/**
 * A document-layer signature of everything that shapes a posting document's GL
 * impact. Comparing before vs after a save tells us whether the edit was
 * GL-affecting — WITHOUT assuming the stored entry was produced by our own
 * posting rules (migrated docs carry the source system's GL). Non-GL edits
 * (memo, reference #) leave this unchanged and never touch the ledger.
 */
async function glSignature(tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }, id: string): Promise<string> {
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
        coalesce(department_id::text,'') || ':' || coalesce(project_id::text,'') || ':' ||
        coalesce(location_id::text,'') || ':' || coalesce(class_id::text,'') || ':' ||
        coalesce(subsidiary_id::text,'') || ':' || coalesce(extra_dims::text,'{}'),
        '|' order by line_number)
        from document_lines where document_id = d.id), '')
    ) as sig
    from documents d where d.id = ${id}`)) as { rows: { sig: string }[] }
  return r.rows[0]?.sig ?? ''
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params

  // Org-scoped existence + kind lookup BEFORE anything is disclosed.
  const owned = (await db.execute(
    sql`select kind from documents where id = ${id} and org_id = ${authz.user.orgId}`,
  )) as unknown as { rows: { kind: string }[] }
  const row = owned.rows[0]
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!DOC_KINDS[row.kind]) {
    return NextResponse.json({ error: `kind "${row.kind}" is not served here` }, { status: 422 })
  }
  // Per-kind read permission (ap.read for bills/banking, ar.read for
  // invoices/credits, gl.read for transfers) — mirrors the old per-module routes.
  if (!can(authz, readPermission(row.kind))) {
    return NextResponse.json({ error: `missing permission: ${readPermission(row.kind)}` }, { status: 403 })
  }

  const doc = await loadDocument(id)
  if (!doc) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(doc)
}

/**
 * Save a posting document. Draft/approved docs edit freely (no GL yet). A
 * POSTED doc is editable in place, NetSuite-style: its journal entry is a
 * derived projection re-materialized on save (regenerateGlImpactTx) — a
 * non-GL change (memo, reference #) is a no-op on the ledger; a GL change
 * regenerates the entry's lines and is blocked only if the posting period is
 * closed.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Auth first: nothing about the document (existence, kind, status) is
  // disclosed to unauthenticated or cross-org callers.
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const user = authz.user
  const { id } = await params

  const owned = (await db.execute(
    sql`select kind, status, total, tax_total as "taxTotal", party_id as "partyId" from documents where id = ${id} and org_id = ${user.orgId}`,
  )) as unknown as { rows: { kind: string; status: string; total: string; taxTotal: string; partyId: string | null }[] }
  const row = owned.rows[0]
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const cfg = DOC_KINDS[row.kind]
  if (!cfg) return NextResponse.json({ error: `kind "${row.kind}" is not editable here` }, { status: 422 })
  if (!can(authz, createPermission(row.kind))) {
    return NextResponse.json({ error: `missing permission: ${createPermission(row.kind)}` }, { status: 403 })
  }
  if (row.status === 'voided') {
    return NextResponse.json({ error: 'a voided document cannot be edited' }, { status: 422 })
  }
  // Pending-approval lock (NetSuite parity): while approvers are deciding, the
  // record they were shown must not shift underneath them. Editing resumes
  // after the decision (approve → approved, reject → draft); flow admins may
  // override.
  if (row.status === 'pending_approval' && !can(authz, 'flows.manage')) {
    return NextResponse.json(
      { error: 'this document is locked while its approval is pending — wait for the decision or ask a flow administrator' },
      { status: 409 },
    )
  }
  // Flow-managed lock (the lock_record action — NetSuite "Lock Record" with
  // role exemptions, e.g. approved payments stay permanently locked except
  // for admins/controllers). Independent of document status.
  {
    const roles = await userRoleKeys(user.orgId, user.id)
    const lock = await checkFlowLock(row.kind, id, {
      isAdmin: user.isSuperAdmin || roles.has('admin'),
      roles: [...roles],
    })
    if (lock) {
      return NextResponse.json(
        { error: `this document is locked by a workflow${lock.reason ? ` — ${lock.reason}` : ''}` },
        { status: 409 },
      )
    }
  }
  // Pre-edit line snapshot for line-level change detection (NetSuite's
  // "expense-line account/department changed → needs re-review" pattern).
  const oldLines = ((await db.execute(sql`
    select line_number as "lineNumber", account_id as "accountId", department_id as "departmentId",
           project_id as "projectId", amount
      from document_lines where document_id = ${id} order by line_number
  `)) as unknown as { rows: { lineNumber: number; accountId: string | null; departmentId: string | null; projectId: string | null; amount: string }[] }).rows

  const deps = await controlDeps(user.orgId)

  const body = (await req.json()) as {
    partyId?: string | null
    paymentCardId?: string | null
    documentDate?: string
    dueDate?: string | null
    referenceNumber?: string | null
    memo?: string | null
    // Full-schema header built-ins (optional; only sent when a form exposes them).
    postingDate?: string | null
    departmentId?: string | null
    projectId?: string | null
    locationId?: string | null
    classId?: string | null
    extraDims?: Record<string, string | null>
    /** null = org root (posting resolves it). Only sent by multi-subsidiary orgs. */
    subsidiaryId?: string | null
    expectedPayDate?: string | null
    paymentHoldReason?: string | null
    internalNotes?: string | null
    billingMethod?: string | null
    isFinalInvoice?: boolean
    custom?: Record<string, unknown>
    lines?: (BillLineInput & {
      itemId?: string | null
      quantity?: string | null
      unit?: string | null
      unitPrice?: string | null
      departmentId?: string | null
      projectId?: string | null
      locationId?: string | null
      classId?: string | null
      extraDims?: Record<string, string | null>
      custom?: Record<string, unknown>
    })[]
  }

  // Kinds with a party role (vendor/customer) must keep a party — an explicit
  // null would strand the document without the entity its posting depends on.
  if (cfg.partyRole && body.partyId === null) {
    return NextResponse.json(
      { error: `a ${row.kind} requires a ${cfg.partyRole}; the party cannot be removed` },
      { status: 422 },
    )
  }
  if (body.subsidiaryId !== undefined && body.subsidiaryId !== null) {
    if (!isUuid(body.subsidiaryId)) {
      return NextResponse.json({ error: 'invalid subsidiary' }, { status: 422 })
    }
    const subsidiary = (await db.execute(sql`
      select 1 from subsidiaries
       where id = ${body.subsidiaryId} and org_id = ${user.orgId}
         and is_active and not is_elimination`)) as any
    if (!subsidiary.rows.length) {
      return NextResponse.json({ error: 'invalid subsidiary' }, { status: 422 })
    }
  }

  // custom-field validation (header + line) against the live definitions
  const [headerDefs, lineDefs, segments] = await Promise.all([
    loadFieldDefs('documents', row.kind),
    loadFieldDefs('document_lines', row.kind),
    segmentRegistry(user.orgId),
  ])
  const headerDims = body.extraDims === undefined ? null : validateExtraDims(body.extraDims, segments)
  if (headerDims && !headerDims.ok) return NextResponse.json({ error: headerDims.error }, { status: 422 })
  let headerCustom: Record<string, unknown> | null = null
  if (body.custom !== undefined) {
    const v = validateCustomValues(headerDefs, body.custom)
    if (!v.ok) return NextResponse.json({ error: Object.values(v.errors)[0], fieldErrors: v.errors }, { status: 422 })
    headerCustom = v.cleaned
  }

  // Pre-validate + prepare lines before touching the DB, so a bad line
  // returns 422 without a partial write.
  let totals: { subtotal: string; taxTotal: string; total: string } | null = null
  let preparedLines: { accountId: string; itemId: string | null; description: string | null; quantity: string | null; unit: string | null; unitPrice: string | null; amount: string; taxCodeId: string | null; taxAmount: string; taxOverridden: boolean; departmentId: string | null; projectId: string | null; locationId: string | null; classId: string | null; extraDims: Record<string, string>; custom: Record<string, unknown> }[] | null = null
  if (body.lines) {
    const valid = body.lines.filter((l) => l.accountId && Number(l.amount) > 0)
    const computed = computeBillTotals(valid, await taxRateMap())
    totals = computed
    // A transfer moves one amount between two accounts; its two legs carry the
    // same amount, so the document total is that amount — NOT the summed legs
    // (which would double it). computeBillTotals sums, so override here.
    if (row.kind === 'transfer' && computed.lines.length > 0) {
      const amt = computed.lines[0]!.amount
      totals = { subtotal: amt, taxTotal: '0', total: amt }
    }
    preparedLines = []
    for (let i = 0; i < computed.lines.length; i++) {
      const l = computed.lines[i]! as (typeof computed.lines)[number] & {
        itemId?: string | null
        quantity?: string | null
        unit?: string | null
        unitPrice?: string | null
        departmentId?: string | null
        projectId?: string | null
        locationId?: string | null
        classId?: string | null
        extraDims?: Record<string, string | null>
        custom?: Record<string, unknown>
      }
      const lv = validateCustomValues(lineDefs, l.custom)
      if (!lv.ok) {
        return NextResponse.json(
          { error: `Line ${i + 1}: ${Object.values(lv.errors)[0]}`, fieldErrors: lv.errors },
          { status: 422 },
        )
      }
      const lineDims = validateExtraDims(l.extraDims, segments)
      if (!lineDims.ok) {
        return NextResponse.json({ error: `Line ${i + 1}: ${lineDims.error}` }, { status: 422 })
      }
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
        departmentId: l.departmentId ?? null,
        projectId: l.projectId ?? null,
        locationId: l.locationId ?? null,
        classId: l.classId ?? null,
        extraDims: lineDims.cleaned,
        custom: lv.cleaned,
      })
    }
  }

  // All writes + the GL-Impact re-materialization happen in one transaction,
  // so a GL edit into a closed period rolls the whole edit back (nothing
  // partial).
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('openbooks.amend', 'on', true)`)
      const auditCandidate = await captureTransactionAuditSnapshot(tx, id)
      const auditBefore = auditCandidate?.document.status === 'posted' ? auditCandidate : null
      const sigBefore = await glSignature(tx, id)

      if (preparedLines) {
        await tx.execute(sql`delete from document_lines where document_id = ${id}`)
        for (let i = 0; i < preparedLines.length; i++) {
          const l = preparedLines[i]!
          await tx.execute(sql`
            insert into document_lines (org_id, document_id, line_number, account_id, item_id, description,
                                        quantity, unit, unit_price, amount, tax_code_id, tax_amount, tax_overridden,
                                        department_id, project_id, location_id, class_id, extra_dims, custom)
            values (${user.orgId}, ${id}, ${i + 1}, ${l.accountId}, ${l.itemId}, ${l.description},
                    ${l.quantity ?? '1'}, ${l.unit}, ${l.unitPrice ?? l.amount}, ${l.amount},
                    ${l.taxCodeId}, ${l.taxAmount}, ${l.taxOverridden},
                    ${l.departmentId}, ${l.projectId}, ${l.locationId}, ${l.classId},
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
          updated_at = now(), updated_by = ${user.id}
        where id = ${id} and org_id = ${user.orgId}
      `)

      const effectivePartyId = body.partyId !== undefined ? body.partyId : row.partyId
      if (effectivePartyId && ['customer_invoice', 'customer_credit', 'customer_payment'].includes(row.kind)) {
        await promoteCrmAccount(tx, {
          orgId: user.orgId,
          partyId: effectivePartyId,
          actorId: user.id,
          toStage: 'customer',
          sourceKind: row.kind,
          sourceId: id,
        })
      }

      if ((await glSignature(tx, id)) !== sigBefore) {
        await regenerateGlImpactTx(tx, id, deps, user.id)
      }
      if (auditBefore) {
        const auditAfter = await captureTransactionAuditSnapshot(tx, id)
        if (!auditAfter) throw new Error(`document ${id} disappeared during amendment`)
        await recordTransactionAudit(tx, {
          orgId: user.orgId,
          documentId: id,
          action: 'update',
          actorId: user.id,
          source: 'ui',
          before: auditBefore,
          after: auditAfter,
        })
      }
    })
  } catch (e) {
    if (e instanceof ClosedPeriodError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }

  // on_update flows fire AFTER the edit commits. The edit-shape data rides on
  // the EVENT (run.ts surfaces it as eval-context values: previousTotal /
  // totalChanged / changedFields / changedLineFields / old_* — the NetSuite
  // "re-approval on material edit" pattern). runRecordFlows never throws into
  // the caller and cannot veto the saved edit; it is awaited so it runs
  // inside this request's RLS org scope (same posture as on_create in
  // lib/documents.ts).
  const newTotal = totals?.total ?? row.total
  const newTaxTotal = totals?.taxTotal ?? row.taxTotal
  const changedFields: string[] = []
  if (Number(newTotal) !== Number(row.total)) changedFields.push('total')
  if (Number(newTaxTotal) !== Number(row.taxTotal)) changedFields.push('taxTotal')
  if (body.partyId !== undefined && body.partyId !== row.partyId) changedFields.push('partyId')
  // Line-level diff: pair old/new lines by line number; adds/removes count as
  // every compared field changing (a removed expense line IS a material edit).
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
      source: 'ui',
      previousTotal: row.total,
      totalChanged: Number(newTotal) !== Number(row.total),
      changedFields,
      changedLineFields: [...changedLineFields],
      old: { total: row.total, taxTotal: row.taxTotal },
    },
    row.kind,
    id,
    { orgId: user.orgId, userId: user.id },
  )

  const doc = await loadDocument(id)
  return NextResponse.json(doc)
}

/** Delete a document (guarded: open period, no applied payments, no downstream conversion). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params
  const owned = (await db.execute(
    sql`select kind from documents where id = ${id} and org_id = ${authz.user.orgId}`,
  )) as unknown as { rows: { kind: string }[] }
  const row = owned.rows[0]
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const cfg = DOC_KINDS[row.kind]
  if (!cfg) return NextResponse.json({ error: `kind "${row.kind}" is not editable here` }, { status: 422 })
  if (!can(authz, createPermission(row.kind))) {
    return NextResponse.json({ error: `missing permission: ${createPermission(row.kind)}` }, { status: 403 })
  }
  // Flow-managed lock: a locked record can't be deleted out from under its
  // workflow either (same exemptions as edits).
  {
    const roles = await userRoleKeys(authz.user.orgId, authz.user.id)
    const lock = await checkFlowLock(row.kind, id, {
      isAdmin: authz.user.isSuperAdmin || roles.has('admin'),
      roles: [...roles],
    })
    if (lock) {
      return NextResponse.json(
        { error: `this document is locked by a workflow${lock.reason ? ` — ${lock.reason}` : ''}` },
        { status: 409 },
      )
    }
  }
  try {
    await deleteDocument(id, authz.user.id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof DeleteError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }
}
