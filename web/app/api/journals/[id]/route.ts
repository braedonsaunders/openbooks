import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { sum } from '@openbooks/engine/src/money.ts'
import { regenerateGlImpactTx, ClosedPeriodError } from '@openbooks/engine/src/posting.ts'
import { deleteDocument, DeleteError } from '@openbooks/engine/src/document-delete.ts'
import { captureTransactionAuditSnapshot, recordTransactionAudit } from '@openbooks/engine/src/transaction-audit.ts'
import { guardPermission } from '../../../../lib/authz'
import { loadJournalDoc } from '../../../../lib/journals'
import { loadFieldDefs, validateCustomValues } from '../../../../lib/custom-fields'
import { isUuid } from '../../../../lib/list-params'
import { segmentRegistry, validateExtraDims } from '../../../../lib/segments'

export const runtime = 'nodejs'

async function controlDeps(orgId: string) {
  const r = (await db.execute(sql`select settings->'controlAccounts' as c from orgs where id = ${orgId}`)) as any
  const c = r.rows[0]?.c ?? {}
  return { control: { ar: c.ar, ap: c.ap, bank: c.bank, taxCollected: c.taxCollected, taxPaid: c.taxPaid } }
}

/**
 * A document-layer signature of everything that shapes a manual journal's GL
 * impact. Journals carry no party/item/tax on their lines — the GL is the
 * header date/currency plus each line's account, signed amount, and dimensions.
 * Comparing this before vs after a save tells us whether the edit was
 * GL-affecting — WITHOUT assuming the stored entry came from our own posting
 * rules (migrated journals carry NetSuite's GL). Non-GL edits (memo, reference #)
 * leave this unchanged and never touch the ledger.
 */
