import 'server-only'
import { reportBookSelection } from '../../../../lib/report-books'
import { resolveOrgId } from '../../../../lib/org-scope'


import { getTranslations } from 'next-intl/server'
import { fiscalYearStartOn, priorFiscalYearEndOn } from '@openbooks/reports'
import { dimensionOptions, trialBalance } from '../../../../lib/reports'
import { PNL_TYPES } from '../../../../lib/account-types'
import { COMPUTED_RETAINED_EARNINGS_PRIOR_ID } from '../../../../lib/computed-earnings'
import { orgInfo } from '../../../../lib/data'
import { fiscalStartMonth } from '../../../../lib/fiscal'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { MissingRatesError, reportSubsidiaryView, type RatesBlockedNotice } from '../../../../lib/consolidation'
import {
  baseCurrencyNotice,
  hasBaseCurrency,
  type BaseCurrencyNotice,
} from '../../../../lib/reports/base-currency'
import { orgBranding } from '../../../../lib/report-pdf'
import { decimalAdd, decimalNeg, decimalSum } from '../../../../lib/statement-format'
import { reportScheduleAnchor, scheduleParamsFrom } from '../../../../lib/report-schedule-anchor'
import type { ReportDrillTarget } from '../../../../lib/report-drill'
import type { PaperCell } from '../PaperView'
import { mergeHref } from '../../../../lib/list-params'
import { filterBar, page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'

/**
 * The trial balance, split into a loader and a spec.
 *
 * Its body is one `PaperView` — a whole component that owns the paper chrome,
 * the column alignment and the money formatting for a generic tabular report.
 * The spec places it and binds the data the loader already assembled; the
 * header and filter bar are ordinary blocks.
 */

export interface TrialBalanceData {
  primaryFilter: { paramKey: string; label: string; value: string; options: { value: string; label: string }[] } | null
  title: string
  backHref: string
  backLabel: string
  dimensions: unknown
  subsidiaries: unknown
  scheduleDefId: string | null
  scheduleParams: Record<string, string | undefined>
  exportParams: Record<string, string | undefined>
  company: string
  currency: string | undefined
  emptyLabel: string
  /** Set when underived consolidated rates block the statement (F-t06-025):
   * the page renders a typed banner with a derive link instead of numbers. */
  ratesBlocked: RatesBlockedNotice | null
  /**
   * False when rates are blocked or the base currency is missing; the
   * paper hides with either. Set alongside the notice below.
   */
  ratesReady: boolean
  baseCurrencyNotice: BaseCurrencyNotice | null
  baseCurrencyReady: boolean
  paper: unknown
}

export async function loadTrialBalance(
  sp: Record<string, string | undefined>,
): Promise<TrialBalanceData> {
  const t = await getTranslations('reports')
  const scheduleDefId = await reportScheduleAnchor('trial-balance')
  const tb = await getTranslations('budgets')
  const { books, selectedBook } = await reportBookSelection(await resolveOrgId(), sp.book)
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })
  const date = period.to
  // The base currency gates every money figure below: refuse before the
  // subsidiary and rates queries run, never after them, and never by
  // throwing — the boundary swallows thrown messages.
  const org = await orgInfo()
  if (!org || !hasBaseCurrency(org.base_currency)) {
    return {
      title: t('trialBalance.title'),
      backHref: '/reports',
      backLabel: t('hub.title'),
      dimensions: null,
      subsidiaries: [],
      ratesBlocked: null,
      ratesReady: false,
      baseCurrencyNotice: baseCurrencyNotice({
        title: t('baseCurrency.title'),
        description: t('baseCurrency.description'),
        actionLabel: t('baseCurrency.action'),
      }),
      baseCurrencyReady: false,
      primaryFilter: null,
      scheduleDefId,
      scheduleParams: scheduleParamsFrom(sp),
      exportParams: sp,
      company: '',
      currency: undefined,
      emptyLabel: t('generalLedger.empty'),
      paper: null,
    }
  }
  let subView: Awaited<ReturnType<typeof reportSubsidiaryView>> | undefined
  let rows: Awaited<ReturnType<typeof trialBalance>> = []
  let ratesBlocked: RatesBlockedNotice | null = null
  try {
    subView = await reportSubsidiaryView(q.subsidiaryId, date)
    rows = await trialBalance(date, { ...q.dims, subsidiaryIds: subView.subsidiary?.ids }, undefined, selectedBook.id)
  } catch (e) {
    // Underived consolidated rates must not throw out of SSR (F-t06-025):
    // the page renders a typed banner with a derive link instead of any
    // numbers. Anything else is a real defect and still throws.
    if (!(e instanceof MissingRatesError)) throw e
    ratesBlocked = {
      code: 'rates-not-derived',
      title: t('statement.ratesBlockedTitle'),
      description: (e as Error).message,
      deriveLabel: t('statement.ratesBlockedAction'),
      deriveHref: '/close',
    }
  }
  const dims = { ...q.dims, subsidiaryIds: subView?.subsidiary?.ids }
  const [opts, branding, startMonth] = await Promise.all([
    dimensionOptions(undefined, undefined, dims.subsidiaryIds), orgBranding(), fiscalStartMonth(),
  ])
  const fyStart = fiscalYearStartOn(date, startMonth)
  const priorEnd = priorFiscalYearEndOn(date, startMonth)
  const displayRows = rows.map((r) => (
    r.id === COMPUTED_RETAINED_EARNINGS_PRIOR_ID
      ? { ...r, name: t('statement.retainedEarningsPrior') }
      : r
  ))
  const totalDebits = decimalSum(displayRows.map((r) => r.debits))
  const totalCredits = decimalSum(displayRows.map((r) => r.credits))

  // The unified report shape: every value drills to the account register as of
  // the report date (five-cell rows share one href). P&L registers start at
  // the fiscal year; the prior-year RE placeholder has no register.
  const dataRows: PaperCell[][] = displayRows.map((r) => [r.number, r.name, r.debits, r.credits, r.balance])
  const links = displayRows.map((r) => {
    if (r.id === COMPUTED_RETAINED_EARNINGS_PRIOR_ID) return [null, null, null, null, null]
    const registerHref = mergeHref('/reports/trial-balance', sp, {
      accountRegister: r.id,
      accountRegisterPage: undefined,
      accountRegisterFrom: PNL_TYPES.includes(r.type) ? fyStart : undefined,
      accountRegisterTo: date,
    })
    return [registerHref, registerHref, null, null, null]
  })
  const drills: (ReportDrillTarget | null)[][] = displayRows.map((r) => {
    const prior = r.id === COMPUTED_RETAINED_EARNINGS_PRIOR_ID
    const pnl = PNL_TYPES.includes(r.type)
    const target: ReportDrillTarget = {
      kind: 'ledger', bookId: selectedBook.id,
      label: `${r.number ?? ''} ${r.name}`.trim(),
      accountIds: prior ? undefined : [r.id],
      accountTypes: prior ? [...PNL_TYPES] : undefined,
      profitSigned: prior ? true : undefined,
      from: prior ? undefined : pnl ? fyStart : undefined,
      to: prior ? priorEnd : date,
      mode: prior || !pnl ? 'balance' : 'flow',
      dims,
      subsidiaryId: q.subsidiaryId,
    }
    return [null, null, target, target, target]
  })
  dataRows.push(['', t('trialBalance.totals'), totalDebits, totalCredits, decimalAdd(totalDebits, decimalNeg(totalCredits))])
  links.push([null, null, null, null, null])
  const totalsTarget: ReportDrillTarget = { kind: 'ledger', bookId: selectedBook.id, label: t('trialBalance.totals'), to: date, mode: 'balance', dims, subsidiaryId: q.subsidiaryId }
  drills.push([null, null, totalsTarget, totalsTarget, totalsTarget])


  return {
    title: t('trialBalance.title'),
    backHref: '/reports',
    backLabel: t('hub.title'),
    dimensions: opts,
    subsidiaries: subView?.picker ?? [],
    ratesBlocked,
    ratesReady: ratesBlocked === null,
    baseCurrencyNotice: null,
    baseCurrencyReady: true,
    primaryFilter: books.length > 1 ? { paramKey: 'book', label: tb('list.bookFilter'), value: selectedBook.id, options: books.map((book) => ({ value: book.id, label: book.name })) } : null,
    scheduleDefId,
    scheduleParams: scheduleParamsFrom(sp),
    exportParams: sp,
    company: branding.orgName,
    currency: org.base_currency,
    emptyLabel: t('generalLedger.empty'),
    paper: {
      title: t('trialBalance.title'),
      periodPhrase: `${selectedBook.name} · ${t('trialBalance.description', { date, count: rows.length })}`,
      groups: [
        {
          columns: [
            t('export.columns.accountNumber'),
            t('export.columns.accountName'),
            t('trialBalance.columns.debits'),
            t('trialBalance.columns.credits'),
            t('export.columns.balance'),
          ],
          align: ['left', 'left', 'right', 'right', 'right'],
          money: [false, false, true, true, true],
          rows: dataRows,
          links,
          drills,
          totalRowIndex: dataRows.length - 1,
        },
      ],
    },
  }
}

