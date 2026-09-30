import type { ReportEntity } from './entities'

const columns = (values: ReportEntity['columns']): ReportEntity['columns'] => values
const commonPeriod = { key: 'week_start', label: 'Week start', kind: 'date' as const, expr: 'facts.week_start' }
const commonDepartment = { key: 'department', label: 'Department', kind: 'text' as const, expr: 'facts.department' }
const commonJobTitle = { key: 'job_title', label: 'Job title', kind: 'text' as const, expr: 'facts.job_title' }

export const utilizationEntity: ReportEntity = {
  key: 'resourcing_utilization', label: 'Resourcing utilization forecast', category: 'resourcing',
  description: 'Weekly capacity and forecast bookings for staffable people.',
  from: 'resourcing_forecast_facts facts', orgColumn: 'facts.org_id', featureKey: 'resourcing',
  requiredPermission: 'resourcing.read', timeKey: 'week_start',
  columns: columns([
    commonPeriod,
    { key: 'person', label: 'Person', kind: 'text', expr: 'facts.person' },
    { key: 'person_id', label: 'Person key', kind: 'uuid', expr: 'facts.person_id' },
    commonDepartment, commonJobTitle,
    { key: 'capacity', label: 'Capacity', kind: 'number', expr: 'facts.capacity' },
    { key: 'net_capacity', label: 'Net capacity', kind: 'number', expr: 'facts.net_capacity' },
    { key: 'hard_billable', label: 'Hard billable hours', kind: 'number', expr: 'facts.hard_billable' },
    { key: 'hard_non_billable', label: 'Hard non-billable hours', kind: 'number', expr: 'facts.hard_non_billable' },
    { key: 'soft_hours', label: 'Soft hours', kind: 'number', expr: 'facts.soft_hours' },
    { key: 'unknown_capacity', label: 'Unknown capacity', kind: 'number', expr: 'facts.unknown_capacity' },
  ]),
}

export const benchEntity: ReportEntity = {
  key: 'resourcing_bench', label: 'Resourcing bench', category: 'resourcing',
  description: 'Weekly idle net capacity for people with no hard bookings.',
  from: 'resourcing_bench_facts facts', orgColumn: 'facts.org_id', featureKey: 'resourcing',
  requiredPermission: 'resourcing.read', timeKey: 'week_start',
  columns: columns([
    commonPeriod, commonDepartment, commonJobTitle,
    { key: 'person_id', label: 'Person key', kind: 'uuid', expr: 'facts.person_id' },
    { key: 'idle_net_capacity', label: 'Idle net capacity', kind: 'number', expr: 'facts.idle_net_capacity' },
  ]),
}

export const capacityDemandEntity: ReportEntity = {
  key: 'resourcing_capacity_demand', label: 'Resourcing capacity versus demand', category: 'resourcing',
  description: 'Staff capacity compared with named, generic, and weighted pipeline demand.',
  from: 'resourcing_capacity_demand_facts facts', orgColumn: 'facts.org_id', featureKey: 'resourcing',
  requiredPermission: 'resourcing.read', timeKey: 'week_start',
  columns: columns([
    commonPeriod, commonDepartment, commonJobTitle,
    { key: 'person_id', label: 'Person key', kind: 'uuid', expr: 'facts.person_id' },
    { key: 'capacity', label: 'Net capacity', kind: 'number', expr: 'facts.capacity' },
    { key: 'named_hard', label: 'Named hard hours', kind: 'number', expr: 'facts.named_hard' },
    { key: 'named_soft', label: 'Named soft hours', kind: 'number', expr: 'facts.named_soft' },
    { key: 'generic_hard', label: 'Generic hard hours', kind: 'number', expr: 'facts.generic_hard' },
    { key: 'generic_soft', label: 'Generic soft hours', kind: 'number', expr: 'facts.generic_soft' },
    { key: 'pipeline_demand', label: 'Weighted pipeline hours', kind: 'number', expr: 'facts.pipeline_demand' },
    { key: 'unknown_capacity', label: 'Unknown capacity', kind: 'number', expr: 'facts.unknown_capacity' },
  ]),
}

export const engagementEntity: ReportEntity = {
  key: 'resourcing_engagement', label: 'Resourcing engagement forecast', category: 'resourcing',
  description: 'Forecast assignment hours, billable revenue, labor cost, and pricing exceptions.',
  from: 'resourcing_engagement_facts facts', orgColumn: 'facts.org_id', featureKey: 'resourcing',
  requiredPermission: 'resourcing.read', currencyColumn: 'currency', timeKey: 'week_start',
  columns: columns([
    commonPeriod,
    { key: 'month', label: 'Month', kind: 'text', expr: 'facts.month' },
    { key: 'project', label: 'Project', kind: 'text', expr: 'facts.project' },
    { key: 'customer', label: 'Customer', kind: 'text', expr: 'facts.customer' },
    { key: 'currency', label: 'Currency', kind: 'text', expr: 'facts.currency' },
    commonDepartment, commonJobTitle,
    { key: 'bill_status', label: 'Bill pricing status', kind: 'enum', expr: 'facts.bill_status', options: ['priced', 'non_billable', 'no_bill_item', 'no_bill_rate'] },
    { key: 'cost_status', label: 'Labor cost status', kind: 'enum', expr: 'facts.cost_status', options: ['priced', 'no_employee', 'no_cost_rate', 'no_cost_fx'] },
    { key: 'hours', label: 'Hours', kind: 'number', expr: 'facts.hours' },
    { key: 'revenue', label: 'Forecast revenue', kind: 'money', expr: 'facts.revenue', txnCurrency: true },
    { key: 'cost', label: 'Forecast cost', kind: 'money', expr: 'facts.cost', txnCurrency: true },
    { key: 'unpriced_hours', label: 'Unpriced billable hours', kind: 'number', expr: 'facts.unpriced_hours' },
    { key: 'unpriced_count', label: 'Unpriced assignments', kind: 'number', expr: 'facts.unpriced_count' },
    { key: 'uncosted_count', label: 'Uncosted assignments', kind: 'number', expr: 'facts.uncosted_count' },
  ]),
}

export const RESOURCING_REPORT_ENTITIES = [utilizationEntity, benchEntity, capacityDemandEntity, engagementEntity] as const
