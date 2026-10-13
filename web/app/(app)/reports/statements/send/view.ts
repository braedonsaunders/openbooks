import 'server-only'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/db'
import { businessToday } from '@openbooks/engine/platform/business-date/module'
import {
  column,
  field,
  heading,
  link,
  money,
  ref,
  table,
  text,
  toggleLinks,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { assertCan, can, requirePermission } from '../../../../../lib/authz'
import { getMoneyFormatter } from '@/lib/money-server'
import { type CurrencyBasisNotice } from '../../../../../lib/consolidation'
import { statementReportSpec } from '@/lib/reports/statement-report-spec'
import { ReportCurrencyBasisError } from '../../../../../lib/reports/currency-basis'
import { orgInfo } from '../../../../../lib/data'
import { buildStatementBatchPreview } from '../../../../../lib/statement-batch'
import { decimalCmp } from '../../../../../lib/statement-format'

/**
 * The batch composer: the same customers-with-balances preview a run would
 * send to, with the statement mailbox resolved per customer and the
 * no-email exclusions listed beside a link that fixes them. Sending posts
 * the same filters to the batch endpoint and lands on the batch's run.
 */

export interface StatementBatchComposerRow {
  rowKey: string
  displayName: string
  statementHref: string
  balance: string
  balanceTone: 'default' | 'negative'
  overdue: string
  email: string
}

export interface StatementBatchExclusionRow {
  rowKey: string
  displayName: string
  balance: string
  fixHref: string
  fixLabel: string
}

export interface StatementBatchComposerData {
  title: string
  backHref: string
  backLabel: string
  company: string
  periodPhrase: string
  dateRange: { from: string; to: string }
  columnCustomer: string
  columnBalance: string
  columnOverdue: string
  columnEmail: string
  columnFix: string
  rows: StatementBatchComposerRow[]
  exclusions: StatementBatchExclusionRow[]
  summary: string
  hasRows: boolean
  hasExclusions: boolean
  subsidiaries: { id: string; label: string }[]
  primaryFilter: { paramKey: string; label: string; value: string; options: { value: string; label: string }[] } | null
  overdueAllHref: string
  overdueOnlyHref: string
  overdueActive: boolean
  overdueAllActive: boolean
  overdueAllLabel: string
  overdueOnlyLabel: string
  emptyTitle: string
  emptyHint: string
  exclusionsTitle: string
  send: {
    canCreate: boolean
    notAllowed: string
    buttonLabel: string
    sendingLabel: string
    recipientCount: number
    viewBatchesHref: string
    viewBatchesLabel: string
    body: { from: string | null; toDate: string; overdueOnly: boolean; subsidiaryId: string | null; currency: string | null }
  }
  currencyBasisBlocked: CurrencyBasisNotice | null
  currencyBasisReady: boolean
}

function pickString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export async function loadStatementBatchComposer(
  sp: Record<string, string | string[] | undefined>,
): Promise<StatementBatchComposerData> {
  const authz = await requirePermission('reports.read')
  assertCan(authz, 'ar.read')
  const { money: formatMoney } = await getMoneyFormatter()
  const tp = await getTranslations('reports.statementBatch')
  const tr = await getTranslations('reports')

  const from = pickString(sp.from) ?? null
  const to = pickString(sp.to) ?? null
  const overdueOnly = pickString(sp.overdueOnly) === '1'
  const subsidiaryId = pickString(sp.sub) ?? null
  const currency = pickString(sp.currency)?.toUpperCase() || null
  const asOf = to ?? (await businessToday(authz.user.orgId))
  const orgPromise = orgInfo()

  let preview: Awaited<ReturnType<typeof buildStatementBatchPreview>> = {
    from, to: asOf, recipients: [], excluded: [], subsidiaries: [], currency: undefined,
  }
  let currencyBasisBlocked: CurrencyBasisNotice | null = null
  try {
    preview = await buildStatementBatchPreview(authz.user.orgId, authz.allowedSubsidiaryIds, can(authz, 'payroll.read'), {
      from, to, overdueOnly, subsidiaryId, currency,
    })
  } catch (e) {
    if (!(e instanceof ReportCurrencyBasisError)) throw e
    currencyBasisBlocked = {
      code: 'multi-currency-basis',
      title: tr('statement.currencyBasisBlockedTitle'),
      description: e.message,
    }
  }
  const org = await orgPromise
  const m = (value: string) => formatMoney(value, { currency: preview.currency ?? org?.base_currency })

  const statementParams = new URLSearchParams()
  if (preview.from && preview.to) {
    statementParams.set('period', 'custom')
    statementParams.set('from', preview.from)
    statementParams.set('to', preview.to)
  }
  const statementQuery = statementParams.toString()
  const keepParams = new URLSearchParams()
  if (preview.from) keepParams.set('from', preview.from)
  if (pickString(sp.to)) keepParams.set('to', preview.to)
  if (subsidiaryId) keepParams.set('sub', subsidiaryId)
  if (currency) keepParams.set('currency', currency)
  const kept = keepParams.toString()
  const withOverdue = (value: boolean) => {
    const params = new URLSearchParams(kept)
    if (value) params.set('overdueOnly', '1')
    else params.delete('overdueOnly')
    const query = params.toString()
    return query ? `/reports/statements/send?${query}` : '/reports/statements/send'
  }

  const currencyRows = (await db.execute<{ currency: string }>(sql`
    select distinct cr.currency from customer_roles cr
     where cr.org_id = ${authz.user.orgId} and cr.currency is not null
     order by cr.currency`)).rows


  return {
    title: tp('title'),
    backHref: '/reports/statements',
    backLabel: tr('statementsPicker.title'),
    company: org?.name ?? '',
    periodPhrase: preview.from ? tp('periodRange', { from: preview.from, to: preview.to }) : tp('periodDefault'),
    dateRange: { from: preview.from ?? '', to: pickString(sp.to) ?? '' },
    columnCustomer: tp('columnCustomer'),
    columnBalance: tp('columnBalance'),
    columnOverdue: tp('columnOverdue'),
    columnEmail: tp('columnEmail'),
    columnFix: tp('exclusionFix'),
    rows: preview.recipients.map((row) => ({
      rowKey: row.partyId,
      displayName: row.displayName,
      statementHref: statementQuery ? `/reports/statements/${row.partyId}?${statementQuery}` : `/reports/statements/${row.partyId}`,
      balance: m(row.balance),
      balanceTone: decimalCmp(row.balance, '0') < 0 ? 'negative' : 'default',
      overdue: m(row.overdue),
      email: row.toEmail,
    })),
    exclusions: preview.excluded.map((row) => ({
      rowKey: row.partyId,
      displayName: row.displayName,
      balance: m(row.balance),
      fixHref: row.fixHref,
      fixLabel: tp('exclusionFix'),
    })),
    summary: tp('summaryReady', { count: preview.recipients.length, skipped: preview.excluded.length }),
    hasRows: preview.recipients.length > 0,
    hasExclusions: preview.excluded.length > 0,
    subsidiaries: preview.subsidiaries,
    primaryFilter: currencyRows.length > 0
      ? {
          paramKey: 'currency',
          label: tp('currencyLabel'),
          value: currency ?? '',
          options: [{ value: '', label: tp('currencyAll') }, ...currencyRows.map((row) => ({ value: row.currency, label: row.currency }))],
        }
      : null,
    overdueAllHref: withOverdue(false),
    overdueOnlyHref: withOverdue(true),
    overdueActive: overdueOnly,
    overdueAllActive: !overdueOnly,
    overdueAllLabel: tp('overdueAll'),
    overdueOnlyLabel: tp('overdueOnly'),
    emptyTitle: tp('emptyTitle'),
    emptyHint: tp('emptyHint'),
    exclusionsTitle: tp('exclusionsTitle'),
    send: {
      canCreate: can(authz, 'ar.create'),
      notAllowed: tp('notAllowed'),
      buttonLabel: tp('sendButton'),
      sendingLabel: tp('sending'),
      recipientCount: preview.recipients.length,
      viewBatchesHref: '/reports/statements/sends',
      viewBatchesLabel: tp('viewBatches'),
      body: {
        from: preview.from,
        toDate: preview.to,
        overdueOnly,
        subsidiaryId,
        currency,
      },
    },
    currencyBasisBlocked,
    currencyBasisReady: currencyBasisBlocked === null,
  }
}

const f = ref<StatementBatchComposerData>()
const row = field

export function statementBatchComposerSpec(data: StatementBatchComposerData): PageSpec {
  return statementReportSpec({
    route: '/reports/statements/send',
    header: { title: f('title'), back: { href: f('backHref'), label: f('backLabel') } },
    filters: [{
      controls: { dateRange: true, subsidiary: true },
      options: {
        dateRange: f('dateRange'),
        subsidiaries: f('subsidiaries'),
        primaryFilter: f('primaryFilter'),
        leading: {
          ...toggleLinks([
            { href: f('overdueAllHref'), label: f('overdueAllLabel'), activeWhen: f('overdueAllActive') },
            { href: f('overdueOnlyHref'), label: f('overdueOnlyLabel'), activeWhen: f('overdueActive') },
          ]),
          divider: true,
        },
      },
    }],
    actionsBefore: [
      widget('statement-batch-send', {
        recipientCount: data.send.recipientCount,
        canCreate: data.send.canCreate,
        notAllowed: data.send.notAllowed,
        buttonLabel: data.send.buttonLabel,
        sendingLabel: data.send.sendingLabel,
        body: data.send.body,
      }),
      widget('link-button', { href: data.send.viewBatchesHref, label: data.send.viewBatchesLabel, variant: 'outline' }),
    ],
    saveView: false,
    paper: {
      company: f('company'),
      title: f('title'),
      periodPhrase: f('periodPhrase'),
      when: f('currencyBasisReady'),
    },
    bodyBeforePaper: [
      ...(data.currencyBasisBlocked
        ? [{
            ...widgetBlock('empty-state', {
              title: data.currencyBasisBlocked?.title ?? '',
              description: data.currencyBasisBlocked?.description,
            }),
            when: f('currencyBasisBlocked'),
          }]
        : []),
      ...(!data.hasRows && !data.currencyBasisBlocked
        ? [{
            ...widgetBlock('empty-state', {
              title: data.emptyTitle ?? '',
              description: data.emptyHint,
            }),
            when: f('currencyBasisReady'),
          }]
        : []),
    ],
    blocks: [
      table({
        variant: 'report',
        rows: f('rows'),
        rowKey: row('rowKey'),
        columns: [
          column(f('columnCustomer'), link(row('displayName'), row('statementHref'))),
          column(f('columnBalance'), money(row('balance'), { tone: row('balanceTone') }), { align: 'right' }),
          column(f('columnOverdue'), money(row('overdue')), { align: 'right' }),
          column(f('columnEmail'), text(row('email'))),
        ],
      }),
      ...(data.hasExclusions
        ? [
            heading(3, f('exclusionsTitle')),
            table({
              variant: 'report',
              rows: f('exclusions'),
              rowKey: row('rowKey'),
              columns: [
                column(f('columnCustomer'), text(row('displayName'))),
                column(f('columnBalance'), money(row('balance')), { align: 'right' }),
                column(f('columnFix'), link(row('fixLabel'), row('fixHref'))),
              ],
            }),
          ]
        : []),
    ],
  })
}
