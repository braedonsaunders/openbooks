import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  badge,
  column,
  field,
  grid,
  heading,
  link,
  page,
  pagination,
  ref,
  rootRef,
  table,
  text,
  textBlock,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@openbooks/viewspec'
import { requirePermission } from '../../../../../lib/authz'
import { isUuid, parseListParams, pickString } from '../../../../../lib/list-params'
import { isFeatureEnabled, subsidiaryFeatureEnabled } from '../../../../../lib/features'
import type { PaymentSetupView } from './PaymentOperationsSetup'

/**
 * Payment operations setup, split into a loader and a spec.
 *
 * Four mutually exclusive bodies — profiles, formats, schedules, mandates —
 * chosen by four presence flags the LOADER computes from `?view=`. The spec
 * never asks which view is active; it places four tables and exactly one of
 * them survives. That is the accounts-page precedent (`onList`/`onSearch`/
 * `onHierarchy`) applied to a tabbed setup page.
 *
 * The editor drawer and the per-view "New" button stay widgets: the drawer
 * owns fetch flows plus client form state a spec cannot name (the /tax and
 * payroll precedents), and both need the full options payload plus the
 * multiCurrency flag the loader already resolves. The proposed
 * `payment-operations-editor` slot re-derives nothing — it renders the shared
 * `./sections` component over loader-resolved props — while the tab strip is
 * a shared `PaymentOperationsTabs` chrome (the payroll `PayrollSetupTabs`
 * precedent): the active-vs-plain link PAIR lives in the component, because
 * presence cannot choose between two treatments.
 *
 * Everything else here is loader work copied VERBATIM from page.tsx: the
 * `admin.setup.manage` gate, the view whitelist with its `profiles` fallback,
 * the fixed sort with only `default` allowed, the mandates-vs-rest state
 * filter split, the four per-view list/count/counts/open queries, and the
 * nine-way options fan-out with the subsidiary-UI gate. The mandate status
 * counts use `status as value` (the other views bucket `is_active`); that
 * asymmetry is the native contract and the filter chips render whatever the
 * loader hands them.
 *
 * Message keys: every `t('…')` below is used by the native page or present in
 * `web/messages/en/admin.json` (verified by survey: `states.*`, `tabs.*`,
 * `search.*`, `new.*`, `columns.*`, `rails.*`, `directions.*`,
 * `actions.create_draft/submit_for_approval`, `schemes.*`, `empty`,
 * `manualDelivery`, `runApproval`, `automatic`, `any`, plus the
 * drawer/edit/new keys passed through as data to the editor slot).
 */

const BASE_PATH = '/admin/setup/payment-operations'
const VIEWS = new Set<PaymentSetupView>(['profiles', 'formats', 'schedules', 'mandates'])

type StateCount = { value: string; count: number }

export interface PaymentOperationsRow {
  id: string
  href: string
  name: string | null
  bank: string | null
  formatName: string | null
  currency: string | null
  currencyFallback: string | null
  delivery: string | null
  approval: string | null
  code: string | null
  railLabel: string | null
  railVariant: 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'
  direction: string | null
  profileName: string | null
  cron: string | null
  // Raw ISO passthrough: the native cell formats client-side with
  // `new Date(next_run_at).toLocaleString()`, so the loader must NOT format
  // server-side (server locale/TZ may differ from the browser's). The
  // `payment-schedule-next-run` widget cell runs the identical expression
  // client-side. `timestamptz` arrives as a Date; serialize to ISO.
  nextRunAt: string | null
  action: string | null
  mandateReference: string | null
  partyName: string | null
  scheme: string | null
  signedOn: string | null
  expiresOn: string | null
  statusLabel: string
  statusVariant: 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'
}

