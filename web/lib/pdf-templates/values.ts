import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { money } from '../format'
import { currencySymbol } from '../statement-format'
import { PDF_RECORD_TYPE_BY_KEY, type PdfMergeField, type PdfRecordTypeMeta } from './catalog'

/**
 * The value loader — shapes a real record into the merge map a PDF template
 * renders against. Every catalog field key gets a (possibly empty) formatted
 * string; collections become arrays of row objects. Org custom fields
 * (documents.custom, keyed by def key) are appended as `cf_<key>`.
 */

export type PdfRecordValues = {
  values: Record<string, unknown>
  /** e.g. "INV-000123" — used for the download filename. */
  reference: string
}

function fmtDate(v: unknown): string {
  if (!v) return ''
  const s = String(v)
  // date columns arrive as 'YYYY-MM-DD' — parse as local so the day never shifts.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
}

function fmtStatus(v: unknown): string {
  const s = String(v ?? '').replace(/_/g, ' ')
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''
}

function fmtQty(v: unknown): string {
  if (v === null || v === undefined || v === '') return ''
  const n = Number(v)
  if (Number.isNaN(n)) return String(v)
  return n.toLocaleString('en-CA', { maximumFractionDigits: 4 })
}

type OrgRow = { name: string; base_currency: string; brand_primary: string | null }

async function orgRow(orgId: string): Promise<OrgRow> {
  const r = (await db.execute(sql`
    select name, base_currency, settings ->> 'brandPrimary' as brand_primary
      from orgs where id = ${orgId}
  `)) as unknown as { rows: OrgRow[] }
  return r.rows[0] ?? { name: 'openbooks', base_currency: 'CAD', brand_primary: null }
}

async function customFieldValues(
  orgId: string,
  targetTable: string,
  targetKind: string | null,
  custom: Record<string, unknown>,
  symbol: string,
): Promise<Record<string, string>> {
  const r = (await db.execute(sql`
    select key, field_type from custom_field_defs
     where org_id = ${orgId} and target_table = ${targetTable} and is_active
       and (target_kind is null ${targetKind ? sql`or target_kind = ${targetKind}` : sql``})
  `)) as unknown as { rows: { key: string; field_type: string }[] }
  const out: Record<string, string> = {}
  for (const def of r.rows) {
    const v = custom?.[def.key]
    if (v === null || v === undefined || v === '') {
      out[`cf_${def.key}`] = ''
    } else if (def.field_type === 'currency') {
      out[`cf_${def.key}`] = money(v as number, symbol)
    } else if (def.field_type === 'date') {
      out[`cf_${def.key}`] = fmtDate(v)
    } else if (def.field_type === 'boolean') {
      out[`cf_${def.key}`] = v ? 'Yes' : 'No'
    } else {
      out[`cf_${def.key}`] = Array.isArray(v) ? v.join(', ') : String(v)
    }
  }
  return out
}

async function loadDocumentValues(
  meta: PdfRecordTypeMeta,
  orgId: string,
  id: string,
): Promise<PdfRecordValues | null> {
  const r = (await db.execute(sql`
    select d.*, p.display_name as party_name, p.email as party_email, p.phone as party_phone,
           a.line1, a.line2, a.city, a.region, a.postal_code, a.country,
           case when d.status = 'posted' then d.total - ap.applied end as balance_due
      from documents d
      left join parties p on p.id = d.party_id
      left join lateral (
        select * from addresses where party_id = d.party_id
         order by is_default_billing desc, created_at limit 1
      ) a on true
      left join lateral (
        select coalesce(sum(x.amount), 0) as applied
          from journal_lines jl
          join applications x on x.to_line_id = jl.id and x.unapplied_at is null
         where jl.entry_id = d.posted_entry_id and jl.is_open_item
      ) ap on true
     where d.id = ${id} and d.org_id = ${orgId} and d.kind = ${meta.docKind}
  `)) as unknown as { rows: Record<string, any>[] }
  const doc = r.rows[0]
  if (!doc) return null

  const org = await orgRow(orgId)
  const symbol = currencySymbol(String(doc.currency ?? org.base_currency))

  const lines = (await db.execute(sql`
    select l.line_number, l.description, l.quantity, l.unit, l.unit_price, l.amount, l.tax_amount,
           coalesce(nullif(trim(concat(acc.number, ' ', acc.name)), ''), acc.name) as account_name,
           i.name as item_name
      from document_lines l
      left join accounts acc on acc.id = l.account_id
      left join items i on i.id = l.item_id
     where l.document_id = ${id}
     order by l.line_number
  `)) as unknown as { rows: Record<string, any>[] }

  const address = [
    doc.line1,
    doc.line2,
    [doc.city, doc.region, doc.postal_code].filter(Boolean).join(', '),
    doc.country,
  ]
    .filter(Boolean)
    .join(', ')

  const subtotal = Number(doc.subtotal ?? 0)
  const taxTotal = Number(doc.tax_total ?? 0)
  const total = Number(doc.total ?? 0)

  const values: Record<string, unknown> = {
    document_number: doc.document_number ?? '',
    document_date: fmtDate(doc.document_date),
    due_date: fmtDate(doc.due_date),
    reference_number: doc.reference_number ?? '',
    status: fmtStatus(doc.status),
    memo: doc.memo ?? '',
    currency: doc.currency ?? org.base_currency,
    party_name: doc.party_name ?? '',
    party_email: doc.party_email ?? '',
    party_phone: doc.party_phone ?? '',
    party_address: address,
    subtotal: money(subtotal, symbol),
    tax_total: money(taxTotal, symbol),
    total: money(total, symbol),
    balance_due: doc.balance_due === null || doc.balance_due === undefined ? '' : money(Number(doc.balance_due), symbol),
    org_name: org.name,
    printed_date: new Date().toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' }),
    lines: lines.rows.map((l) => ({
      line_number: String(l.line_number ?? ''),
      item_name: l.item_name ?? '',
      account_name: l.account_name ?? '',
      description: l.description ?? '',
      quantity: fmtQty(l.quantity),
      unit: l.unit ?? '',
      unit_price: l.unit_price === null || l.unit_price === undefined ? '' : money(Number(l.unit_price), symbol),
      tax_amount: l.tax_amount === null || l.tax_amount === undefined || Number(l.tax_amount) === 0 ? '' : money(Number(l.tax_amount), symbol),
      amount: money(Number(l.amount ?? 0), symbol),
    })),
    ...(await customFieldValues(orgId, 'documents', meta.docKind, (doc.custom ?? {}) as Record<string, unknown>, symbol)),
  }

  return { values, reference: String(doc.document_number ?? meta.docTitle) }
}

