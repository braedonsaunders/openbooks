import type { SetupEntity } from './types'

/** Credited service preserves the employment hire date and its observed baseline. */
export const PAYROLL_SERVICE_CREDITS_ENTITY: SetupEntity = {
  key: 'payroll-service-credits', table: 'payroll_service_credits', groupKey: 'workforce', featureKey: 'payroll',
  rehomed: true, iconKey: 'calendar', orgScoped: true, actorCols: true, hasActive: false, orderBy: 'as_of_date',
  writePermission: 'hrm.benefits.manage',
  columns: [{ key: 'employmentId', kind: 'ref', ref: 'worker-employments' }, { key: 'convention', kind: 'badge', options: [{ value: 'calendar_months', labelKey: 'serviceCredit.calendarMonths' }, { value: 'actual_365', labelKey: 'serviceCredit.actual365' }] }, { key: 'asOfDate', kind: 'date' }, { key: 'creditedDays', kind: 'number' }, { key: 'creditedMonths', kind: 'number' }, { key: 'effectiveFrom', kind: 'date' }, { key: 'effectiveTo', kind: 'date' }],
  fields: [{ key: 'employmentId', kind: 'ref', ref: 'worker-employments', required: true, lockedOnEdit: true },
    { key: 'convention', kind: 'select', required: true, options: [{ value: 'calendar_months', labelKey: 'serviceCredit.calendarMonths' }, { value: 'actual_365', labelKey: 'serviceCredit.actual365' }], helpTextKey: 'serviceCredit.conventionHint' },
    { key: 'asOfDate', kind: 'date', required: true, helpTextKey: 'serviceCredit.asOfHint' },
    { key: 'creditedDays', kind: 'decimal', required: true, decimalScale: 16, showWhen: { field: 'convention', in: ['actual_365'] } },
    { key: 'creditedMonths', kind: 'integer', required: true, min: 0, showWhen: { field: 'convention', in: ['calendar_months'] } },
    { key: 'effectiveFrom', kind: 'date', required: true }, { key: 'effectiveTo', kind: 'date' },
    { key: 'reason', kind: 'textarea', required: true, helpTextKey: 'serviceCredit.reasonHint' },
  ],
}
