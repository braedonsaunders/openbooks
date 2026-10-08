'use client'

import { Label, Select } from '@openbooks/ui'
import { useTranslations } from 'next-intl'
import { type PayrollAmountRounding, requirePayrollWageRounding } from '@openbooks/engine/src/projects/payroll-wage-rounding.ts'

/** Shared controls for both native wage authoring surfaces. */
export function PayrollWageRoundingFields(props: {
  idPrefix: string; rateScale: number; amountRounding: PayrollAmountRounding;
  onChange: (rateScale: number, amountRounding: PayrollAmountRounding) => void;
}) {
  const t = useTranslations('parties.drawer.wages')
  const update = (scale: number, scope: string) => {
    const terms = requirePayrollWageRounding(scale, scope)
    props.onChange(terms.payrollRateScale, terms.payrollAmountRounding)
  }
  return <>
    <div>
      <Label htmlFor={`${props.idPrefix}-precision`}>{t('payrollRatePrecision')}</Label>
      <Select id={`${props.idPrefix}-precision`} value={props.rateScale}
        onChange={(event) => update(Number(event.target.value), props.amountRounding)}>
        {[0, 1, 2, 3, 4].map((scale) => <option key={scale} value={scale}>{t('decimalPlaces', { count: scale })}</option>)}
      </Select>
    </div>
    <div>
      <Label htmlFor={`${props.idPrefix}-rounding`}>{t('payrollAmountRounding')}</Label>
      <Select id={`${props.idPrefix}-rounding`} value={props.amountRounding}
        onChange={(event) => update(props.rateScale, event.target.value)}>
        <option value="dimension_group">{t('dimensionGroupRounding')}</option>
        <option value="time_entry">{t('timeEntryRounding')}</option>
      </Select>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('roundingEffectiveDateHint')}</p>
    </div>
  </>
}
