import 'server-only';
import { getTranslations } from 'next-intl/server';
import { filterBar, page, pageHeader, ref, textBlock, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec';
import { payrollSupportScope } from '@openbooks/engine/payroll/setup';
import { requirePermission } from '../../../../lib/authz';
import { requireFeatureEnabled } from '../../../../lib/feature-gates';
import { parseReportQuery } from '../../../../lib/report-filters';
import { resolvePeriod } from '../../../../lib/periods';
import { payrollSupportReportData } from '../../../../lib/payroll-support-report';
import { PayrollSupportReportRefusal } from '../../../../lib/payroll-support-report-contract';
import { orgBranding } from '../../../../lib/report-pdf';
import { reportScheduleAnchor, scheduleParamsFrom } from '../../../../lib/report-schedule-anchor';

/** The trial-balance composition keeps the native paper, filters, saved views and export actions whole. */
export async function loadPayrollSupport(sp: Record<string, string | undefined>) {
  const authz = await requirePermission('reports.read');
  await requirePermission('payroll.read');
  await requireFeatureEnabled(authz.user.orgId, 'payroll');
  const q = parseReportQuery(sp);
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to, orgId: authz.user.orgId });
  const [t, tr, branding, definitionId] = await Promise.all([getTranslations('payroll.supportReport'),
    getTranslations('reports'), orgBranding(authz.user.orgId), reportScheduleAnchor('payroll-support')]);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) if (value !== undefined) params.set(key, value);
  let data: Awaited<ReturnType<typeof payrollSupportReportData>> | null = null;
  let refusal: string | null = null;
  try { data = await payrollSupportReportData(period, params); }
  catch (error) { if (!(error instanceof PayrollSupportReportRefusal)) throw error; refusal = error.message; }
  return { title: t('title'), description: t('description'), backHref: '/reports', backLabel: tr('hub.title'),
    primaryFilter: { paramKey: 'country', label: t('country'), value: sp.country ?? '',
      options: [{ value: '', label: t('allCountries') }, ...payrollSupportScope().map(pack => ({ value: pack.country, label: pack.country }))] },
    searchPlaceholder: t('search'), company: branding.orgName, currency: branding.baseCurrency,
    scheduleDefId: definitionId ?? '', hasScheduleDef: Boolean(definitionId), scheduleParams: scheduleParamsFrom(sp),
    exportParams: sp, emptyLabel: t('empty'), refusal, hasData: data !== null, paper: data ? { ...data, periodPhrase: data.dateRangeLabel } : null };
}
type PayrollSupportData = Awaited<ReturnType<typeof loadPayrollSupport>>;
const f = ref<PayrollSupportData>();

export function payrollSupportSpec(data: PayrollSupportData): PageSpec {
  return page({ route: '/reports/payroll-support', layout: 'list', header: [
    pageHeader({ title: f('title'), description: f('description'), back: { href: f('backHref'), label: f('backLabel') } }),
    filterBar({ period: true, search: true }, { searchPlaceholder: f('searchPlaceholder'), primaryFilter: f('primaryFilter'),
      actions: [widget('schedule-report', { definitionId: data.scheduleDefId, statementParams: data.scheduleParams }, f('hasScheduleDef')),
        widget('save-view'), widget('export-menu', { kind: 'payroll-support', params: data.exportParams })] }),
    textBlock(f('refusal'), { tone: 'warning', when: f('refusal') }),
  ], body: [{ ...widgetBlock('paper-view', { company: data.company, currency: data.currency, emptyLabel: data.emptyLabel,
    data: data.paper }), when: f('hasData') }] });
}
