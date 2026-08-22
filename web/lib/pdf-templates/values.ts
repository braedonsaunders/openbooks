import 'server-only'
import { sql } from 'drizzle-orm'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { db } from '@openbooks/engine/src/db.ts'
import { add, cmp, isZero, mul, neg, sum } from '@openbooks/engine/src/money.ts'
import { amountInWords } from '@openbooks/engine/src/payroll-cheques.ts'
import { createMoneyFormatter, type MoneyFormatter } from '../money-format'
import { resolveLocale } from '../locale'
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

function fmtDate(v: unknown, locale: string): string {
  if (!v) return ''
  const s = String(v)
  // date columns arrive as 'YYYY-MM-DD' — parse as local so the day never shifts.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' })
}

function fmtStatus(v: unknown): string {
  const s = String(v ?? '').replace(/_/g, ' ')
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''
}

function fmtQty(v: unknown, locale: string): string {
  if (v === null || v === undefined || v === '') return ''
  const n = Number(v)
  if (Number.isNaN(n)) return String(v)
  return n.toLocaleString(locale, { maximumFractionDigits: 4 })
}

type OrgRow = { name: string; base_currency: string; brand_primary: string | null }

async function orgRow(orgId: string): Promise<OrgRow> {
  const r = (await db.execute<OrgRow>(sql`
    select name, base_currency, settings ->> 'brandPrimary' as brand_primary
      from orgs where id = ${orgId}
  `))
  return r.rows[0] ?? { name: 'openbooks', base_currency: 'CAD', brand_primary: null }
}

