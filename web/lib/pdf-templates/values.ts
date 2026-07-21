import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { money } from '../format'
import { currencySymbol } from '../statement-format'
import { PDF_RECORD_TYPE_BY_KEY, type PdfMergeField, type PdfRecordTypeMeta } from './catalog'
import { loadFieldTicket } from '../field-tickets'

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
  if (meta.key === 'field_ticket') return loadFieldTicketValues(orgId, id)
  return loadDocumentValues(meta, orgId, id)
}


/**
 * Field-ticket merge map. Crew rows collapse time types into reg/OT/DT tiers
 * by bill multiplier (<1.25 reg, <1.75 OT, else DT) and expose per-day hour
 * cells (day1..day7 × tier) so a template can reproduce the classic weekly
 * grid exactly; signature images are data-URLs for <img src> embedding.
 */
async function loadFieldTicketValues(orgId: string, id: string): Promise<PdfRecordValues | null> {
  let ticket: Awaited<ReturnType<typeof loadFieldTicket>>
  try {
    ticket = await loadFieldTicket(orgId, id)
  } catch {
    return null
  }
  const org = await orgRow(orgId)
  const symbol = currencySymbol(org.base_currency)
  const m = (v: unknown) => (v === null || v === undefined || v === '' ? '' : money(Number(v), symbol))

  const ft = ticket.fieldTicket
  // Day axis: up to 7 days from periodStart.
  const days: string[] = []
  {
    const [y, mo, d] = ft.periodStart.split('-').map(Number)
    const cur = new Date(Date.UTC(y, mo - 1, d, 12))
    for (let i = 0; i < 7; i++) {
      const dayIso = cur.toISOString().slice(0, 10)
      if (dayIso > ft.periodEnd) break
      days.push(dayIso)
      cur.setUTCDate(cur.getUTCDate() + 1)
    }
  }
  const tier = (mult: unknown): 'reg' | 'ot' | 'dt' => {
    const n = Number(mult)
    if (!Number.isFinite(n) || n < 1.25) return 'reg'
    return n < 1.75 ? 'ot' : 'dt'
  }

  interface CrewAgg {
    employee_name: string
    labor_class: string
    hours: Record<'reg' | 'ot' | 'dt', number>
    rates: Record<'reg' | 'ot' | 'dt', string | null>
    perDay: Record<string, number>
    amount: number
  }
  const crewMap = new Map<string, CrewAgg>()
  for (const e of ticket.entries) {
    const k = `${e.employee_party_id}|${e.item_id ?? ''}`
    let row = crewMap.get(k)
    if (!row) {
      row = {
        employee_name: e.employee_name,
        labor_class: e.item_name ?? '',
        hours: { reg: 0, ot: 0, dt: 0 },
        rates: { reg: null, ot: null, dt: null },
        perDay: {},
        amount: 0,
      }
      crewMap.set(k, row)
    }
    const t = tier(e.bill_multiplier)
    const h = Number(e.hours) || 0
    row.hours[t] += h
    if (e.bill_rate != null) {
      row.rates[t] = row.rates[t] ?? String(e.bill_rate)
      row.amount += h * Number(e.bill_rate)
    }
    const di = days.indexOf(e.worked_on)
    if (di >= 0) row.perDay[`day${di + 1}_${t}`] = (row.perDay[`day${di + 1}_${t}`] ?? 0) + h
  }

  const crew = [...crewMap.values()].map((r) => {
    const rowVals: Record<string, unknown> = {
      employee_name: r.employee_name,
      labor_class: r.labor_class,
      class_code: r.labor_class ? r.labor_class.charAt(0).toUpperCase() : '',
      reg_hours: r.hours.reg ? r.hours.reg.toFixed(1) : '',
      ot_hours: r.hours.ot ? r.hours.ot.toFixed(1) : '',
      dt_hours: r.hours.dt ? r.hours.dt.toFixed(1) : '',
      total_hours: (r.hours.reg + r.hours.ot + r.hours.dt).toFixed(1),
      reg_rate: r.rates.reg != null ? m(r.rates.reg) : '',
      ot_rate: r.rates.ot != null ? m(r.rates.ot) : '',
      dt_rate: r.rates.dt != null ? m(r.rates.dt) : '',
      amount: r.amount ? m(r.amount.toFixed(2)) : '',
    }
    for (let i = 1; i <= 7; i++) {
      for (const t of ['reg', 'ot', 'dt'] as const) {
        const key = `day${i}_${t}`
        rowVals[key] = r.perDay[key] ? String(r.perDay[key]) : ''
      }
    }
    return rowVals
  })

  const party = (await db.execute(sql`
    select display_name, email, phone from parties where id = (select party_id from documents where id = ${id})
  `)) as unknown as { rows: { display_name: string | null; email: string | null; phone: string | null }[] }

  const totalHours = ticket.entries.reduce((a, e) => a + (Number(e.hours) || 0), 0)
  const dayLabel = (dayIso: string) => {
    const d = new Date(`${dayIso}T12:00:00Z`)
    return `${d.toLocaleDateString('en-CA', { weekday: 'short', timeZone: 'UTC' })} ${dayIso.slice(5)}`
  }
  const values: Record<string, unknown> = {
    document_number: ticket.documentNumber,
    document_date: fmtDate(ticket.documentDate),
    status: fmtStatus(ticket.status),
    period: fmtStatus(ft.period),
    period_start: fmtDate(ft.periodStart),
    period_end: fmtDate(ft.periodEnd),
    project_name: ticket.projectName,
    po_number: ft.poNumber ?? '',
    foreman_name: ticket.foremanName,
    work_description: ft.workDescription ?? '',
    party_name: party.rows[0]?.display_name ?? ticket.customerName,
    party_email: party.rows[0]?.email ?? '',
    party_phone: party.rows[0]?.phone ?? '',
    party_address: '',
    labor_total: m(ticket.laborTotal),
    lines_total: m(ticket.linesTotal),
    grand_total: m(ticket.grandTotal),
    total_hours: totalHours.toFixed(1),
    customer_signature_image: ft.signatures?.customer?.image ?? '',
    customer_signature_name: ft.signatures?.customer?.name ?? '',
    customer_signed_at: ft.signatures?.customer?.at ? fmtDate(ft.signatures.customer.at.slice(0, 10)) : '',
    customer_comment: ft.signatures?.customer?.comment ?? '',
    foreman_signature_image: ft.signatures?.foreman?.image ?? '',
    org_name: org.name,
    printed_date: fmtDate(new Date().toISOString().slice(0, 10)),
    crew,
    lines: ticket.lines.map((l) => ({
      item_name: l.item_name ?? '',
      description: l.description ?? '',
      quantity: fmtQty(l.quantity),
      unit_price: m(l.unit_price),
      amount: m(l.amount),
    })),
  }
  for (let i = 0; i < 7; i++) values[`day${i + 1}_label`] = days[i] ? dayLabel(days[i]) : ''

  return { values, reference: ticket.documentNumber }
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