const f = ref<TrialBalanceData>()

export function trialBalanceSpec(data: TrialBalanceData): PageSpec {
  return page({
    route: '/reports/trial-balance',
    layout: 'list',
    header: [
      pageHeader({ title: f('title'), back: { href: f('backHref'), label: f('backLabel') } }),
      filterBar(
        { period: true, asOf: true, dimensions: true, subsidiary: true },
        {
          dimensions: f('dimensions'),
          subsidiaries: f('subsidiaries'),
          primaryFilter: f('primaryFilter'),
          actions: [
            widget(
              'schedule-report',
              { definitionId: data.scheduleDefId ?? '', statementParams: data.scheduleParams },
              f('scheduleDefId'),
            ),
            widget('save-view'),
            widget('export-menu', { kind: 'trial-balance', params: data.exportParams }),
          ],
        },
      ),
    ],
    body: [
      // The named refusal renders instead of numbers when the org has no
      // base currency: title, description and the Company settings link.
      // Included only while refused so the rates-blocked banner stays the
      // first empty-state in healthy specs; still gated on the notice.
      ...(data.baseCurrencyNotice
        ? [
            {
              ...widgetBlock('empty-state', {
                title: data.baseCurrencyNotice?.title ?? '',
                description: data.baseCurrencyNotice?.description,
                action: 'link-button',
                actionProps: {
                  href: data.baseCurrencyNotice?.actionHref ?? '/admin/setup/company',
                  label: data.baseCurrencyNotice?.actionLabel ?? '',
                },
              }),
              when: f('baseCurrencyNotice'),
            },
          ]
        : []),
      {
        ...widgetBlock('empty-state', {
          title: data.ratesBlocked?.title ?? '',
          description: data.ratesBlocked?.description,
          action: 'link-button',
          actionProps: {
            href: data.ratesBlocked?.deriveHref ?? '/close',
            label: data.ratesBlocked?.deriveLabel ?? '',
          },
        }),
        when: f('ratesBlocked'),
      },
      {
        ...widgetBlock('paper-view', {
          company: data.company,
          currency: data.currency,
          emptyLabel: data.emptyLabel,
          data: data.paper,
        }),
        when: f('ratesReady'),
      },
    ],
  })
}
