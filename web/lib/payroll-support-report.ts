import 'server-only';
import { getTranslations } from 'next-intl/server';
import { payrollSupportScope } from '@openbooks/engine/payroll/setup';
import type { ExportData } from './report-pdf';
import { formatPayrollSupportReport } from './payroll-support-report-contract';
import type { ResolvedPeriod } from './report-run';

/** Screen, exports and saved views read one declaration snapshot with identical filters. */
export async function payrollSupportReportData(period: ResolvedPeriod, params: URLSearchParams): Promise<ExportData> {
  const t = await getTranslations('payroll.supportReport');
  const inventory = payrollSupportScope(period.to);
  return formatPayrollSupportReport(inventory, period, params, t);
}
