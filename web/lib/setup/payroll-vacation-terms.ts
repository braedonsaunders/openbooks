import type { SetupEntity } from './types'

/** One effective-dated employment policy feeds cash vacation pay, banks and annual time. */
export const PAYROLL_VACATION_TERMS_ENTITY: SetupEntity = {
  key: 'payroll-vacation-terms', table: 'payroll_vacation_terms', groupKey: 'workforce', featureKey: 'payroll',
  rehomed: true, iconKey: 'calendar', orgScoped: true, actorCols: true, hasActive: false, orderBy: 'effective_from',
  writePermission: 'hrm.benefits.manage',
  columns: [{ key: 'employmentId', kind: 'ref', ref: 'worker-employments' }, { key: 'method', labelKey: 'vacationTerms.method', kind: 'badge', options: [{ value: 'accrue', labelKey: 'vacationTerms.accrue' }, { value: 'pay_each_period', labelKey: 'vacationTerms.payEachPeriod' }, { value: 'paid_leave', labelKey: 'vacationTerms.paidLeave' }] }, { key: 'percentFloor', kind: 'percent' }, { key: 'annualDaysFloor', kind: 'number' }, { key: 'effectiveFrom', kind: 'date' }, { key: 'effectiveTo', kind: 'date' }],
  fields: [{ key: 'employmentId', kind: 'ref', ref: 'worker-employments', required: true, lockedOnEdit: true },
    { key: 'method', labelKey: 'vacationTerms.method', kind: 'select', required: true, options: [{ value: 'accrue', labelKey: 'vacationTerms.accrue' }, { value: 'pay_each_period', labelKey: 'vacationTerms.payEachPeriod' }, { value: 'paid_leave', labelKey: 'vacationTerms.paidLeave' }] },
    { key: 'percentFloor', kind: 'percent', decimalScale: 4, min: 0, max: 100, showWhen: { field: 'method', in: ['accrue', 'pay_each_period'] }, helpTextKey: 'vacationTerms.percentHint' },
    { key: 'annualDaysFloor', kind: 'decimal', decimalScale: 4, helpTextKey: 'vacationTerms.daysHint' },
    { key: 'effectiveFrom', kind: 'date', required: true }, { key: 'effectiveTo', kind: 'date' },
    { key: 'reason', kind: 'textarea', required: true, helpTextKey: 'serviceCredit.reasonHint' },
  ],
}