export interface PaymentOperationsData {
  title: string
  description: string
  tabs: { key: string; href: string; label: string; active: boolean }[]
  onProfiles: boolean
  onFormats: boolean
  onSchedules: boolean
  onMandates: boolean
  searchPlaceholder: string
  currentParams: Record<string, string | string[] | undefined>
  stateLabel: string
  stateOptions: { value: string; label: string; count: number }[]
  newLabel: string
  newHref: string
  hasRows: boolean
  isEmpty: boolean
  emptyText: string
  labels: {
    name: string
    bank: string
    format: string
    currency: string
    delivery: string
    approval: string
    status: string
    code: string
    rail: string
    direction: string
    profile: string
    cron: string
    nextRun: string
    action: string
    reference: string
    party: string
    scheme: string
    signedOn: string
    expiresOn: string
  }
  rows: PaymentOperationsRow[]
  total: number
  currentPage: number
  perPage: number
  editorOpen: boolean
  editor: {
    view: PaymentSetupView
    row: Record<string, unknown> | null
    creating: boolean
    options: {
      formats: { id: string; name: string; rail: string; currency: string | null }[]
      bankAccounts: { id: string; number: string | null; name: string }[]
      accountingAccounts: { id: string; number: string | null; name: string }[]
      subsidiaries: { id: string; name: string }[]
      sftpServers: { id: string; name: string }[]
      profiles: { id: string; name: string }[]
      parties: { id: string; display_name: string; bank_accounts: { id: string; label: string }[] }[]
      currencies: { code: string; name: string }[]
    }
    multiCurrency: boolean
    closeHref: string
  } | null
}

