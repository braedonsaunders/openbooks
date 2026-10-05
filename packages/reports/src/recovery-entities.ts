import type { ReportEntity } from './entities'

// Revenue recovery reads the collection subledger directly: every invoice
// the automatic-collection engine has ever charged, with the first decline's
// class, the recovery path and the recovered amount. Posted receipts move
// the money — the ledger cannot tell a first-charge collection from a
// third-retry one — so the catalog carries the same org-pinned per-invoice
// rollup the collections cockpit aggregates. One row per invoice with at
// least one collection attempt; a recovery is a success at a later schedule
// position than the first failure, so same-tick fallback charges count.
const shared = {
  category: 'orders' as const,
  featureKey: 'autopay',
  requiredPermission: 'documents.manage',
  subsidiaryScope: { column: 'd.subsidiary_id' },
  currencyColumn: 'currency',
} as const

export const RECOVERY_REPORT_ENTITIES: ReportEntity[] = [
  {
    ...shared,
    key: 'collection_recovery',
    label: 'Collection recovery',
    description:
      'One row per invoice the automatic-collection engine has charged — attempts, the first decline class, whether a later position recovered it and by which path, and days to recover. Group by decline class and provider for recovery rates.',
    from: `documents d
      join (select distinct org_id, invoice_id from collection_attempts) has
        on has.org_id = d.org_id and has.invoice_id = d.id
      join parties p on p.org_id = d.org_id and p.id = d.party_id
      join lateral (
        select count(*)::integer as attempts,
               count(*) filter (where a.status = 'failed')::integer as failed_attempts,
               min(a.created_at)::date as first_attempt_day,
               min(a.retry_position) filter (where a.status = 'failed') as first_failed_position,
               (select a2.provider from collection_attempts a2
                 where a2.org_id = d.org_id and a2.invoice_id = d.id
                 order by a2.retry_position desc limit 1) as last_provider
          from collection_attempts a
         where a.org_id = d.org_id and a.invoice_id = d.id
      ) s on true
      left join lateral (
        select a.decline_kind as first_decline_kind, a.provider as first_provider,
               a.created_at::date as first_failed_day
          from collection_attempts a
         where a.org_id = d.org_id and a.invoice_id = d.id and a.status = 'failed'
         order by a.retry_position limit 1
      ) f on true
      left join lateral (
        select a.amount as recovered_amount, a.created_at::date as recovered_day,
               case when a.fallback_method_id is null then 'primary' else 'backup' end as recovered_via
          from collection_attempts a
         where a.org_id = d.org_id and a.invoice_id = d.id and a.status = 'succeeded'
           and a.retry_position > s.first_failed_position
         order by a.retry_position limit 1
      ) r on true`,
    orgColumn: 'd.org_id',
    defaultPeriodField: 'first_attempt_day',
    defaultSort: { column: 'first_attempt_day', direction: 'desc' },
    columns: [
      { key: 'invoice', label: 'Invoice', kind: 'text', expr: 'd.document_number' },
      { key: 'customer', label: 'Customer', kind: 'text', expr: 'p.display_name' },
      { key: 'invoice_day', label: 'Invoice day', kind: 'date', expr: 'd.document_date::date' },
      { key: 'due_day', label: 'Due day', kind: 'date', expr: 'd.due_date::date' },
      { key: 'currency', label: 'Currency', kind: 'text', expr: 'd.currency' },
      { key: 'invoice_total', label: 'Invoice total', kind: 'money', expr: 'd.total', txnCurrency: true },
      { key: 'attempts', label: 'Attempts', kind: 'number', expr: 's.attempts' },
      { key: 'failed_attempts', label: 'Failed attempts', kind: 'number', expr: 's.failed_attempts' },
      {
        key: 'first_decline_class', label: 'First decline class', kind: 'enum', expr: 'f.first_decline_kind',
        options: ['hard', 'soft', 'insufficient_funds', 'needs_authentication'],
      },
      { key: 'provider', label: 'Provider', kind: 'text', expr: 'coalesce(f.first_provider, s.last_provider)' },
      {
        key: 'recovered', label: 'Recovered', kind: 'number',
        expr: '(case when r.recovered_amount is null then 0 else 1 end)',
      },
      {
        key: 'recovered_via', label: 'Recovered via', kind: 'enum', expr: 'r.recovered_via',
        options: ['primary', 'backup'],
      },
      {
        key: 'recovered_amount', label: 'Recovered amount', kind: 'money',
        expr: 'coalesce(r.recovered_amount, 0)', txnCurrency: true,
      },
      { key: 'recovered_day', label: 'Recovered day', kind: 'date', expr: 'r.recovered_day' },
      { key: 'days_to_recover', label: 'Days to recover', kind: 'number', expr: '(r.recovered_day - f.first_failed_day)' },
      { key: 'first_attempt_day', label: 'First attempt day', kind: 'date', expr: 's.first_attempt_day' },
    ],
  },
]