async function customFieldValues(
  orgId: string,
  targetTable: string,
  targetKind: string | null,
  custom: Record<string, unknown>,
  format: MoneyFormatter,
): Promise<Record<string, string>> {
  const r = (await db.execute<{ key: string; field_type: string }>(sql`
    select key, field_type from custom_field_defs
     where org_id = ${orgId} and target_table = ${targetTable} and is_active
       and (target_kind is null ${targetKind ? sql`or target_kind = ${targetKind}` : sql``})
  `))
  const out: Record<string, string> = {}
  for (const def of r.rows) {
    const v = custom?.[def.key]
    if (v === null || v === undefined || v === '') {
      out[`cf_${def.key}`] = ''
    } else if (def.field_type === 'currency') {
      out[`cf_${def.key}`] = format.money(v as number)
    } else if (def.field_type === 'date') {
      out[`cf_${def.key}`] = fmtDate(v, format.locale)
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
  // `target_transaction_amount`, NOT `amount`: `documents.total` is in the
  // document's TRANSACTION currency while `applications.amount` is the
  // base-currency carrying amount. The old subtraction printed a balance in
  // neither currency on every FX invoice/credit — on paper and in emailed
  // records (same fix as engine/src/dunning.ts).
  const r = (await db.execute<Record<string, any>>(sql`
    select d.*, p.display_name as party_name, p.email as party_email, p.phone as party_phone,
           a.line1, a.line2, a.city, a.region, a.postal_code, a.country,
           case when d.status = 'posted' then d.total - ap.applied end as balance_due
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      left join lateral (
        select * from addresses where party_id = d.party_id
         order by is_default_billing desc, created_at limit 1
      ) a on true
      left join lateral (
        select coalesce(sum(x.target_transaction_amount), 0) as applied
          from journal_lines jl
          join applications x on x.org_id = jl.org_id and x.to_line_id = jl.id and x.unapplied_at is null
         where jl.org_id = d.org_id and jl.entry_id = d.posted_entry_id and jl.is_open_item
      ) ap on true
     where d.id = ${id} and d.org_id = ${orgId} and d.kind = ${meta.docKind}
  `))
  const doc = r.rows[0]
  if (!doc) return null

  const [org, locale] = await Promise.all([orgRow(orgId), resolveLocale()])
  const format = createMoneyFormatter(locale, String(doc.currency ?? 'USD'))
  const { money } = format

  const lines = (await db.execute<Record<string, any>>(sql`
    select l.line_number, l.description, l.quantity, l.unit, l.unit_price, l.amount, l.tax_amount,
           coalesce(nullif(trim(concat(acc.number, ' ', acc.name)), ''), acc.name) as account_name,
           i.name as item_name
      from document_lines l
      left join accounts acc on acc.id = l.account_id
      left join items i on i.id = l.item_id and i.org_id = l.org_id
     where l.document_id = ${id}
     order by l.line_number
  `))

  const address = [
    doc.line1,
    doc.line2,
    [doc.city, doc.region, doc.postal_code].filter(Boolean).join(', '),
    doc.country,
  ]
    .filter(Boolean)
    .join(', ')

  const subtotal = String(doc.subtotal ?? '0')
  const taxTotal = String(doc.tax_total ?? '0')
  const total = String(doc.total ?? '0')

  const values: Record<string, unknown> = {
    document_number: doc.document_number ?? '',
    document_date: fmtDate(doc.document_date, locale),
    due_date: fmtDate(doc.due_date, locale),
    reference_number: doc.reference_number ?? '',
    status: fmtStatus(doc.status),
    memo: doc.memo ?? '',
    currency: doc.currency ?? org.base_currency,
    party_name: doc.party_name ?? '',
    party_email: doc.party_email ?? '',
    party_phone: doc.party_phone ?? '',
    party_address: address,
    subtotal: money(subtotal),
    tax_total: money(taxTotal),
    total: money(total),
    balance_due: doc.balance_due === null || doc.balance_due === undefined ? '' : money(String(doc.balance_due)),
    org_name: org.name,
    printed_date: new Date().toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' }),
    lines: lines.rows.map((l) => ({
      line_number: String(l.line_number ?? ''),
      item_name: l.item_name ?? '',
      account_name: l.account_name ?? '',
      description: l.description ?? '',
      quantity: fmtQty(l.quantity, locale),
      unit: l.unit ?? '',
      unit_price: l.unit_price === null || l.unit_price === undefined ? '' : money(String(l.unit_price)),
      tax_amount: l.tax_amount === null || l.tax_amount === undefined || isZero(String(l.tax_amount)) ? '' : money(String(l.tax_amount)),
      amount: money(String(l.amount ?? '0')),
    })),
    ...(await customFieldValues(orgId, 'documents', meta.docKind, (doc.custom ?? {}) as Record<string, unknown>, format)),
  }

  return { values, reference: String(doc.document_number ?? meta.docTitle) }
}

async function loadJournalValues(orgId: string, id: string): Promise<PdfRecordValues | null> {
  const r = (await db.execute<Record<string, any>>(sql`
    select e.* from journal_entries e where e.id = ${id} and e.org_id = ${orgId}
  `))
  const entry = r.rows[0]
  if (!entry) return null

  const [org, locale] = await Promise.all([orgRow(orgId), resolveLocale()])
  const { money } = createMoneyFormatter(locale, org.base_currency)

  const lines = (await db.execute<Record<string, any>>(sql`
    select l.line_number, l.amount, l.memo,
           acc.number as account_number, acc.name as account_name
      from journal_lines l
      left join accounts acc on acc.id = l.account_id
     where l.entry_id = ${id}
     order by l.line_number
  `))

  const debitAmounts: string[] = []
  const creditAmounts: string[] = []
  const lineRows = lines.rows.map((l) => {
    const amount = String(l.amount ?? '0')
    if (cmp(amount, '0') >= 0) debitAmounts.push(amount)
    else creditAmounts.push(neg(amount))
    return {
      line_number: String(l.line_number ?? ''),
      account_number: l.account_number ?? '',
      account_name: l.account_name ?? '',
      memo: l.memo ?? '',
      debit: cmp(amount, '0') >= 0 ? money(amount) : '',
      credit: cmp(amount, '0') < 0 ? money(neg(amount)) : '',
    }
  })

  const values: Record<string, unknown> = {
    entry_number: entry.entry_number ?? '',
    posting_date: fmtDate(entry.posting_date, locale),
    status: fmtStatus(entry.status),
    origin: fmtStatus(entry.origin),
    memo: entry.memo ?? '',
    total_debits: money(sum(debitAmounts)),
    total_credits: money(sum(creditAmounts)),
    org_name: org.name,
    printed_date: new Date().toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' }),
    lines: lineRows,
  }

  return { values, reference: String(entry.entry_number ?? 'Journal') }
}

/** Load + format the merge values for one record. Null when not found. */
async function loadPayStubValues(orgId: string, id: string): Promise<PdfRecordValues | null> {
  const r = (await db.execute<Record<string, any>>(sql`
    select s.*, r.period_start, r.period_end, d.document_number,
           p.display_name as employee_name, p.email as employee_email
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id
      join documents d on d.id = r.document_id and d.org_id = r.org_id
      join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
     where s.id = ${id} and s.org_id = ${orgId}
  `))
  const stub = r.rows[0]
  if (!stub) return null

  const [org, locale] = await Promise.all([orgRow(orgId), resolveLocale()])
  const { money } = createMoneyFormatter(locale, stub.currency_code ?? org.base_currency)

  const lines = (await db.execute<Record<string, any>>(sql`
    select l.kind, l.description, l.hours, l.rate, l.amount
      from pay_stub_lines l
     where l.stub_id = ${id} and l.org_id = ${orgId}
     order by l.sequence
  `))

  // YTD across committed runs up to and including this stub's pay date.
  const ytd = (await db.execute<{ gross: string; net: string; tax: string }>(sql`
    select coalesce(sum(s.gross), 0) as gross, coalesce(sum(s.net_pay), 0) as net,
           coalesce(sum((s.factors->>'T')::numeric + coalesce((s.factors->>'TB')::numeric, 0)), 0) as tax
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
     where s.org_id = ${orgId} and s.employee_party_id = ${stub.employee_party_id}
       and s.tax_year = ${stub.tax_year} and s.pay_date <= ${stub.pay_date}
  `))

  const byKind = (kind: string) => lines.rows
    .filter((l) => l.kind === kind)
    .map((l) => ({
      description: l.description ?? '',
      hours: l.hours != null ? Number(l.hours).toFixed(2) : '',
      rate: l.rate != null ? money(String(l.rate)) : '',
      amount: money(String(l.amount ?? '0')),
    }))
  const deductionsTotal = sum(
    lines.rows.filter((l) => l.kind === 'deduction').map((l) => String(l.amount ?? '0')),
  )

  const values: Record<string, unknown> = {
    employee_name: stub.employee_name ?? '',
    // party_* aliases power the shared record-email path (sendRecordPdfEmail).
    party_name: stub.employee_name ?? '',
    party_email: stub.employee_email ?? '',
    document_number: stub.document_number ?? '',
    period_start: fmtDate(stub.period_start, locale),
    period_end: fmtDate(stub.period_end, locale),
    pay_date: fmtDate(stub.pay_date, locale),
    province: stub.province ?? '',
    currency: stub.currency_code ?? '',
    gross: money(String(stub.gross ?? '0')),
    total_deductions: money(deductionsTotal),
    net_pay: money(String(stub.net_pay ?? '0')),
    vacation_accrued: money(String(stub.vacation_accrued ?? '0')),
    ytd_gross: money(String(ytd.rows[0]?.gross ?? '0')),
    ytd_tax: money(String(ytd.rows[0]?.tax ?? '0')),
    ytd_net: money(String(ytd.rows[0]?.net ?? '0')),
    org_name: org.name,
    printed_date: new Date().toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' }),
    earnings: byKind('earning'),
    deductions: byKind('deduction'),
    employer_contributions: byKind('employer_contribution'),
  }
  return { values, reference: `${stub.document_number ?? 'Pay stub'} ${stub.employee_name ?? ''}`.trim() }
}

/**
 * The printed cheque for one stub. Keyed on the STUB id (like the pay stub),
 * so a cheque and its voucher share one record and one template.
 *
 * A stub with no allocated cheque number renders NOTHING: an unnumbered cheque
 * is not a negotiable instrument, and printing one would put paper in the world
 * that the ledger cannot match. `issuePayRunCheques` allocates first.
 */
async function loadPayrollChequeValues(orgId: string, id: string): Promise<PdfRecordValues | null> {
  const r = (await db.execute<Record<string, any>>(sql`
    select s.*, r.period_start, r.period_end, d.document_number,
           p.display_name as employee_name,
           a.line1, a.line2, a.city, a.region, a.postal_code, a.country
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id
      join documents d on d.id = r.document_id and d.org_id = r.org_id
      join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
      left join lateral (
        select * from addresses where party_id = s.employee_party_id
         order by is_default_billing desc, created_at limit 1
      ) a on true
     where s.id = ${id} and s.org_id = ${orgId} and s.payment_method = 'cheque'
       and s.cheque_number is not null
  `))
  const stub = r.rows[0]
  if (!stub) return null

  const [org, locale] = await Promise.all([orgRow(orgId), resolveLocale()])
  const { money } = createMoneyFormatter(locale, stub.currency_code ?? org.base_currency)

  const lines = (await db.execute<Record<string, any>>(sql`
    select l.kind, l.description, l.hours, l.rate, l.amount
      from pay_stub_lines l
     where l.stub_id = ${id} and l.org_id = ${orgId}
     order by l.sequence
  `))
  const byKind = (kind: string) => lines.rows
    .filter((l) => l.kind === kind)
    .map((l) => ({
      description: l.description ?? '',
      hours: l.hours != null ? Number(l.hours).toFixed(2) : '',
      rate: l.rate != null ? money(String(l.rate)) : '',
      amount: money(String(l.amount ?? '0')),
    }))
  const deductionsTotal = sum(
    lines.rows.filter((l) => l.kind === 'deduction').map((l) => String(l.amount ?? '0')),
  )

  const address = [
    stub.line1,
    stub.line2,
    [stub.city, stub.region, stub.postal_code].filter(Boolean).join(', '),
    stub.country,
  ].filter(Boolean).join(', ')

  const net = String(stub.net_pay ?? '0')
  const values: Record<string, unknown> = {
    cheque_number: stub.cheque_number ?? '',
    employee_name: stub.employee_name ?? '',
    party_name: stub.employee_name ?? '',
    employee_address: address,
    party_address: address,
    pay_date: fmtDate(stub.pay_date, locale),
    amount: money(net),
    // The legal amount comes from the engine, off the exact decimal — never
    // from the formatted courtesy amount above.
    amount_in_words: amountInWords(net),
    currency: stub.currency_code ?? '',
    memo: `Pay period ${fmtDate(stub.period_start, locale)} – ${fmtDate(stub.period_end, locale)}`,
    document_number: stub.document_number ?? '',
    period_start: fmtDate(stub.period_start, locale),
    period_end: fmtDate(stub.period_end, locale),
    gross: money(String(stub.gross ?? '0')),
    total_deductions: money(deductionsTotal),
    net_pay: money(net),
    org_name: org.name,
    printed_date: new Date().toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' }),
    earnings: byKind('earning'),
    deductions: byKind('deduction'),
  }
  return {
    values,
    reference: `${stub.cheque_number ?? 'Cheque'} ${stub.employee_name ?? ''}`.trim(),
  }
}

export async function loadPdfRecordValues(
  recordType: string,
  orgId: string,
  id: string,
): Promise<PdfRecordValues | null> {
  const meta = PDF_RECORD_TYPE_BY_KEY[recordType]
  if (!meta) return null
  if (meta.key === 'journal_entry') return loadJournalValues(orgId, id)
  if (meta.key === 'pay_stub') return loadPayStubValues(orgId, id)
  if (meta.key === 'payroll_cheque') return loadPayrollChequeValues(orgId, id)
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
    ticket = await loadFieldTicket(orgId, id, { includeRelated: false })
  } catch {
    return null
  }
  const [org, locale] = await Promise.all([orgRow(orgId), resolveLocale()])
  const { money } = createMoneyFormatter(locale, org.base_currency)
  const m = (v: unknown) => (v === null || v === undefined || v === '' ? '' : money(String(v)))

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
  const tier = (
    classification: 'regular' | 'overtime' | 'double_time' | 'other',
  ): 'reg' | 'ot' | 'dt' | 'other' => {
    if (classification === 'overtime') return 'ot'
    if (classification === 'double_time') return 'dt'
    return classification === 'other' ? 'other' : 'reg'
  }

  interface CrewAgg {
    employee_name: string
    labor_class: string
    hours: Record<'reg' | 'ot' | 'dt' | 'other', number>
    rates: Record<'reg' | 'ot' | 'dt' | 'other', string | null>
    perDay: Record<string, number>
    amount: string
  }
  const crewMap = new Map<string, CrewAgg>()
  for (const e of ticket.entries) {
    const k = `${e.employee_party_id}|${e.item_id ?? ''}`
    let row = crewMap.get(k)
    if (!row) {
      row = {
        employee_name: e.employee_name,
        labor_class: e.item_name ?? '',
        hours: { reg: 0, ot: 0, dt: 0, other: 0 },
        rates: { reg: null, ot: null, dt: null, other: null },
        perDay: {},
        amount: '0',
      }
      crewMap.set(k, row)
    }
    const t = tier(e.time_classification)
    const h = Number(e.hours) || 0
    row.hours[t] += h
    if (e.bill_rate != null) {
      row.rates[t] = row.rates[t] ?? String(e.bill_rate)
      row.amount = add(row.amount, mul(String(e.hours ?? '0'), String(e.bill_rate)))
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
      other_hours: r.hours.other ? r.hours.other.toFixed(1) : '',
      total_hours: (r.hours.reg + r.hours.ot + r.hours.dt + r.hours.other).toFixed(1),
      reg_rate: r.rates.reg != null ? m(r.rates.reg) : '',
      ot_rate: r.rates.ot != null ? m(r.rates.ot) : '',
      dt_rate: r.rates.dt != null ? m(r.rates.dt) : '',
      other_rate: r.rates.other != null ? m(r.rates.other) : '',
      amount: isZero(r.amount) ? '' : m(r.amount),
    }
    for (let i = 1; i <= 7; i++) {
      for (const t of ['reg', 'ot', 'dt', 'other'] as const) {
        const key = `day${i}_${t}`
        rowVals[key] = r.perDay[key] ? String(r.perDay[key]) : ''
      }
    }
    return rowVals
  })

  const party = (await db.execute<{ display_name: string | null; email: string | null; phone: string | null }>(sql`
    select display_name, email, phone from parties
     where org_id = ${orgId} and id = (select party_id from documents where id = ${id} and org_id = ${orgId})
  `))

  const totalHours = ticket.entries.reduce((a, e) => a + (Number(e.hours) || 0), 0)
  const dayLabel = (dayIso: string) => {
    const d = new Date(`${dayIso}T12:00:00Z`)
    return `${d.toLocaleDateString('en-CA', { weekday: 'short', timeZone: 'UTC' })} ${dayIso.slice(5)}`
  }
  const values: Record<string, unknown> = {
    document_number: ticket.documentNumber,
    document_date: fmtDate(ticket.documentDate, locale),
    status: fmtStatus(ticket.status),
    period: fmtStatus(ft.period),
    period_start: fmtDate(ft.periodStart, locale),
    period_end: fmtDate(ft.periodEnd, locale),
    project_name: ticket.projectName,
    po_number: ticket.referenceNumber ?? '',
    foreman_name: ticket.foremanName,
    work_description: ticket.memo ?? '',
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
    customer_signed_at: ft.signatures?.customer?.at ? fmtDate(ft.signatures.customer.at.slice(0, 10), locale) : '',
    customer_comment: ft.signatures?.customer?.comment ?? '',
    foreman_signature_image: ft.signatures?.foreman?.image ?? '',
    org_name: org.name,
    printed_date: fmtDate(await businessToday(orgId), locale),
    crew,
    lines: ticket.lines.map((l) => ({
      item_name: l.item_name ?? '',
      description: l.description ?? '',
      quantity: fmtQty(l.quantity, locale),
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
    const r = (await db.execute<{ id: string }>(sql`
      select id from journal_entries where org_id = ${orgId} order by created_at desc limit 1
    `))
    return r.rows[0]?.id ?? null
  }
  if (meta.key === 'pay_stub') {
    const r = (await db.execute<{ id: string }>(sql`
      select id from pay_stubs where org_id = ${orgId} order by created_at desc limit 1
    `))
    return r.rows[0]?.id ?? null
  }
  if (meta.key === 'payroll_cheque') {
    const r = (await db.execute<{ id: string }>(sql`
      select id from pay_stubs where org_id = ${orgId} and cheque_number is not null
       order by created_at desc limit 1
    `))
    return r.rows[0]?.id ?? null
  }
  const r = (await db.execute<{ id: string }>(sql`
    select id from documents where org_id = ${orgId} and kind = ${meta.docKind}
     order by created_at desc limit 1
  `))
  return r.rows[0]?.id ?? null
}

/** Custom-field merge fields for the builder palette (per record type). */
export async function customMergeFields(recordType: string, orgId: string): Promise<PdfMergeField[]> {
  const meta = PDF_RECORD_TYPE_BY_KEY[recordType]
  if (!meta || !meta.docKind) return []
  const r = (await db.execute<{ key: string; label: string }>(sql`
    select key, label from custom_field_defs
     where org_id = ${orgId} and target_table = 'documents' and is_active
       and (target_kind is null or target_kind = ${meta.docKind})
     order by sort_order, label
  `))
  return r.rows.map((d) => ({ key: `cf_${d.key}`, label: d.label, sample: d.label }))
}
