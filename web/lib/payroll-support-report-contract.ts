import type { PayrollSupportScope } from '@openbooks/engine/payroll/setup';
import type { ExportData, Translator } from './report-pdf';
import type { ResolvedPeriod } from './report-run';

export class PayrollSupportReportRefusal extends Error {}

/** A native declaration matrix uses the same projection for every rendering path. */
export function formatPayrollSupportReport(inventory: PayrollSupportScope, period: ResolvedPeriod,
  params: URLSearchParams, t: Translator): ExportData {
  const country = params.get('country') ?? '';
  if (country && !inventory.some(pack => pack.country === country)) {
    throw new PayrollSupportReportRefusal(t('invalidCountry'));
  }
  const search = (params.get('q') ?? '').trim().toLocaleLowerCase();
  const selected = inventory.filter(pack => (!country || pack.country === country) && (!search ||
    [pack.country, pack.currency, ...pack.regions.map(region => region.name), ...pack.filings.map(filing => filing.label)]
      .join(' ').toLocaleLowerCase().includes(search)));
  const yesNo = (value: boolean) => t(value ? 'implemented' : 'notImplemented');
  const years = (values: readonly number[]) => values.length ? values.join(', ') : t('none');
  const groups: ExportData['groups'] = selected.flatMap(pack => {
    const year = pack.selectedTaxYear!;
    const published = pack.publishedTableYears.includes(year);
    const calculation = !pack.payable ? t('notImplemented') : published ? t('published')
      : pack.draftTableYears.includes(year) ? t('draft') : t('unavailable');
    return [
      { kind: 'section' as const, title: `${pack.country} · ${pack.currency}`, columns: [t('capability'), t('status'), t('evidence')],
        rows: [
          [t('calculation'), `${year}: ${calculation}`, pack.payabilityRefusal ?? (published ? t('calculationNote') : t('missingYear'))],
          [t('publishedYears'), years(pack.publishedTableYears), t('tableNote')],
          [t('draftYears'), years(pack.draftTableYears), t('draftNote')],
          [t('remittance'), pack.remittanceSchedules.length > 0 ? t('declared') : t('notImplemented'),
            pack.remittanceSchedules.map(schedule => `${schedule.authority}: ${schedule.effectiveFrom} — ${schedule.effectiveTo ?? t('openEnded')}`).join('; ') || t('none')],
          [t('obligations'), pack.obligations.map(obligation => obligation.key).join(', ') || t('none'), t('obligationNote')],
        ],
      },
      { kind: 'section' as const, title: t('regions'), columns: [t('region'), t('calculation'), t('publishedYears'), t('evidence')],
        rows: pack.regions.map(region => [region.name || region.region, yesNo(region.incomeTaxImplemented),
          years(region.publishedTableYears), region.refusal ?? t('regionNote')]),
      },
      { kind: 'section' as const, title: t('filings'),
        columns: [t('filing'), t('original'), t('correction'), t('correctionFile'), t('submission'), t('acceptance'), t('evidence')],
        rows: pack.filings.map(filing => [filing.label, yesNo(filing.originalFile || filing.originalSlip), yesNo(filing.correction), yesNo(filing.correctionFile),
          yesNo(filing.submission), yesNo(filing.acceptance),
          [t('filingYearNote'), filing.originalFileRefusal, filing.correctionRefusal, filing.submissionRefusal, filing.acceptanceRefusal].filter(Boolean).join(' · ') || t('filingYearNote')]),
      },
    ];
  });
  return { title: t('title'), dateRangeLabel: t('asOf', { date: period.to }), summary: [], groups };
}