async function loadJournalValues(orgId: string, id: string): Promise<PdfRecordValues | null> {
  const r = (await db.execute(sql`
    select e.* from journal_entries e where e.id = ${id} and e.org_id = ${orgId}
  `)) as unknown as { rows: Record<string, any>[] }
  const entry = r.rows[0]
  if (!entry) return null

  const org = await orgRow(orgId)
  const symbol = currencySymbol(org.base_currency)

  const lines = (await db.execute(sql`
    select l.line_number, l.amount, l.memo,
           acc.number as account_number, acc.name as account_name
      from journal_lines l
      left join accounts acc on acc.id = l.account_id
     where l.entry_id = ${id}
     order by l.line_number
  `)) as unknown as { rows: Record<string, any>[] }

  let debits = 0
  let credits = 0
  const lineRows = lines.rows.map((l) => {
    const amount = Number(l.amount ?? 0)
    if (amount >= 0) debits += amount
    else credits += -amount
    return {
      line_number: String(l.line_number ?? ''),
      account_number: l.account_number ?? '',
      account_name: l.account_name ?? '',
      memo: l.memo ?? '',
      debit: amount >= 0 ? money(amount, symbol) : '',
      credit: amount < 0 ? money(-amount, symbol) : '',
    }
  })

  const values: Record<string, unknown> = {
    entry_number: entry.entry_number ?? '',
    posting_date: fmtDate(entry.posting_date),
    status: fmtStatus(entry.status),
    origin: fmtStatus(entry.origin),
    memo: entry.memo ?? '',
    total_debits: money(debits, symbol),
    total_credits: money(credits, symbol),
    org_name: org.name,
    printed_date: new Date().toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' }),
    lines: lineRows,
  }

  return { values, reference: String(entry.entry_number ?? 'Journal') }
}

/** Load + format the merge values for one record. Null when not found. */
export async function loadPdfRecordValues(
  recordType: string,
  orgId: string,
  id: string,
): Promise<PdfRecordValues | null> {
  const meta = PDF_RECORD_TYPE_BY_KEY[recordType]
  if (!meta) return null
  if (meta.key === 'journal_entry') return loadJournalValues(orgId, id)
  return loadDocumentValues(meta, orgId, id)
}

/** The most recent record of a type — real data for the editor preview. */
export async function findSamplePdfRecordId(recordType: string, orgId: string): Promise<string | null> {
  const meta = PDF_RECORD_TYPE_BY_KEY[recordType]
  if (!meta) return null
  if (meta.key === 'journal_entry') {
    const r = (await db.execute(sql`
      select id from journal_entries where org_id = ${orgId} order by created_at desc limit 1
    `)) as unknown as { rows: { id: string }[] }
    return r.rows[0]?.id ?? null
  }
  const r = (await db.execute(sql`
    select id from documents where org_id = ${orgId} and kind = ${meta.docKind}
     order by created_at desc limit 1
  `)) as unknown as { rows: { id: string }[] }
  return r.rows[0]?.id ?? null
}

/** Custom-field merge fields for the builder palette (per record type). */
export async function customMergeFields(recordType: string, orgId: string): Promise<PdfMergeField[]> {
  const meta = PDF_RECORD_TYPE_BY_KEY[recordType]
  if (!meta || !meta.docKind) return []
  const r = (await db.execute(sql`
    select key, label from custom_field_defs
     where org_id = ${orgId} and target_table = 'documents' and is_active
       and (target_kind is null or target_kind = ${meta.docKind})
     order by sort_order, label
  `)) as unknown as { rows: { key: string; label: string }[] }
  return r.rows.map((d) => ({ key: `cf_${d.key}`, label: d.label, sample: d.label }))
}
