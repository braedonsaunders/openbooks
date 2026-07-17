import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { ensureBuiltInPaymentFormats } from '@openbooks/engine/src/payment-operations.ts'
import { requirePermission } from '../../../../../lib/authz'
import { isUuid, parseListParams, pickString } from '../../../../../lib/list-params'
import { PaymentOperationsSetup, type PaymentSetupView } from './PaymentOperationsSetup'

export const dynamic = 'force-dynamic'

const VIEWS = new Set<PaymentSetupView>(['profiles', 'formats', 'schedules', 'mandates'])

export default async function PaymentOperationsSetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('admin.setup.manage')
  const sp = await searchParams
  const requested = pickString(sp.view) as PaymentSetupView | undefined
  const view: PaymentSetupView = requested && VIEWS.has(requested) ? requested : 'profiles'
  const list = parseListParams(sp, { sort: 'default', allowedSorts: ['default'] as const, perPage: 25 })
  const state = pickString(sp.state)
  const selectedId = isUuid(pickString(sp.row) ?? '') ? pickString(sp.row)! : null
  const orgId = authz.user.orgId
  await ensureBuiltInPaymentFormats(orgId, authz.user.id)

  const q = `%${list.q ?? ''}%`
  const stateWhere = state
    ? view === 'mandates'
      ? sql`and m.status = ${state}`
      : sql`and x.is_active = ${state === 'active'}`
    : sql``

  let rows: Record<string, any>[] = []
  let total = 0
  let selected: Record<string, any> | null = null
  let stateCounts: Array<{ value: string; count: number }> = []

  if (view === 'profiles') {
    const [data, count, counts, open] = await Promise.all([
      db.execute(sql`
        select x.id, x.name, x.bank_account_id, x.subsidiary_id, x.payment_format_id,
               x.currency, x.country, x.settings, x.sftp_server_id, x.sftp_folder,
               x.require_run_approval, x.require_file_approval, x.auto_remittance,
               x.originator_secrets_encrypted is not null as has_secrets, x.is_active,
               f.name as format_name, f.rail, a.number as bank_number, a.name as bank_name,
               s.name as subsidiary_name, sv.name as sftp_server_name
          from payment_bank_profiles x
          join payment_formats f on f.id = x.payment_format_id
          join accounts a on a.id = x.bank_account_id
          left join subsidiaries s on s.id = x.subsidiary_id
          left join sftp_servers sv on sv.id = x.sftp_server_id
         where x.org_id = ${orgId} and (x.name ilike ${q} or f.name ilike ${q} or a.name ilike ${q})
           ${stateWhere}
         order by x.is_active desc, x.name
         limit ${list.perPage} offset ${(list.page - 1) * list.perPage}`),
      db.execute(sql`select count(*)::int as n from payment_bank_profiles x where x.org_id = ${orgId} and x.name ilike ${q} ${stateWhere}`),
      db.execute(sql`select case when is_active then 'active' else 'archived' end as value, count(*)::int as count from payment_bank_profiles where org_id = ${orgId} group by is_active`),
      selectedId ? db.execute(sql`select * from payment_bank_profiles where id = ${selectedId} and org_id = ${orgId}`) : Promise.resolve({ rows: [] }),
    ])
    rows = data.rows as any[]; total = Number((count.rows[0] as any)?.n ?? 0); stateCounts = counts.rows as any[]; selected = (open.rows[0] as any) ?? null
  } else if (view === 'formats') {
    const [data, count, counts, open] = await Promise.all([
      db.execute(sql`
        select x.id, x.code, x.name, x.rail, x.direction, x.country, x.currency,
               x.file_extension, x.content_type, x.formatter_script is not null as has_formatter, x.is_active
          from payment_formats x
         where x.org_id = ${orgId} and (x.code ilike ${q} or x.name ilike ${q} or x.rail ilike ${q}) ${stateWhere}
         order by x.is_active desc, x.name limit ${list.perPage} offset ${(list.page - 1) * list.perPage}`),
      db.execute(sql`select count(*)::int as n from payment_formats x where x.org_id = ${orgId} and (x.code ilike ${q} or x.name ilike ${q} or x.rail ilike ${q}) ${stateWhere}`),
      db.execute(sql`select case when is_active then 'active' else 'archived' end as value, count(*)::int as count from payment_formats where org_id = ${orgId} group by is_active`),
      selectedId ? db.execute(sql`select * from payment_formats where id = ${selectedId} and org_id = ${orgId}`) : Promise.resolve({ rows: [] }),
    ])
    rows = data.rows as any[]; total = Number((count.rows[0] as any)?.n ?? 0); stateCounts = counts.rows as any[]; selected = (open.rows[0] as any) ?? null
  } else if (view === 'schedules') {
    const [data, count, counts, open] = await Promise.all([
      db.execute(sql`
        select x.*, p.name as profile_name
          from payment_schedules x join payment_bank_profiles p on p.id = x.payment_bank_profile_id
         where x.org_id = ${orgId} and (x.name ilike ${q} or p.name ilike ${q}) ${stateWhere}
         order by x.is_active desc, x.name limit ${list.perPage} offset ${(list.page - 1) * list.perPage}`),
      db.execute(sql`select count(*)::int as n from payment_schedules x where x.org_id = ${orgId} and x.name ilike ${q} ${stateWhere}`),
      db.execute(sql`select case when is_active then 'active' else 'archived' end as value, count(*)::int as count from payment_schedules where org_id = ${orgId} group by is_active`),
      selectedId ? db.execute(sql`select * from payment_schedules where id = ${selectedId} and org_id = ${orgId}`) : Promise.resolve({ rows: [] }),
    ])
    rows = data.rows as any[]; total = Number((count.rows[0] as any)?.n ?? 0); stateCounts = counts.rows as any[]; selected = (open.rows[0] as any) ?? null
  } else {
    const mandateState = state ? sql`and m.status = ${state}` : sql``
    const [data, count, counts, open] = await Promise.all([
      db.execute(sql`
        select m.*, p.display_name as party_name, b.bank_name, b.account_last_four
          from payment_mandates m join parties p on p.id = m.party_id
          join party_bank_accounts b on b.id = m.party_bank_account_id
         where m.org_id = ${orgId} and (m.mandate_reference ilike ${q} or p.display_name ilike ${q}) ${mandateState}
         order by m.created_at desc limit ${list.perPage} offset ${(list.page - 1) * list.perPage}`),
      db.execute(sql`
        select count(*)::int as n from payment_mandates m join parties p on p.id = m.party_id
         where m.org_id = ${orgId} and (m.mandate_reference ilike ${q} or p.display_name ilike ${q}) ${mandateState}`),
      db.execute(sql`select status as value, count(*)::int as count from payment_mandates where org_id = ${orgId} group by status`),
      selectedId ? db.execute(sql`select * from payment_mandates where id = ${selectedId} and org_id = ${orgId}`) : Promise.resolve({ rows: [] }),
    ])
    rows = data.rows as any[]; total = Number((count.rows[0] as any)?.n ?? 0); stateCounts = counts.rows as any[]; selected = (open.rows[0] as any) ?? null
  }

  const [formats, bankAccounts, accountingAccounts, subsidiaries, sftpServers, profiles, parties] = await Promise.all([
    db.execute(sql`select id, name, rail, currency from payment_formats where org_id = ${orgId} and is_active order by name`),
    db.execute(sql`select id, number, name from accounts where org_id = ${orgId} and type = 'asset_bank' and is_active and not is_summary order by number nulls last, name`),
    db.execute(sql`select id, number, name from accounts where org_id = ${orgId} and is_active and not is_summary order by number nulls last, name`),
    db.execute(sql`select id, name from subsidiaries where org_id = ${orgId} and is_active order by name`),
    db.execute(sql`select id, name from sftp_servers where org_id = ${orgId} and is_active order by name`),
    db.execute(sql`select id, name from payment_bank_profiles where org_id = ${orgId} and is_active order by name`),
    db.execute(sql`
      select p.id, p.display_name, jsonb_agg(jsonb_build_object(
        'id', b.id, 'label', concat_ws(' · ', nullif(b.bank_name, ''), case when b.account_last_four is not null then '••••' || b.account_last_four end)
      ) order by b.created_at desc) as bank_accounts
      from parties p join party_bank_accounts b on b.party_id = p.id and b.is_active and b.approved_at is not null
     where p.org_id = ${orgId} and p.is_active group by p.id, p.display_name order by p.display_name`),
  ])

  return (
    <PaymentOperationsSetup
      view={view}
      rows={rows}
      selected={selected}
      creating={pickString(sp.row) === 'new'}
      total={total}
      page={list.page}
      perPage={list.perPage}
      currentParams={sp}
      stateCounts={stateCounts}
      options={{
        formats: formats.rows as any[], bankAccounts: bankAccounts.rows as any[], accountingAccounts: accountingAccounts.rows as any[], subsidiaries: subsidiaries.rows as any[],
        sftpServers: sftpServers.rows as any[], profiles: profiles.rows as any[], parties: parties.rows as any[],
      }}
    />
  )
}