export async function loadPaymentOperations(
  sp: Record<string, string | string[] | undefined>,
): Promise<PaymentOperationsData> {
  const authz = await requirePermission('admin.setup.manage')
  const t = await getTranslations('admin.setup.paymentOperations')
  const requested = pickString(sp.view) as PaymentSetupView | undefined
  const view: PaymentSetupView = requested && VIEWS.has(requested) ? requested : 'profiles'
  const list = parseListParams(sp, { sort: 'default', allowedSorts: ['default'] as const, perPage: 25 })
  const state = pickString(sp.state)
  const selectedId = isUuid(pickString(sp.row) ?? '') ? pickString(sp.row)! : null
  const orgId = authz.user.orgId
  const q = `%${list.q ?? ''}%`
  const stateWhere = state
    ? view === 'mandates'
      ? sql`and m.status = ${state}`
      : sql`and x.is_active = ${state === 'active'}`
    : sql``

  // Per-view list/count/counts/open fan-out, verbatim from page.tsx. The
  // mandates branch re-derives its own state fragment; the SQL is identical
  // to `stateWhere` above and both are kept so the copy stays line-faithful.
  let rows: Record<string, unknown>[] = []
  let total = 0
  let selected: Record<string, unknown> | null = null
  let stateCounts: StateCount[] = []

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
          join payment_formats f on f.id = x.payment_format_id and f.org_id = x.org_id
          join accounts a on a.id = x.bank_account_id and a.org_id = x.org_id
          left join subsidiaries s on s.id = x.subsidiary_id and s.org_id = x.org_id
          left join sftp_servers sv on sv.id = x.sftp_server_id and sv.org_id = x.org_id
         where x.org_id = ${orgId} and (x.name ilike ${q} or f.name ilike ${q} or a.name ilike ${q})
           ${stateWhere}
         order by x.is_active desc, x.name
         limit ${list.perPage} offset ${(list.page - 1) * list.perPage}`),
      db.execute(sql`select count(*)::int as n
          from payment_bank_profiles x
          join payment_formats f on f.id = x.payment_format_id and f.org_id = x.org_id
          join accounts a on a.id = x.bank_account_id and a.org_id = x.org_id
         where x.org_id = ${orgId} and (x.name ilike ${q} or f.name ilike ${q} or a.name ilike ${q})
           ${stateWhere}`),
      db.execute(sql`select case when is_active then 'active' else 'archived' end as value, count(*)::int as count from payment_bank_profiles where org_id = ${orgId} group by is_active`),
      selectedId ? db.execute(sql`select * from payment_bank_profiles where id = ${selectedId} and org_id = ${orgId}`) : Promise.resolve({ rows: [] }),
    ])
    rows = (data.rows); total = Number(((count.rows[0]))?.n ?? 0); stateCounts = counts.rows as unknown as StateCount[]; selected = ((open.rows[0])) ?? null
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
    rows = (data.rows); total = Number(((count.rows[0]))?.n ?? 0); stateCounts = counts.rows as unknown as StateCount[]; selected = ((open.rows[0])) ?? null
  } else if (view === 'schedules') {
    const [data, count, counts, open] = await Promise.all([
      db.execute(sql`
        select x.*, p.name as profile_name
          from payment_schedules x join payment_bank_profiles p on p.id = x.payment_bank_profile_id and p.org_id = x.org_id
         where x.org_id = ${orgId} and (x.name ilike ${q} or p.name ilike ${q}) ${stateWhere}
         order by x.is_active desc, x.name limit ${list.perPage} offset ${(list.page - 1) * list.perPage}`),
      db.execute(sql`select count(*)::int as n
          from payment_schedules x
          join payment_bank_profiles p on p.id = x.payment_bank_profile_id and p.org_id = x.org_id
         where x.org_id = ${orgId} and (x.name ilike ${q} or p.name ilike ${q})
           ${stateWhere}`),
      db.execute(sql`select case when is_active then 'active' else 'archived' end as value, count(*)::int as count from payment_schedules where org_id = ${orgId} group by is_active`),
      selectedId ? db.execute(sql`select * from payment_schedules where id = ${selectedId} and org_id = ${orgId}`) : Promise.resolve({ rows: [] }),
    ])
    rows = (data.rows); total = Number(((count.rows[0]))?.n ?? 0); stateCounts = counts.rows as unknown as StateCount[]; selected = ((open.rows[0])) ?? null
  } else {
    const mandateState = state ? sql`and m.status = ${state}` : sql``
    const [data, count, counts, open] = await Promise.all([
      db.execute(sql`
        select m.*, p.display_name as party_name, b.bank_name, b.account_last_four
          from payment_mandates m join parties p on p.id = m.party_id and p.org_id = m.org_id
          join party_bank_accounts b on b.id = m.party_bank_account_id and b.org_id = m.org_id
         where m.org_id = ${orgId} and (m.mandate_reference ilike ${q} or p.display_name ilike ${q}) ${mandateState}
         order by m.created_at desc limit ${list.perPage} offset ${(list.page - 1) * list.perPage}`),
      db.execute(sql`
        select count(*)::int as n from payment_mandates m join parties p on p.id = m.party_id and p.org_id = m.org_id
         where m.org_id = ${orgId} and (m.mandate_reference ilike ${q} or p.display_name ilike ${q}) ${mandateState}`),
      db.execute(sql`select status as value, count(*)::int as count from payment_mandates where org_id = ${orgId} group by status`),
      selectedId ? db.execute(sql`select * from payment_mandates where id = ${selectedId} and org_id = ${orgId}`) : Promise.resolve({ rows: [] }),
    ])
    rows = (data.rows); total = Number(((count.rows[0]))?.n ?? 0); stateCounts = counts.rows as unknown as StateCount[]; selected = ((open.rows[0])) ?? null
  }

  const multiCurrency = await isFeatureEnabled(orgId, 'multiCurrency')
  const [formats, bankAccounts, accountingAccounts, subsidiaries, sftpServers, profiles, parties, currencies, subsidiaryUiEnabled] = await Promise.all([
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
      from parties p join party_bank_accounts b on b.party_id = p.id and b.org_id = p.org_id and b.is_active and b.approved_at is not null
     where p.org_id = ${orgId} and p.is_active group by p.id, p.display_name order by p.display_name`),
    db.execute(sql`select code, name from currencies order by code`),
    subsidiaryFeatureEnabled(orgId),
  ])

  type R = Record<string, unknown>
  const str = (r: R, key: string): string | null => {
    const v = r[key]
    return typeof v === 'string' ? v : null
  }
  const hrefFor = (id: string) => `${BASE_PATH}?view=${view}&row=${id}`
  const mandateVariant = (status: string): PaymentOperationsRow['statusVariant'] =>
    status === 'active' ? 'success' : status === 'revoked' ? 'destructive' : 'secondary'

  // Every cell the loaders resolve to a presentation string; the spec binds
  // `text`/`link`/`badge` directly. Conditional pairs stay loader-side: the
  // bank join (`number · name`), the delivery fallback (`manualDelivery`),
  // the approval switch (`runApproval`/`automatic`), the active/archived
  // badge, the `any` currency fallback, and the mandates em-dash fallbacks.
  const mapped: PaymentOperationsRow[] = rows.map((r) => {
    const id = String(r.id)
    if (view === 'profiles') {
      const active = r.is_active === true
      return {
        id,
        href: hrefFor(id),
        name: str(r, 'name'),
        bank: [str(r, 'bank_number'), str(r, 'bank_name')].filter(Boolean).join(' · ') || null,
        formatName: str(r, 'format_name'),
        currency: str(r, 'currency'),
        currencyFallback: null,
        delivery: str(r, 'sftp_server_name') ?? t('manualDelivery'),
        approval: r.require_run_approval === true ? t('runApproval') : t('automatic'),
        code: null,
        railLabel: null,
        railVariant: 'outline',
        direction: null,
        profileName: null,
        cron: null,
        nextRunAt: null,
        action: null,
        mandateReference: null,
        partyName: null,
        scheme: null,
        signedOn: null,
        expiresOn: null,
        statusLabel: t(`states.${active ? 'active' : 'archived'}`),
        statusVariant: active ? 'success' : 'outline',
      }
    }
    if (view === 'formats') {
      const active = r.is_active === true
      return {
        id,
        href: hrefFor(id),
        name: str(r, 'name'),
        bank: null,
        formatName: null,
        currency: str(r, 'currency') ?? t('any'),
        currencyFallback: null,
        delivery: null,
        approval: null,
        code: str(r, 'code'),
        railLabel: t(`rails.${str(r, 'rail') ?? ''}`),
        railVariant: 'outline',
        direction: t(`directions.${str(r, 'direction') ?? ''}`),
        profileName: null,
        cron: null,
        nextRunAt: null,
        action: null,
        mandateReference: null,
        partyName: null,
        scheme: null,
        signedOn: null,
        expiresOn: null,
        statusLabel: t(`states.${active ? 'active' : 'archived'}`),
        statusVariant: active ? 'success' : 'outline',
      }
    }
    if (view === 'schedules') {
      const active = r.is_active === true
      const rawNextRun = r.next_run_at
      const nextRunAt =
        rawNextRun instanceof Date
          ? rawNextRun.toISOString()
          : typeof rawNextRun === 'string'
            ? rawNextRun
            : null
      return {
        id,
        href: hrefFor(id),
        name: str(r, 'name'),
        bank: null,
        formatName: null,
        currency: null,
        currencyFallback: null,
        delivery: null,
        approval: null,
        code: null,
        railLabel: null,
        railVariant: 'outline',
        direction: null,
        profileName: str(r, 'profile_name'),
        cron: str(r, 'cron'),
        nextRunAt,
        action: t(`actions.${str(r, 'action') ?? ''}`),
        mandateReference: null,
        partyName: null,
        scheme: null,
        signedOn: null,
        expiresOn: null,
        statusLabel: t(`states.${active ? 'active' : 'archived'}`),
        statusVariant: active ? 'success' : 'outline',
      }
    }
    const status = str(r, 'status') ?? ''
    return {
      id,
      href: hrefFor(id),
      name: null,
      bank: null,
      formatName: null,
      currency: null,
      currencyFallback: null,
      delivery: null,
      approval: null,
      code: null,
      railLabel: null,
      railVariant: 'outline',
      direction: null,
      profileName: null,
      cron: null,
      nextRunAt: null,
      action: null,
      mandateReference: str(r, 'mandate_reference'),
      partyName: str(r, 'party_name'),
      scheme: t(`schemes.${str(r, 'scheme') ?? ''}`),
      signedOn: str(r, 'signed_on') ?? '—',
      expiresOn: str(r, 'expires_on') ?? '—',
      statusLabel: t(`states.${status}`),
      statusVariant: mandateVariant(status),
    }
  })

  const creating = pickString(sp.row) === 'new'
  const closeHref = `${BASE_PATH}?view=${view}`

  return {
    title: t('title'),
    description: t('description'),
    tabs: (['profiles', 'formats', 'schedules', 'mandates'] as const).map((key) => ({
      key,
      href: `${BASE_PATH}?view=${key}`,
      label: t(`tabs.${key}`),
      active: view === key,
    })),
    onProfiles: view === 'profiles',
    onFormats: view === 'formats',
    onSchedules: view === 'schedules',
    onMandates: view === 'mandates',
    searchPlaceholder: t(`search.${view}`),
    currentParams: sp,
    stateLabel: t('state'),
    stateOptions: stateCounts.map((s) => ({
      value: s.value,
      label: t(`states.${s.value}`),
      count: Number(s.count),
    })),
    newLabel: t(`new.${view}`),
    newHref: `${BASE_PATH}?view=${view}&row=new`,
    hasRows: mapped.length > 0,
    isEmpty: mapped.length === 0,
    emptyText: t('empty'),
    labels: {
      name: t('columns.name'),
      bank: t('columns.bank'),
      format: t('columns.format'),
      currency: t('columns.currency'),
      delivery: t('columns.delivery'),
      approval: t('columns.approval'),
      status: t('columns.status'),
      code: t('columns.code'),
      rail: t('columns.rail'),
      direction: t('columns.direction'),
      profile: t('columns.profile'),
      cron: t('columns.cron'),
      nextRun: t('columns.nextRun'),
      action: t('columns.action'),
      reference: t('columns.reference'),
      party: t('columns.party'),
      scheme: t('columns.scheme'),
      signedOn: t('columns.signedOn'),
      expiresOn: t('columns.expiresOn'),
    },
    rows: mapped,
    total,
    currentPage: list.page,
    perPage: list.perPage,
    editorOpen: creating || selected !== null,
    editor:
      creating || selected
        ? {
            view,
            row: selected,
            creating,
            options: {
              formats: formats.rows as unknown as { id: string; name: string; rail: string; currency: string | null }[],
              bankAccounts: bankAccounts.rows as unknown as { id: string; number: string | null; name: string }[],
              accountingAccounts: accountingAccounts.rows as unknown as { id: string; number: string | null; name: string }[],
              subsidiaries: subsidiaryUiEnabled ? subsidiaries.rows as unknown as { id: string; name: string }[] : [],
              sftpServers: sftpServers.rows as unknown as { id: string; name: string }[],
              profiles: profiles.rows as unknown as { id: string; name: string }[],
              parties: parties.rows as unknown as { id: string; display_name: string; bank_accounts: { id: string; label: string }[] }[],
              currencies: currencies.rows as unknown as { code: string; name: string }[],
            },
            multiCurrency,
            closeHref,
          }
        : null,
  }
}

