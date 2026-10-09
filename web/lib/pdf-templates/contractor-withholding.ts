import 'server-only'
import { getTranslations } from 'next-intl/server'
import { renderPdfDocument } from '@openbooks/pdf'
import type { WithholdingReturnView, WithholdingStatement } from '@openbooks/engine/contractor-withholding'
import { getMoneyFormatter } from '@/lib/money-server'

/** Print frozen return figures in the shared financial document composition. */
export async function renderWithholdingPdf(ret: WithholdingReturnView, statement: WithholdingStatement | null): Promise<Buffer> {
  const t = await getTranslations('ap.withholding')
  const { money } = await getMoneyFormatter(undefined, ret.currency)
  const format = (value: string) => money(value, { currency: ret.currency })
  return renderPdfDocument({
    title: statement ? `${t('statement')} · ${statement.payeeName}` : `${t('return')} · ${ret.schemeName}`,
    dateRangeLabel: `${ret.periodStart} – ${ret.periodEnd} · ${t('revision', { revision: ret.revision })} · ${t(`statuses.${ret.status}`)}`,
    generatedAt: new Date(ret.filedAt ?? ret.preparedAt),
    branding: { orgName: ret.entityName },
    layout: { paperSize: 'a4', orientation: 'portrait', marginMm: 15, density: 'standard' },
    summary: [
      { label: ret.contractorReferenceLabel, value: ret.contractorReference },
      { label: t('deducted'), value: format(statement?.deducted ?? ret.totals.deducted) },
    ],
    groups: statement ? [{
      kind: 'results', title: ret.schemeName,
      subtitle: `${statement.payeeReferenceLabel}: ${statement.payeeReference ?? '—'} · ${statement.verificationLabel}: ${statement.verificationReference ?? '—'}`,
      columns: [t('statement'), ret.currency], align: ['left', 'right'],
      rows: (['paid', 'net', 'materials', 'base', 'deducted'] as const).map(key => [t(key), format(statement[key])]),
    }] : [{
      kind: 'results', title: ret.authority,
      subtitle: ret.filingReference ? `${t('filingReference')}: ${ret.filingReference}` : t('return'),
      columns: [t('payee'), ret.payeeReferenceLabel, t('paid'), t('base'), t('deducted'), t('waived')],
      align: ['left', 'left', 'right', 'right', 'right', 'right'],
      rows: ret.lines.map(line => [line.payeeName, line.payeeReference ?? '—', format(line.paid), format(line.base), format(line.deducted), format(line.waived ?? '0')]),
      isEmpty: ret.lines.length === 0,
    }],
    footerLeft: `${ret.entityName} · ${ret.schemeCode} · ${ret.id}`,
    footerRight: `${t('returnDue')}: ${ret.returnDue ?? '—'} · ${t('paymentDue')}: ${ret.paymentDue ?? '—'}`,
  })
}
