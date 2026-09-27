/** Usage records and derived SaaS metrics data-io resources. */
import 'server-only'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { ingestUsageRecords, type IngestUsageRecordInput } from '@openbooks/engine/src/billing/usage/records.ts'
import { UsageBillingError } from '@openbooks/engine/src/billing/usage/errors.ts'
import type { CellValue, ImportMode, ResourceDescriptor, ResourceField, WriteOutcome } from './types'
import type { DataResource, WriteCtx } from './resource-core'
import {
  duplicateImportRowIndexes,
  enforceExportRowLimit,
  RefResolver,
  subsidiaryReadFilter,
  type ReadCtx,
} from './resource-core'

export const USAGE_RECORDS_KEY = 'usage-records'
export const SAAS_METRICS_FACTS_KEY = 'saas-metrics-facts'

export const USAGE_RECORDS_DESCRIPTOR: ResourceDescriptor = {
  key: USAGE_RECORDS_KEY,
  label: 'Usage records',
  group: 'Setup',
  iconKey: 'activity',
  readPermission: 'usage.read',
  writePermission: 'usage.manage',
  supportsImport: true,
  naturalKey: 'meterKey + idempotencyKey',
}

export const SAAS_METRICS_FACTS_DESCRIPTOR: ResourceDescriptor = {
  key: SAAS_METRICS_FACTS_KEY,
  label: 'SaaS metrics facts',
  group: 'Setup',
  iconKey: 'chart-no-axes-combined',
  readPermission: 'usage.read',
  writePermission: 'usage.read',
  supportsImport: false,
  naturalKey: 'subsidiary + month',
}

function usageRecordFields(): ResourceField[] {
  return [
    { key: 'meterKey', label: 'Meter key', kind: 'reference', required: true, ref: { resource: 'usage-meters', by: 'key' } },
    { key: 'customer', label: 'Customer', kind: 'reference', required: true, ref: { resource: 'customers', by: 'short_code' } },
    { key: 'subscription', label: 'Subscription', kind: 'text' },
    { key: 'occurredOn', label: 'Occurred on', kind: 'date', required: true },
    { key: 'quantity', label: 'Quantity', kind: 'text', required: true },
    { key: 'distinctKey', label: 'Distinct key', kind: 'text' },
    { key: 'sourceRef', label: 'Source reference', kind: 'text' },
    { key: 'idempotencyKey', label: 'Idempotency key', kind: 'text', required: true },
  ]
}

const METRICS_FIELDS: ResourceField[] = [
  { key: 'subsidiary', label: 'Subsidiary', kind: 'reference', required: true, ref: { resource: 'subsidiaries', by: 'name' } },
  { key: 'month', label: 'Month', kind: 'date', required: true },
  ...[
    ['mrrStart', 'MRR at start'], ['mrrEnd', 'MRR at end'], ['newMrr', 'New MRR'],
    ['expansionMrr', 'Expansion MRR'], ['contractionMrr', 'Contraction MRR'],
    ['churnedMrr', 'Churned MRR'], ['reactivationMrr', 'Reactivation MRR'],
    ['recognizedRevenue', 'Recognized revenue'], ['deferredDelta', 'Deferred change'],
    ['mrrAtRisk', 'MRR at risk'],
  ].map(([key, label]) => ({ key: key!, label: label!, kind: 'currency' as const })),
  ...[
    ['customersStart', 'Customers at start'], ['customersEnd', 'Customers at end'],
    ['customersNew', 'New customers'], ['customersChurned', 'Churned customers'],
    ['customersReactivated', 'Reactivated customers'],
  ].map(([key, label]) => ({ key: key!, label: label!, kind: 'number' as const })),
  ...[
    ['glRevenue', 'GL revenue'], ['glCogs', 'GL cost of goods sold'], ['bookings', 'Bookings'],
    ['billings', 'Billings'], ['deferredBalance', 'Deferred balance'],
  ].map(([key, label]) => ({ key: key!, label: label!, kind: 'currency' as const })),
  { key: 'basis', label: 'Basis', kind: 'text' },
  { key: 'inputsHash', label: 'Inputs hash', kind: 'text' },
  { key: 'computedAt', label: 'Computed at', kind: 'datetime' },
]

