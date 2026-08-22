import { NextResponse } from 'next/server'
import { getTranslations } from 'next-intl/server'
import { resolvePdfPageSetup } from '@openbooks/pdf'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { accountRegister } from '../../../../../lib/reports'
import {
  accountRegisterDocTypeLabel,
  accountRegisterExportData,
  type AccountRegisterExportLine,
  type AccountRegisterExportFormat,
} from '../../../../../lib/account-register-export'
import {
  exportDataToCsv,
  exportDataToPdf,
  exportDataToXlsx,
  orgBranding,
  type Translator,
} from '../../../../../lib/report-pdf'
import { reportCsvOptions } from '../../../../../lib/report-labels'
import { csvResponse, pdfResponse, safeName, xlsxResponse } from '../../../../../lib/export'
import { decimalCmp, decimalSum } from '../../../../../lib/statement-format'
import { businessToday } from '@openbooks/engine/src/business-date.ts'

export const runtime = 'nodejs'

const DATE = /^\d{4}-\d{2}-\d{2}$/
const PER_PAGE = 100
const MAX_EXPORT_LINES = 200_000
const EXPORT_FORMATS = new Set<AccountRegisterExportFormat>(['pdf', 'xlsx', 'csv'])

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('gl.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const query = new URL(request.url).searchParams
  const page = Math.max(1, Math.min(100_000, Number(query.get('page')) || 1))
  const from = query.get('from')
  const to = query.get('to')
  const rawSearch = query.get('q')?.trim()
  if (rawSearch && rawSearch.length > 200) {
    return NextResponse.json({ error: 'search_too_long' }, { status: 400 })
  }
  const search = rawSearch || undefined
  if ((from && !DATE.test(from)) || (to && !DATE.test(to))) {
    return NextResponse.json({ error: 'invalid_period' }, { status: 400 })
  }

  const requestedFormat = query.get('format')
  if (requestedFormat) {
    if (!EXPORT_FORMATS.has(requestedFormat as AccountRegisterExportFormat)) {
      return NextResponse.json({ error: 'invalid_format' }, { status: 422 })
    }
    const period = from || to || search
      ? { from: from || undefined, to: to || undefined, search }
      : undefined
    const result = await accountRegister(
      gate.user.orgId,
      id,
      MAX_EXPORT_LINES + 1,
      0,
      period,
      gate.allowedSubsidiaryIds,
    )
    if (!result.account) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    if (result.total > MAX_EXPORT_LINES) {
      return NextResponse.json(
        { error: 'export_too_large', maximumLines: MAX_EXPORT_LINES, actualLines: result.total },
        { status: 422 },
      )
    }
    if (
      result.lines.length !== result.total
      || decimalCmp(
        decimalSum((result.lines as AccountRegisterExportLine[]).map((line) => line.amount)),
        result.balance,
      ) !== 0
    ) {
      return NextResponse.json({ error: 'export_incomplete' }, { status: 409 })
    }

    const [accountsT, commonT] = await Promise.all([
      getTranslations('accounts'),
      getTranslations('common'),
    ])
    const dateRange = from || to
      ? accountsT('register.periodFilter', { label: `${from ?? ''} → ${to ?? ''}` })
      : commonT('labels.all')
    const data = accountRegisterExportData(result, {
      register: accountsT('list.viewRegister'),
      date: commonT('labels.date'),
      type: commonT('labels.type'),
      number: commonT('labels.number'),
      party: commonT('labels.party'),
      memo: commonT('labels.memo'),
      debit: accountsT('register.columns.debit'),
      credit: accountsT('register.columns.credit'),
      balance: commonT('labels.balance'),
      lines: commonT('labels.lines'),
      dateRange,
      docType: (kind) =>
        accountRegisterDocTypeLabel(kind, commonT as unknown as Translator),
    })
    const stamp = await businessToday(gate.user.orgId)
    const filename = safeName(
      `${result.account.number ?? result.account.name}-register-${stamp}`,
    )
    const format = requestedFormat as AccountRegisterExportFormat
    if (format === 'csv') {
      const { sectionHeader } = await reportCsvOptions()
      return csvResponse(exportDataToCsv(data, { sectionHeader }), filename)
    }
    if (format === 'xlsx') {
      return xlsxResponse(
        await exportDataToXlsx(data, {
          reportName: data.title,
          dateRangeLabel: data.dateRangeLabel,
          generatedAt: new Date(`${stamp}T00:00:00Z`),
        }),
        filename,
      )
    }
    const branding = await orgBranding(gate.user.orgId)
    const page = resolvePdfPageSetup({
      paperSize: 'letter',
      orientation: 'landscape',
      marginMm: 12,
      density: 'compact',
    })
    return pdfResponse(await exportDataToPdf(data, branding, page, {
      generatedAt: new Date(`${stamp}T00:00:00Z`),
    }), filename)
  }

  const result = await accountRegister(
    gate.user.orgId,
    id,
    PER_PAGE,
    (page - 1) * PER_PAGE,
    from || to || search ? { from: from || undefined, to: to || undefined, search } : undefined,
    gate.allowedSubsidiaryIds,
  )
  if (!result.account) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ ...result, page, perPage: PER_PAGE })
}