async function glSignature(tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }, id: string, orgId: string): Promise<string> {
  const r = (await tx.execute(sql`
    select md5(
      coalesce(d.party_id::text,'') || '~' || coalesce(d.document_date::text,'') || '~' ||
      coalesce(d.posting_date::text,'') || '~' || coalesce(d.currency,'') || '~' || coalesce(d.fx_rate::text,'') || '~' ||
      coalesce(d.subsidiary_id::text,'') || '~' ||
      coalesce(d.extra_dims::text,'{}') || '~' ||
      coalesce((select string_agg(
        coalesce(account_id::text,'') || ':' || amount::text || ':' ||
        coalesce(party_id::text,'') || ':' ||
        coalesce(department_id::text,'') || ':' || coalesce(project_id::text,'') || ':' ||
        coalesce(subsidiary_id::text,'') || ':' || coalesce(extra_dims::text,'{}'),
        '|' order by line_number)
        from document_lines where document_id = d.id and org_id = d.org_id), '')
    ) as sig
    from documents d where d.id = ${id} and d.org_id = ${orgId}`)) as { rows: { sig: string }[] }
  return r.rows[0]?.sig ?? ''
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('gl.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const journal = await loadJournalDoc(id, gate.user.orgId)
  if (!journal) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(journal)
}

interface JournalLineInput {
  accountId: string
  description?: string | null
  /** Signed base amount: + debit / − credit. */
  amount: string
  /** Line entity: the customer/vendor/employee this leg belongs to. */
  partyId?: string | null
  departmentId?: string | null
  projectId?: string | null
  /** Intercompany line override (null = the header's subsidiary). */
  subsidiaryId?: string | null
  extraDims?: Record<string, string | null>
  custom?: Record<string, unknown>
}

/**
 * Autosave a manual journal. Draft journals edit freely (no GL yet). A POSTED
 * journal is editable in place, NetSuite-style: its journal entry is a derived
 * projection re-materialized on save (regenerateGlImpactTx) — a non-GL change
 * (memo, reference #) is a no-op on the ledger; a GL change regenerates the
 * entry's lines and is blocked only if the posting period is closed.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('gl.post')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params

  const existing = (await db.execute(
    sql`select status from documents where id = ${id} and kind = 'journal' and org_id = ${user.orgId}`,
  )) as unknown as { rows: { status: string }[] }
  if (!existing.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (existing.rows[0].status === 'voided') {
    return NextResponse.json({ error: 'a voided journal cannot be edited' }, { status: 422 })
  }
  const deps = await controlDeps(user.orgId)

  const body = (await req.json()) as {
    partyId?: string | null
    documentDate?: string
    referenceNumber?: string | null
    memo?: string | null
    /** null = org root (posting resolves it). Only sent by multi-subsidiary orgs. */
    subsidiaryId?: string | null
    extraDims?: Record<string, string | null>
    custom?: Record<string, unknown>
    lines?: JournalLineInput[]
  }
  const requestedSubsidiaries = [...new Set([
    ...(body.subsidiaryId ? [body.subsidiaryId] : []),
    ...(body.lines ?? []).flatMap((line) => line.subsidiaryId ? [line.subsidiaryId] : []),
  ])]
  if (requestedSubsidiaries.some((subsidiaryId) => !isUuid(subsidiaryId))) {
    return NextResponse.json({ error: 'invalid subsidiary' }, { status: 422 })
  }
  if (requestedSubsidiaries.length) {
    const subsidiaries = (await db.execute(sql`
      select id from subsidiaries
       where org_id = ${user.orgId} and is_active and not is_elimination
         and id = any(${`{${requestedSubsidiaries.join(',')}}`}::uuid[])`)) as any
    if (subsidiaries.rows.length !== requestedSubsidiaries.length) {
      return NextResponse.json({ error: 'invalid subsidiary' }, { status: 422 })
    }
  }

  // custom-field validation (header + line) against the live definitions
  const [headerDefs, lineDefs, segments] = await Promise.all([
    loadFieldDefs('documents', 'journal'),
    loadFieldDefs('document_lines', 'journal'),
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

  // Pre-validate + prepare lines (read-only) before touching the DB, so a bad
  // line returns 422 without a partial write.
  // journal totals = sum of debits (positive line amounts); tax never applies
  let totalDebits: string | null = null
  let preparedLines: { accountId: string; description: string | null; amount: string; partyId: string | null; departmentId: string | null; projectId: string | null; subsidiaryId: string | null; extraDims: Record<string, string>; custom: Record<string, unknown> }[] | null = null
  if (body.lines) {
    const valid = body.lines.filter(
      (l) => l.accountId && !Number.isNaN(Number(l.amount)) && Number(l.amount) !== 0,
    )
    totalDebits = sum(valid.map((l) => (Number(l.amount) > 0 ? l.amount : '0')))
    preparedLines = []
    for (let i = 0; i < valid.length; i++) {
      const l = valid[i]!
      const lv = validateCustomValues(lineDefs, l.custom)
      if (!lv.ok) {
        return NextResponse.json(
          { error: `Line ${i + 1}: ${Object.values(lv.errors)[0]}`, fieldErrors: lv.errors },
          { status: 422 },
        )
      }
      const lineDims = validateExtraDims(l.extraDims, segments)
      if (!lineDims.ok) return NextResponse.json({ error: `Line ${i + 1}: ${lineDims.error}` }, { status: 422 })
      preparedLines.push({
        accountId: l.accountId,
        description: l.description ?? null,
        amount: l.amount,
        partyId: l.partyId ?? null,
        departmentId: l.departmentId ?? null,
        projectId: l.projectId ?? null,
        subsidiaryId: l.subsidiaryId ?? null,
        extraDims: lineDims.cleaned,
        custom: lv.cleaned,
      })
    }
  }

  // All writes + the GL-Impact re-materialization happen in one transaction, so
  // a GL edit into a closed period rolls the whole edit back (nothing partial).
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('openbooks.amend', 'on', true)`)
      const auditCandidate = await captureTransactionAuditSnapshot(tx, id)
      const auditBefore = auditCandidate?.document.status === 'posted' ? auditCandidate : null
        const sigBefore = await glSignature(tx, id, user.orgId)

      if (preparedLines) {
        await tx.execute(sql`delete from document_lines where document_id = ${id} and org_id = ${user.orgId}`)
        for (let i = 0; i < preparedLines.length; i++) {
          const l = preparedLines[i]!
          await tx.execute(sql`
            insert into document_lines (org_id, document_id, line_number, account_id, description,
                                        quantity, unit_price, amount, party_id, department_id, project_id,
                                        subsidiary_id, extra_dims, custom)
            values (${user.orgId}, ${id}, ${i + 1}, ${l.accountId}, ${l.description},
                    '1', ${l.amount}, ${l.amount}, ${l.partyId}, ${l.departmentId}, ${l.projectId},
                    ${l.subsidiaryId}, ${JSON.stringify(l.extraDims)}::jsonb, ${JSON.stringify(l.custom)})
          `)
        }
      }

      await tx.execute(sql`
        update documents set
          party_id = ${body.partyId !== undefined ? body.partyId : sql`party_id`},
          document_date = coalesce(${body.documentDate ?? null}, document_date),
          reference_number = ${body.referenceNumber !== undefined ? body.referenceNumber : sql`reference_number`},
          memo = ${body.memo !== undefined ? body.memo : sql`memo`},
          subsidiary_id = ${body.subsidiaryId !== undefined ? body.subsidiaryId : sql`subsidiary_id`},
          extra_dims = ${headerDims ? JSON.stringify(headerDims.cleaned) : sql`extra_dims`}::jsonb,
          custom = coalesce(${headerCustom ? JSON.stringify(headerCustom) : null}::jsonb, custom),
          subtotal = coalesce(${totalDebits}, subtotal),
          total = coalesce(${totalDebits}, total),
          updated_at = now(), updated_by = ${user.id}
        where id = ${id} and org_id = ${user.orgId}
      `)

      // Re-materialize the GL-Impact projection only when the edit actually
      // changed GL-relevant fields (no-op for draft journals and for non-GL
      // edits like memo/reference #, which preserves migrated GL).
      if ((await glSignature(tx, id, user.orgId)) !== sigBefore) {
        await regenerateGlImpactTx(tx, id, deps, user.id)
      }
      if (auditBefore) {
        const auditAfter = await captureTransactionAuditSnapshot(tx, id)
        if (!auditAfter) throw new Error(`journal ${id} disappeared during amendment`)
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

  const journal = await loadJournalDoc(id, user.orgId)
  return NextResponse.json(journal)
}

/** Delete a journal (guarded: open period, no applied payments, no downstream conversion). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('gl.post')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const owned = (await db.execute(
    sql`select 1 from documents where id = ${id} and kind = 'journal' and org_id = ${gate.user.orgId}`,
  )) as unknown as { rows: unknown[] }
  if (!owned.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  try {
    await deleteDocument(id, gate.user.id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof DeleteError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }
}