const f = ref<PaymentOperationsData>()
const item = field
const rootF = rootRef<PaymentOperationsData>()

// The row links all share one treatment: teal, with the formats/code and
// mandates/reference variants additionally monospaced. The loader resolves
// which VALUE each view links; the spec states the treatment per table.
const NAME_LINK = 'font-medium text-teal-700 hover:underline dark:text-teal-300'
const CODE_LINK = 'font-mono text-xs font-semibold text-teal-700 hover:underline dark:text-teal-300'

export function paymentOperationsSpec(data: PaymentOperationsData): PageSpec {
  const newButton = widgetBlock('new-setup-record', {
    href: data.newHref,
    label: data.newLabel,
  })
  return page({
    // The setup workspace renders its own shell around every setup page;
    // wrapping it in a second page layout would nest the chrome. The native
    // page owns its outer `<div className="space-y-4">`, so the spec places
    // the same element as a grid in body; `header` is empty ([entity]
    // precedent).
    layout: 'bare',
    header: [],
    body: [
      grid('space-y-4', [
        grid(undefined, [
          heading(2, f('title'), 'text-lg font-semibold text-slate-900 dark:text-slate-100'),
          textBlock(f('description'), {
            size: 'sm',
            className: 'text-slate-500 dark:text-slate-400',
          }),
        ]),
        widgetBlock('payment-operations-tabs', {
          tabs: data.tabs,
        }),
        grid('flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between', [
          grid('flex flex-wrap items-center gap-2', [
            widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
            widgetBlock('filter-chips', {
              basePath: BASE_PATH,
              currentParams: data.currentParams,
              paramKey: 'state',
              label: data.stateLabel,
              options: data.stateOptions,
            }),
          ]),
          newButton,
        ]),
        // Four mutually exclusive tables; exactly one presence flag is true
        // per render. Each lives in the native card wrapper
        // (`overflow-hidden rounded-xl border …`); the `app` table renders no
        // wrapper of its own.
        {
          ...grid('overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900', [
            table({
              variant: 'app',
              rows: f('rows'),
              rowKey: item('id'),
              emptyRow: { text: rootF('emptyText'), colSpan: 7, className: 'py-10 text-center text-slate-500' },
              columns: [
                column(rootF('labels.name'), link(item('name'), item('href'), NAME_LINK)),
                column(rootF('labels.bank'), text(item('bank'))),
                column(rootF('labels.format'), text(item('formatName'))),
                column(rootF('labels.currency'), text(item('currency')), {
                  className: 'font-mono text-xs',
                }),
                column(rootF('labels.delivery'), text(item('delivery'))),
                column(rootF('labels.approval'), text(item('approval'))),
                column(rootF('labels.status'), badge(item('statusLabel'), { variant: item('statusVariant') })),
              ],
            }),
          ]),
          when: f('onProfiles'),
        },
        {
          ...grid('overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900', [
            table({
              variant: 'app',
              rows: f('rows'),
              rowKey: item('id'),
              emptyRow: { text: rootF('emptyText'), colSpan: 6, className: 'py-10 text-center text-slate-500' },
              columns: [
                column(rootF('labels.code'), link(item('code'), item('href'), CODE_LINK)),
                column(rootF('labels.name'), text(item('name'))),
                column(rootF('labels.rail'), badge(item('railLabel'), { variant: 'outline' })),
                column(rootF('labels.direction'), text(item('direction'))),
                column(rootF('labels.currency'), text(item('currency')), {
                  className: 'font-mono text-xs',
                }),
                column(rootF('labels.status'), badge(item('statusLabel'), { variant: item('statusVariant') })),
              ],
            }),
          ]),
          when: f('onFormats'),
        },
        {
          ...grid('overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900', [
            table({
              variant: 'app',
              rows: f('rows'),
              rowKey: item('id'),
              emptyRow: { text: rootF('emptyText'), colSpan: 6, className: 'py-10 text-center text-slate-500' },
              columns: [
                column(rootF('labels.name'), link(item('name'), item('href'), NAME_LINK)),
                column(rootF('labels.profile'), text(item('profileName'))),
                column(rootF('labels.cron'), text(item('cron')), {
                  className: 'font-mono text-xs',
                }),
                column(
                  rootF('labels.nextRun'),
                  widgetCell('payment-schedule-next-run', { value: item('nextRunAt') }),
                ),
                column(rootF('labels.action'), text(item('action'))),
                column(rootF('labels.status'), badge(item('statusLabel'), { variant: item('statusVariant') })),
              ],
            }),
          ]),
          when: f('onSchedules'),
        },
        {
          ...grid('overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900', [
            table({
              variant: 'app',
              rows: f('rows'),
              rowKey: item('id'),
              emptyRow: { text: rootF('emptyText'), colSpan: 6, className: 'py-10 text-center text-slate-500' },
              columns: [
                column(rootF('labels.reference'), link(item('mandateReference'), item('href'), CODE_LINK)),
                column(rootF('labels.party'), text(item('partyName'))),
                column(rootF('labels.scheme'), text(item('scheme'))),
                column(rootF('labels.signedOn'), text(item('signedOn'))),
                column(rootF('labels.expiresOn'), text(item('expiresOn'))),
                column(rootF('labels.status'), badge(item('statusLabel'), { variant: item('statusVariant') })),
              ],
            }),
          ]),
          when: f('onMandates'),
        },
        pagination({
          basePath: BASE_PATH,
          total: f('total'),
          page: f('currentPage'),
          perPage: f('perPage'),
          // The native pager sits flush in the `space-y-4` flow — no `mt-3`
          // wrapper.
          bare: true,
        }),
        {
          ...widgetBlock('payment-operations-editor', {
            editor: data.editor,
          }),
          when: f('editorOpen'),
        },
      ]),
    ],
  })
}