const CURRENCY_COLUMNS: Record<string, string> = {
  mrrStart: 'mrr_start', mrrEnd: 'mrr_end', newMrr: 'new_mrr', expansionMrr: 'expansion_mrr',
  contractionMrr: 'contraction_mrr', churnedMrr: 'churned_mrr', reactivationMrr: 'reactivation_mrr',
  recognizedRevenue: 'recognized_revenue', deferredDelta: 'deferred_delta', mrrAtRisk: 'mrr_at_risk',
  glRevenue: 'gl_revenue', glCogs: 'gl_cogs', bookings: 'bookings', billings: 'billings', deferredBalance: 'deferred_balance',
}

function describeRefusal(error: unknown): string {
  if (error instanceof UsageBillingError) return `${error.message} Remedy: ${error.remedy}`
  return error instanceof Error ? error.message : 'Usage import was refused.'
}

export function usageRecordsResource(orgId: string): DataResource {
  return {
    descriptor: USAGE_RECORDS_DESCRIPTOR,
    async fields() { return usageRecordFields() },
    async columns() { return usageRecordFields().map(({ key, label }) => ({ key, label })) },
    async read(ctx?: ReadCtx) {
      const result = await db.execute<{
        meter_key: string; customer_id: string; subscription: string | null; occurred_on: string;
        quantity: string; distinct_key: string | null; source_ref: string | null; idempotency_key: string;
      }>(sql`
        select m.key as meter_key, r.customer_id::text as customer_id,
               r.subscription_id::text as subscription, r.occurred_on::text as occurred_on,
               r.quantity::text as quantity, r.distinct_key, r.source_ref, r.idempotency_key
          from usage_records r
          join usage_meters m on m.org_id = r.org_id and m.id = r.meter_id
          join parties c on c.org_id = r.org_id and c.id = r.customer_id
         where r.org_id = ${orgId} and r.reverses_id is null
           ${subsidiaryReadFilter(sql`c.subsidiary_id`, ctx?.allowedSubsidiaryIds)}
         order by r.occurred_on, r.id
         limit 10001`)
      enforceExportRowLimit(result.rows, USAGE_RECORDS_DESCRIPTOR.label)
      const resolver = new RefResolver(orgId)
      const fields = usageRecordFields()
      const rows: Record<string, CellValue>[] = []
      for (const source of result.rows) {
        rows.push({
          meterKey: source.meter_key,
          customer: await resolver.resolveLabel({ resource: 'customers', by: 'short_code' }, source.customer_id),
          subscription: source.subscription,
          occurredOn: source.occurred_on,
          quantity: source.quantity,
          distinctKey: source.distinct_key,
          sourceRef: source.source_ref,
          idempotencyKey: source.idempotency_key,
        })
      }
      return { fields, columns: fields.map(({ key, label }) => ({ key, label })), rows }
    },
    async write(rows: Record<string, unknown>[], _mode: ImportMode, ctx: WriteCtx): Promise<WriteOutcome> {
      const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
      if (ctx.orgId !== orgId) {
        return { ...outcome, failed: rows.length, errors: rows.map((_, index) => ({ row: index + 1, message: 'resource belongs to another organization' })) }
      }
      return withOrgTransaction(orgId, async () => {
        const resolver = new RefResolver(orgId)
        const prepared: ({ row: number; input: IngestUsageRecordInput } | { row: number; error: string; key: string | null })[] = []
        for (let index = 0; index < rows.length; index++) {
          const source = rows[index]!
          const meterKey = String(source.meterKey ?? '').trim()
          const idempotencyKey = String(source.idempotencyKey ?? '').trim()
          const duplicateKey = meterKey && idempotencyKey ? `${meterKey}\0${idempotencyKey}` : null
          try {
            const customer = String(source.customer ?? '').trim()
            const customerId = await resolver.resolveId({ resource: 'customers', by: 'short_code' }, customer)
            if (!customerId) throw new Error(`customer: "${customer}" not found`)
            prepared.push({
              row: index + 1,
              input: {
                meterKey,
                customerId,
                subscriptionId: source.subscription == null || source.subscription === '' ? null : String(source.subscription),
                occurredOn: String(source.occurredOn ?? ''),
                quantity: source.quantity,
                distinctKey: source.distinctKey == null || source.distinctKey === '' ? null : String(source.distinctKey),
                source: 'import',
                sourceRef: source.sourceRef == null || source.sourceRef === '' ? null : String(source.sourceRef),
                idempotencyKey,
              },
            })
          } catch (error) {
            prepared.push({ row: index + 1, error: describeRefusal(error), key: duplicateKey })
          }
        }

        const duplicateRows = duplicateImportRowIndexes(prepared.map((row) => 'input' in row
          ? (row.input.meterKey && row.input.idempotencyKey ? `${row.input.meterKey}\0${row.input.idempotencyKey}` : null)
          : row.key))
        const valid: { row: number; input: IngestUsageRecordInput }[] = []
        for (let index = 0; index < prepared.length; index++) {
          const row = prepared[index]!
          if (duplicateRows.has(index)) {
            outcome.failed++
            outcome.errors.push({ row: row.row, message: 'Duplicate meter key and idempotency key in this file.' })
            continue
          }
          if (!('input' in row)) {
            outcome.failed++
            outcome.errors.push({ row: row.row, message: row.error })
            continue
          }
          let alreadyStored = false
          if (row.input.idempotencyKey) {
            alreadyStored = (await db.execute<{ id: string }>(sql`
              select r.id from usage_records r
                join usage_meters m on m.org_id = r.org_id and m.id = r.meter_id
               where r.org_id = ${orgId} and m.key = ${row.input.meterKey}
                 and r.idempotency_key = ${row.input.idempotencyKey}
               limit 1`)).rows.length > 0
          }
          if (alreadyStored) {
            continue
          }
          await db.execute(sql`savepoint usage_record_validate`)
          try {
            await ingestUsageRecords(orgId, ctx.actorId, [row.input])
            await db.execute(sql`rollback to savepoint usage_record_validate`)
            await db.execute(sql`release savepoint usage_record_validate`)
            valid.push(row)
          } catch (error) {
            await db.execute(sql`rollback to savepoint usage_record_validate`)
            await db.execute(sql`release savepoint usage_record_validate`)
            outcome.failed++
            outcome.errors.push({ row: row.row, message: describeRefusal(error) })
          }
        }

        if (ctx.dryRun) {
          outcome.created = valid.length
          return outcome
        }
        if (valid.length) {
          await db.execute(sql`savepoint usage_record_commit`)
          try {
            await ingestUsageRecords(orgId, ctx.actorId, valid.map(({ input }) => input))
            await db.execute(sql`release savepoint usage_record_commit`)
            outcome.created = valid.length
          } catch (error) {
            await db.execute(sql`rollback to savepoint usage_record_commit`)
            await db.execute(sql`release savepoint usage_record_commit`)
            for (const row of valid) {
              outcome.failed++
              outcome.errors.push({ row: row.row, message: describeRefusal(error) })
            }
          }
        }
        return outcome
      })
    },
  }
}

