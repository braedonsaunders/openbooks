/** Prior-provider paid-period evidence within the authoritative annual payroll carry-in. */
export { payrollPeriodOpeningForEmployee, type PayrollPeriodOpeningView } from './period-opening-reader.ts';
export { savePayrollPeriodOpening, PayrollPeriodOpeningUnavailableError, type PayrollPeriodOpeningRecord } from './period-opening-store.ts';
export { PayrollError } from './error.ts';
export type { PayrollPeriodOpeningField } from './period-opening-contract.ts';

/** Import columns come from the same pack declaration used by the drawer and calculation. */
export async function payrollPeriodOpeningFieldsForCountry(country: string) {
  const { payrollPack } = await import('./packs.ts');
  return [...(payrollPack(country).periodOpeningTreatment?.fields ?? [])];
}
