import type { ReportEntity } from './entities'

/** Coverage obligations and their payroll lineage are separate from cash paid.
 * Currency metadata makes the report compiler refuse mixed-currency totals. */
export const BENEFITS_REPORT_ENTITIES: ReportEntity[] = [
  {
    key: 'hrm_benefit_payroll_inputs',
    label: 'Benefit payroll inputs',
    description: 'Monthly coverage amounts, employee deductions, employer contributions and consuming payroll runs.',
    category: 'hrm',
    from: `hrm_benefit_payroll_inputs i
      JOIN hrm_benefit_enrollments e ON e.org_id = i.org_id AND e.id = i.enrollment_id
      JOIN hrm_benefit_plans p ON p.org_id = e.org_id AND p.id = e.plan_id
      JOIN worker_employments emp ON emp.org_id = i.org_id AND emp.id = i.employment_id
      JOIN parties worker ON worker.org_id = emp.org_id AND worker.id = emp.worker_party_id
      JOIN subsidiaries employer ON employer.org_id = emp.org_id AND employer.id = emp.employer_subsidiary_id
      JOIN pay_components component ON component.org_id = i.org_id AND component.id = i.pay_component_id
      LEFT JOIN documents run ON run.org_id = i.org_id AND run.id = i.consumed_by_run_document_id`,
    orgColumn: 'i.org_id',
    subsidiaryScope: { column: 'emp.employer_subsidiary_id' },
    currencyColumn: 'currency',
    requiredPermission: 'hrm.benefits.read',
    featureKey: 'hrm',
    defaultPeriodField: 'coverage_from',
    pagination: { defaultPageSize: 50, maxPageSize: 250 },
    columns: [
      { key: 'coverage_from', label: 'Coverage from', kind: 'date', expr: 'i.coverage_from' },
      { key: 'coverage_to', label: 'Coverage to', kind: 'date', expr: 'i.coverage_to' },
      { key: 'person', label: 'Employee', kind: 'text', expr: 'worker.display_name' },
      { key: 'employer', label: 'Legal entity', kind: 'text', expr: 'employer.name' },
      { key: 'plan', label: 'Benefit plan', kind: 'text', expr: 'p.name' },
      { key: 'kind', label: 'Input type', kind: 'enum', expr: 'i.kind', options: ['benefit_deduction', 'employer_contribution'] },
      { key: 'component', label: 'Pay component', kind: 'text', expr: 'component.name' },
      { key: 'amount', label: 'Coverage amount', kind: 'money', expr: 'i.amount', txnCurrency: true },
      { key: 'currency', label: 'Currency', kind: 'text', expr: 'i.currency' },
      { key: 'status', label: 'Input status', kind: 'enum', expr: 'i.status', options: ['pending', 'consumed', 'voided'] },
      { key: 'payroll_run_id', label: 'Consuming payroll run', kind: 'uuid', expr: 'i.consumed_by_run_document_id' },
      { key: 'id', label: 'Input ID', kind: 'uuid', expr: 'i.id' },
    ],
    defaultSort: { column: 'coverage_from', direction: 'desc' },
  },
  {
    key: 'hrm_benefit_awards',
    label: 'Benefit awards and payouts',
    description: 'Employee program awards, approval evidence, delivery references and pay-run adjustment lineage.',
    category: 'hrm',
    from: `hrm_benefit_awards a
      JOIN hrm_benefit_programs p ON p.org_id = a.org_id AND p.id = a.program_id
      JOIN worker_employments emp ON emp.org_id = a.org_id AND emp.id = a.employment_id
      JOIN parties worker ON worker.org_id = emp.org_id AND worker.id = emp.worker_party_id
      JOIN subsidiaries employer ON employer.org_id = p.org_id AND employer.id = p.legal_entity_id`,
    orgColumn: 'a.org_id',
    subsidiaryScope: { column: 'p.legal_entity_id' },
    currencyColumn: 'currency',
    requiredPermission: 'hrm.benefits.read',
    featureKey: 'hrm',
    defaultPeriodField: 'period_from',
    pagination: { defaultPageSize: 50, maxPageSize: 250 },
    columns: [
      { key: 'period_from', label: 'Earned from', kind: 'date', expr: 'a.period_from' },
      { key: 'period_to', label: 'Earned to', kind: 'date', expr: 'a.period_to' },
      { key: 'person', label: 'Employee', kind: 'text', expr: 'worker.display_name' },
      { key: 'employer', label: 'Legal entity', kind: 'text', expr: 'employer.name' },
      { key: 'program', label: 'Program', kind: 'text', expr: "a.program_snapshot->>'name'" },
      { key: 'family', label: 'Program family', kind: 'enum', expr: "a.program_snapshot->>'family'", options: ['reward', 'allowance', 'incentive', 'custom'] },
      { key: 'value', label: 'Award value', kind: 'money', expr: 'a.value', txnCurrency: true },
      { key: 'currency', label: 'Currency', kind: 'text', expr: 'a.currency' },
      { key: 'status', label: 'Award status', kind: 'enum', expr: 'a.status', options: ['draft', 'pending', 'approved', 'queued', 'delivered', 'voided'] },
      { key: 'approved_at', label: 'Approved at', kind: 'timestamp', expr: 'a.approved_at' },
      { key: 'external_reference', label: 'External delivery reference', kind: 'text', expr: 'a.external_ref' },
      { key: 'pay_run_document_id', label: 'Payroll run', kind: 'uuid', expr: 'a.pay_run_document_id' },
      { key: 'pay_run_adjustment_id', label: 'Pay-run adjustment', kind: 'uuid', expr: 'a.pay_run_adjustment_id' },
      { key: 'source_key', label: 'Source reference', kind: 'text', expr: 'a.source_key' },
      { key: 'id', label: 'Award ID', kind: 'uuid', expr: 'a.id' },
    ],
    defaultSort: { column: 'period_from', direction: 'desc' },
  },
]