export function saasMetricsFactsResource(orgId: string): DataResource {
  return {
    descriptor: SAAS_METRICS_FACTS_DESCRIPTOR,
    async fields() { return METRICS_FIELDS },
    async columns() { return METRICS_FIELDS.map(({ key, label }) => ({ key, label })) },
    async read(_ctx?: ReadCtx) {
      const columns = sql.raw(Object.entries(CURRENCY_COLUMNS).map(([key, column]) => `${column}::text as "${key}"`).join(', '))
      const result = await db.execute(sql`
        select s.name as subsidiary, f.month::text as month, ${columns},
               f.customers_start as "customersStart", f.customers_end as "customersEnd",
               f.customers_new as "customersNew", f.customers_churned as "customersChurned",
               f.customers_reactivated as "customersReactivated", f.basis, f.inputs_hash as "inputsHash",
               f.computed_at::text as "computedAt"
          from saas_metrics_facts_monthly f
          join subsidiaries s on s.org_id = f.org_id and s.id = f.subsidiary_id
         where f.org_id = ${orgId}
         order by f.month, s.name
         limit 10001`) as { rows: Record<string, CellValue>[] }
      enforceExportRowLimit(result.rows, SAAS_METRICS_FACTS_DESCRIPTOR.label)
      return { fields: METRICS_FIELDS, columns: METRICS_FIELDS.map(({ key, label }) => ({ key, label })), rows: result.rows }
    },
    async write(rows: Record<string, unknown>[]): Promise<WriteOutcome> {
      return {
        created: 0, updated: 0, failed: rows.length,
        errors: rows.map((_, index) => ({ row: index + 1, message: 'SaaS metrics facts are derived and cannot be imported.' })),
      }
    },
  }
}
