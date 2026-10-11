import 'server-only'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import {
  buildNecPreparationRows,
  computeFiling,
  formDefinitionForYear,
  InformationReturnError,
  resolveInformationReturnCurrency,
  type FilingComputation,
  type NecPreparationVendor,
} from '@openbooks/engine/src/compliance/information-returns.ts'
import {
  badge,
  column,
  date,
  field,
  link,
  money,
  number,
  ref,
  summaryLine,
  table,
  text,
  textBlock,
  toggleLinks,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { accessDeniedHref } from '../../../../lib/gate-targets'
import { getMoneyFormatter } from '@/lib/money-server'
import { buildHref, isUuid, pickString } from '../../../../lib/list-params'
import { statementReportSpec } from '@/lib/reports/statement-report-spec'
import { decimalSum } from '../../../../lib/statement-format'
import { orgInfo } from '../../../../lib/data'
import { necEmptyCause } from './empty-cause'

/**
 * 1099-NEC preparation: per-vendor reportable amounts by box for a calendar
 * year on the CASH basis (payments actually made, not billed), with the
 * threshold flag, masked TIN status and the exclusions an accountant chases
 * before filing. Reachable on reports.read + ap.read with no feature switch:
 * the compliance workspace owns filing, this report owns preparation.
 *
 * Every figure reuses the filing computation itself (computeFiling): the same
 * posted-payment cash traces, box rules, statutory thresholds and exception
 * vocabulary the filing flow files. Nothing here is a parallel system — a
 * preview the workspace would agree with peso for peso. No filing row is
 * created, and no TIN is ever decrypted: the report shows only the last four.
 */

const ROUTE = '/reports/1099-preparation'

export interface NecVendorRow {
  rowKey: string
  partyId: string
  vendorName: string
  /** Masked TIN (•••1234) or the translated missing-TIN message. */
  tinText: string
  box1: string
  withheld: string
  reportableTotal: string
  thresholdFlag: 'reportable' | 'below' | 'excluded'
  thresholdLabel: string
  thresholdVariant: 'success' | 'secondary' | 'warning'
  paymentCount: string
  vendorHref: string
  /** Formatted card-funded total, excluded by rule. */
  cardPaid: string
  /** Corporate, missing-form, unmapped-account and card notes; blank when clean. */
  exclusionNote: string
}

export interface NecPaymentRow {
  rowKey: string
  paymentId: string
  paymentDate: string
  documentNumber: string
  cash: string
  paymentHref: string
}

export interface NecPreparationData {
  title: string
  backHref: string
  backLabel: string
  searchPlaceholder: string
  company: string
  periodPhrase: string
  cashBasisNotice: string
  yearA: { href: string; label: string; active: boolean }
  yearB: { href: string; label: string; active: boolean }
  yearC: { href: string; label: string; active: boolean }
  columnVendor: string
  columnTin: string
  columnBox1: string
  columnWithheld: string
  columnTotal: string
  columnThreshold: string
  columnPayments: string
  columnNotes: string
  columnCardPaid: string
  hasCardPaid: boolean
  columnDate: string
  columnNumber: string
  columnCash: string
  totalLabel: string
  total: string
  cardTotalLabel: string | null
  cardTotal: string | null
  rows: NecVendorRow[]
  showEmpty: boolean
  emptyTitle: string
  emptyDescription: string
  emptyAction: { href: string; label: string } | null
  paymentsTitle: string | null
  allVendorsLabel: string
  allVendorsHref: string
  paymentRows: NecPaymentRow[]
  refusal: { title: string; description: string } | null
  reportReady: boolean
}

interface CardPaymentRow {
  paymentId: string
  documentNumber: string
  paymentDate: string
  partyId: string
  vendorName: string
  cardPaid: string
}

/**
 * Posted vendor payments settled through a corporate card in the calendar
 * year. Card-funded payments are reported on Form 1099-K, never the payer's
 * 1099-NEC — the cash trace draws the same boundary by counting bank legs
 * only, so this query names what the filing leaves out.
 */
async function loadCardPaidPayments(orgId: string, taxYear: number): Promise<CardPaymentRow[]> {
  const from = `${taxYear}-01-01`
  const to = `${taxYear}-12-31`
  const rows = (await db.execute<CardPaymentRow>(sql`
    select d.id as "paymentId", d.document_number as "documentNumber",
           d.document_date as "paymentDate", d.party_id as "partyId",
           p.display_name as "vendorName",
           coalesce(-sum(jl.amount) filter (
             where jl.amount < 0 and not jl.is_open_item and funding.type = 'liability_card'
           ), 0) as "cardPaid"
      from documents d
      join journal_entries je on je.id = d.posted_entry_id and je.org_id = d.org_id and je.status = 'posted'
      join journal_lines jl on jl.entry_id = je.id and jl.org_id = je.org_id
      join accounts funding on funding.id = jl.account_id and funding.org_id = jl.org_id
      join parties p on p.id = d.party_id and p.org_id = d.org_id
     where d.org_id = ${orgId} and d.kind = 'vendor_payment' and d.status = 'posted'
       and d.document_date between ${from} and ${to}
       and d.party_id is not null
     group by d.id, d.document_number, d.document_date, d.party_id, p.display_name
    having coalesce(-sum(jl.amount) filter (
       where jl.amount < 0 and not jl.is_open_item and funding.type = 'liability_card'
     ), 0) > 0
     order by d.document_date, d.document_number
  `)).rows
  return rows
}

/**
 * Vendor payments in the calendar year that never posted. Drafts and
 * approvals hold cash the cash-basis trace cannot see, so an empty
 * worksheet names them instead of restating that nothing traced.
 */
async function loadUnpostedPaymentTotal(orgId: string, taxYear: number): Promise<{ count: number; total: string } | null> {
  const rows = (await db.execute<{ count: number; total: string }>(sql`
    select count(*)::int as count, coalesce(sum(total), 0)::text as total
      from documents
     where org_id = ${orgId} and kind = 'vendor_payment'
       and status in ('draft', 'approved')
       and document_date between ${`${taxYear}-01-01`} and ${`${taxYear}-12-31`}
  `)).rows
  const [row] = rows
  if (!row || row.count === 0) return null
  return { count: row.count, total: row.total }
}

export async function loadNecPreparation(
  sp: Record<string, string | string[] | undefined>,
): Promise<NecPreparationData> {
  const authz = await requirePermission('reports.read')
  await requirePermission('ap.read')
  // Preparation has no subsidiary dimension: like Tax Filings, it refuses an
  // entity-restricted caller by name instead of mixing payer entities.
  if (authz.allowedSubsidiaryIds !== null) {
    redirect(accessDeniedHref({ permission: 'unrestricted subsidiary access' }))
  }
  const { orgId } = authz.user
  const { money: formatMoney } = await getMoneyFormatter()
  const t = await getTranslations('reports.necPreparation')
  const tr = await getTranslations('reports')
  const tc = await getTranslations('compliance')
  const today = await businessToday(orgId)
  const currentYear = Number(today.slice(0, 4))
  const lastYear = currentYear - 1
  const yearParam = pickString(sp.year)
  const year = yearParam && /^\d{4}$/.test(yearParam) ? Number(yearParam) : lastYear
  const vendorParam = pickString(sp.vendor)
  const selectedVendor = vendorParam && isUuid(vendorParam) ? vendorParam : null

  let computation: FilingComputation | null = null
  let refusal: NecPreparationData['refusal'] = null
  try {
    const currency = await resolveInformationReturnCurrency({ orgId })
    computation = await computeFiling({ orgId, taxYear: year, formType: '1099-NEC', currency })
  } catch (error) {
    // A mixed-currency org cannot sum one filing: name the refusal with its
    // remedy (one preparation per subsidiary) instead of a generic error.
    if (!(error instanceof InformationReturnError)) throw error
    refusal = { title: t('refusalTitle'), description: error.message }
  }

  const cardPayments = refusal ? [] : await loadCardPaidPayments(orgId, year)
  const cardPaidByParty = new Map<string, string>()
  for (const payment of cardPayments) {
    cardPaidByParty.set(payment.partyId, decimalSum([cardPaidByParty.get(payment.partyId) ?? '0', payment.cardPaid]))
  }
  const rawRows: NecPreparationVendor[] = computation
    ? buildNecPreparationRows(computation, cardPaidByParty)
    : []
  const form = formDefinitionForYear('1099-NEC', year)
  const box1 = form.boxes.find((box) => box.key === 'nec1')
  const box4 = form.boxes.find((box) => box.key === 'nec4')
  const m = (value: string) => formatMoney(value, { currency: computation?.currency ?? 'USD' })

  const query = pickString(sp.q)?.toLowerCase()
  const visibleRows = query
    ? rawRows.filter((row) => row.vendorName.toLowerCase().includes(query))
    : rawRows
  const rows: NecVendorRow[] = visibleRows.map((row) => {
    const flag = row.belowThreshold ? 'below' as const : 'reportable' as const
    const cardNote = Number(row.cardPaid) > 0 ? t('cardExcluded', { amount: m(row.cardPaid) }) : null
    const notes = [...row.exclusionDetails, ...(cardNote ? [cardNote] : [])]
    return {
      rowKey: row.partyId,
      partyId: row.partyId,
      vendorName: row.vendorName,
      tinText: row.tinLast4 ? `•••${row.tinLast4}` : tc('readiness.missingTin'),
      box1: m(row.box1),
      withheld: m(row.withheld),
      reportableTotal: m(row.reportableTotal),
      thresholdFlag: flag,
      thresholdLabel: flag === 'below' ? t('thresholdBelow') : t('thresholdReportable'),
      thresholdVariant: flag === 'below' ? 'secondary' : 'success',
      paymentCount: String(row.paymentCount),
      vendorHref: buildHref(ROUTE, { year: String(year), vendor: row.partyId, q: pickString(sp.q) }),
      cardPaid: m(row.cardPaid),
      exclusionNote: notes.length > 0 ? notes.join('; ') : '',
    }
  })

  const selected = selectedVendor ? rawRows.find((row) => row.partyId === selectedVendor) : undefined
  const traces = selected && computation
    ? computation.recipients.find((recipient) => recipient.profile.partyId === selected.partyId)?.paymentTraces ?? []
    : []
  const paymentRows: NecPaymentRow[] = traces.map((trace) => ({
    rowKey: trace.paymentId,
    paymentId: trace.paymentId,
    paymentDate: trace.paymentDate,
    documentNumber: trace.documentNumber,
    cash: m(trace.cash),
    paymentHref: `/payments?payment=${trace.paymentId}`,
  }))

  const cardTotal = decimalSum([...cardPaidByParty.values(), '0'])
  const hasCardPaid = Number(cardTotal) > 0
  // An empty worksheet names what blocks tracing instead of restating that
  // nothing traced: paid vendors missing reportability details link to the
  // vendor record, and unposted payments link to the payments list.
  let emptyCause: { description: string; action: { href: string; label: string } } | null = null
  if (!refusal && rows.length === 0) {
    const cause = necEmptyCause({
      exceptions: computation?.exceptions ?? [],
      unposted: await loadUnpostedPaymentTotal(orgId, year),
    })
    if (cause?.kind === 'vendors') {
      const [first] = cause.vendors
      emptyCause = {
        description: t('emptyVendorsDescription', {
          vendors: cause.vendors.map((vendor) => `${vendor.name} (${m(vendor.total)})`).join('; '),
          year: String(year),
        }),
        action: { href: `/compliance/vendors?vendor=${first!.partyId}`, label: t('emptyVendorAction') },
      }
    } else if (cause?.kind === 'unposted') {
      emptyCause = {
        description: t('emptyUnpostedDescription', {
          count: cause.count,
          total: m(cause.total),
          year: String(year),
        }),
        action: { href: '/payments', label: t('emptyPaymentsAction') },
      }
    }
  }
  const org = await orgInfo()
  const yearToggle = (option: number) => ({
    href: buildHref(ROUTE, { year: String(option) }),
    label: String(option),
    active: option === year,
  })

  return {
    title: tr('hub.cards.necPreparationTitle'),
    backHref: '/reports',
    backLabel: tr('hub.title'),
    searchPlaceholder: t('searchPlaceholder'),
    company: org?.name ?? '',
    periodPhrase: String(year),
    cashBasisNotice: t('cashBasisNotice', { year: String(year) }),
    yearA: yearToggle(lastYear - 1),
    yearB: yearToggle(lastYear),
    yearC: yearToggle(currentYear),
    columnVendor: tc('informationReturns.columns.vendor'),
    columnTin: tc('informationReturns.columns.tin'),
    columnBox1: box1 ? `Box ${box1.number} · ${box1.name}` : 'Box 1',
    columnWithheld: box4 ? `Box ${box4.number} · ${box4.name}` : 'Box 4',
    columnTotal: tc('informationReturns.columns.total'),
    columnThreshold: t('columnThreshold'),
    columnPayments: t('columnPayments'),
    columnNotes: t('columnNotes'),
    columnCardPaid: t('columnCardPaid'),
    hasCardPaid,
    columnDate: t('columnDate'),
    columnNumber: t('columnNumber'),
    columnCash: t('columnCash'),
    totalLabel: t('totalLabel'),
    total: m(decimalSum([...visibleRows.map((row) => row.reportableTotal), '0'])),
    cardTotalLabel: hasCardPaid ? t('cardTotalLabel') : null,
    cardTotal: hasCardPaid ? m(cardTotal) : null,
    rows,
    showEmpty: !refusal && rows.length === 0,
    emptyTitle: t('emptyTitle'),
    emptyDescription: emptyCause?.description ?? t('emptyDescription', { year: String(year) }),
    emptyAction: emptyCause?.action ?? null,
    paymentsTitle: selected ? t('paymentsTitle', { vendor: selected.vendorName }) : null,
    allVendorsLabel: t('allVendors'),
    allVendorsHref: buildHref(ROUTE, { year: String(year) }),
    paymentRows,
    refusal,
    reportReady: !refusal,
  }
}

const f = ref<NecPreparationData>()
const row = field
const payment = field

export function necPreparationSpec(data: NecPreparationData): PageSpec {
  return statementReportSpec({
    route: ROUTE,
    header: { title: f('title'), back: { href: f('backHref'), label: f('backLabel') } },
    filters: [{
      controls: { search: true, period: false, subsidiary: false },
      options: {
        searchPlaceholder: f('searchPlaceholder'),
        leading: toggleLinks([
          { href: f('yearA.href'), label: f('yearA.label'), activeWhen: f('yearA.active') },
          { href: f('yearB.href'), label: f('yearB.label'), activeWhen: f('yearB.active') },
          { href: f('yearC.href'), label: f('yearC.label'), activeWhen: f('yearC.active') },
        ]),
      },
    }],
    headerAfterFilters: [
      summaryLine(f('totalLabel'), money(f('total'))),
      ...(data.cardTotalLabel ? [summaryLine(f('cardTotalLabel'), money(f('cardTotal')))] : []),
    ],
    actionsBefore: data.paymentsTitle
      ? [widget('plain-link-button', { href: data.allVendorsHref, label: data.allVendorsLabel })]
      : [],
    bodyBeforePaper: [
      textBlock(f('cashBasisNotice'), { tone: 'muted' }),
      ...(data.refusal
        ? [{
            ...widgetBlock('empty-state', {
              title: data.refusal?.title ?? '',
              description: data.refusal?.description,
            }),
            when: f('refusal'),
          }]
        : []),
    ],
    paper: {
      company: f('company'),
      title: f('title'),
      periodPhrase: f('periodPhrase'),
      when: f('reportReady'),
    },
    blocks: [
      ...(data.refusal
        ? []
        : [
            ...(data.showEmpty
              ? [widgetBlock('empty-state', {
                  title: f('emptyTitle'),
                  description: f('emptyDescription'),
                  action: data.emptyAction ? 'link-button' : null,
                  actionProps: data.emptyAction ?? undefined,
                })]
              : [table({
                  variant: 'report',
                  rows: f('rows'),
                  rowKey: row('rowKey'),
                  columns: [
                    column(f('columnVendor'), text(row('vendorName'))),
                    column(f('columnTin'), text(row('tinText'))),
                    column(f('columnBox1'), money(row('box1')), { align: 'right' }),
                    column(f('columnWithheld'), money(row('withheld')), { align: 'right' }),
                    column(f('columnTotal'), money(row('reportableTotal')), { align: 'right' }),
                    column(f('columnThreshold'), badge(row('thresholdLabel'), { variant: row('thresholdVariant') })),
                    column(f('columnPayments'), link(number(row('paymentCount')), row('vendorHref')), { align: 'right' }),
                    ...(data.hasCardPaid
                      ? [column(f('columnCardPaid'), money(row('cardPaid')), { align: 'right' })]
                      : []),
                    column(f('columnNotes'), text(row('exclusionNote'))),
                  ],
                })]),
            ...(data.paymentsTitle
              ? [table({
                  variant: 'report',
                  rows: f('paymentRows'),
                  rowKey: payment('rowKey'),
                  columns: [
                    column(f('columnDate'), date(payment('paymentDate'))),
                    column(f('columnNumber'), link(text(payment('documentNumber')), payment('paymentHref'))),
                    column(f('columnCash'), money(payment('cash')), { align: 'right' }),
                  ],
                })]
              : []),
          ]),
    ],
  })
}
