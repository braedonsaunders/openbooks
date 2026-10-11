'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { Badge, Button, Input, Label, Popover, Select } from '@openbooks/ui'
import { PagedTable, type PagedColumn } from '@/components/paged-table'
import { ModuleHomeTabs } from '@/components/module-home/ui'
import { useMoney } from '@/components/money-provider'
import { mergeHref } from '@/lib/list-params'
import { useAppAction } from '@/lib/use-app-action'
import { postJson } from '../depth-client'
import type { CipRecordRow, ConstructionData } from './_data'
import { CipDrawer } from './CipDrawer'

/** Open a construction-in-progress record on its CIP account. */
export function NewCipButton({ data }: { data: ConstructionData }) {
  const t = useTranslations('assets')
  const router = useRouter()
  const action = useAppAction()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [subsidiaryId, setSubsidiaryId] = useState(data.subsidiaries[0]?.id ?? '')
  const [categoryId, setCategoryId] = useState(data.categories[0]?.id ?? '')
  const [cipAccountId, setCipAccountId] = useState('')
  const [startedOn, setStartedOn] = useState(data.today)

  async function create() {
    await action.execute(
      () => postJson<{ id: string }>('/api/assets/construction', { name, subsidiaryId, categoryId, cipAccountId, startedOn }, t('construction.createFailed')),
      {
        fallbackMessage: t('construction.createFailed'),
        successMessage: t('construction.created'),
        onOk: (created) => { setOpen(false); router.push(`/assets/construction?cip=${created.id}`); router.refresh() },
      },
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen} align="end" trigger={<Button onClick={() => setOpen((value) => !value)}>{t('construction.new')}</Button>}>
      <div className="w-80 space-y-3 p-3">
        <ActionAlert error={action.refusal} fallbackMessage={t('construction.createFailed')} />
        <div className="space-y-1.5"><Label htmlFor="cip-name">{t('construction.fields.name')}</Label><Input id="cip-name" value={name} onChange={(event) => setName(event.target.value)} /></div>
        <div className="space-y-1.5"><Label htmlFor="cip-subsidiary">{t('construction.fields.legalEntity')}</Label>
          <Select id="cip-subsidiary" value={subsidiaryId} onChange={(event) => setSubsidiaryId(event.target.value)}>
            {data.subsidiaries.map((subsidiary) => <option key={subsidiary.id} value={subsidiary.id}>{subsidiary.name}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5"><Label htmlFor="cip-account">{t('construction.fields.cipAccount')}</Label>
          <Select id="cip-account" value={cipAccountId} onChange={(event) => setCipAccountId(event.target.value)}>
            <option value="">{t('construction.fields.choose')}</option>
            {data.cipAccounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5"><Label htmlFor="cip-category">{t('construction.fields.expectedCategory')}</Label>
          <Select id="cip-category" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
            {data.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5"><Label htmlFor="cip-started">{t('construction.fields.startedOn')}</Label><Input id="cip-started" type="date" value={startedOn} onChange={(event) => setStartedOn(event.target.value)} /></div>
        <Button className="w-full" disabled={action.busy || !name.trim() || !subsidiaryId || !categoryId || !cipAccountId} onClick={create}>{t('construction.create')}</Button>
      </div>
    </Popover>
  )
}

export function ConstructionWorkspace({
  data,
  currentParams,
}: {
  data: ConstructionData
  currentParams: Record<string, string | string[] | undefined>
}) {
  const t = useTranslations('assets')
  const { money } = useMoney()
  const router = useRouter()
  const tabs = [
    { key: 'records', href: '/assets/construction', label: t('construction.tabs.records'), active: data.tab === 'records' },
    { key: 'reconciliation', href: '/assets/construction?tab=reconciliation', label: t('construction.tabs.reconciliation'), active: data.tab === 'reconciliation' },
  ]
  const columns: PagedColumn<CipRecordRow>[] = [
    { key: 'number', header: t('construction.columns.number'), cell: (row) => <span className="font-mono text-[13px]">{row.assetNumber}</span>, search: (row) => row.assetNumber },
    { key: 'name', header: t('construction.columns.name'), cell: (row) => row.name, search: (row) => row.name },
    { key: 'entity', header: t('construction.columns.legalEntity'), cell: (row) => row.subsidiaryName },
    { key: 'account', header: t('construction.columns.account'), cell: (row) => row.accountLabel },
    { key: 'linked', header: t('construction.columns.linked'), align: 'right', cell: (row) => <span className="tabular-nums">{money(row.linked)}</span> },
    { key: 'capitalized', header: t('construction.columns.capitalized'), align: 'right', cell: (row) => <span className="tabular-nums">{money(row.capitalized)}</span> },
    { key: 'expensed', header: t('construction.columns.expensed'), align: 'right', cell: (row) => <span className="tabular-nums">{money(row.expensed)}</span> },
    { key: 'open', header: t('construction.columns.open'), align: 'right', cell: (row) => <strong className="tabular-nums">{money(row.open)}</strong> },
    { key: 'status', header: t('construction.columns.status'), cell: (row) => <Badge variant={row.status === 'construction' ? 'warning' : 'success'}>{t(`status.${row.status}`)}</Badge> },
  ]
  return (
    <div className="space-y-4">
      <ModuleHomeTabs tabs={tabs} placement="local" ariaLabel={t('construction.tabsAria')} />
      {data.tab === 'records' ? (
        <PagedTable
          rows={data.rows}
          columns={columns}
          source="asset_cip_records"
          searchable
          pageSize={25}
          rowKey={(row) => row.id}
          onRowClick={(row) => router.push(mergeHref('/assets/construction', currentParams, { cip: row.id }))}
          rowLabel={(row) => `${row.assetNumber} ${row.name}`}
          rowSelected={(row) => row.id === data.selected?.id}
          empty={<p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">{t('construction.empty')}</p>}
          emptyAsRow
        />
      ) : (
        <div className="space-y-3">
          <form className="flex items-end gap-2" action="/assets/construction">
            <input type="hidden" name="tab" value="reconciliation" />
            <div className="space-y-1.5"><Label htmlFor="recon-as-of">{t('construction.fields.asOf')}</Label><Input id="recon-as-of" name="asOf" type="date" defaultValue={data.asOf} /></div>
            <Button type="submit" variant="outline">{t('construction.refresh')}</Button>
          </form>
          <PagedTable
            rows={data.reconciliation}
            source="asset_cip_reconciliation"
            rowKey={(row) => `${row.subsidiaryId}:${row.accountId}`}
            columns={[
              { key: 'account', header: t('construction.columns.account'), cell: (row) => [row.accountNumber, row.accountName].filter(Boolean).join(' · ') },
              { key: 'entity', header: t('construction.columns.legalEntity'), cell: (row) => row.subsidiaryName },
              { key: 'subledger', header: t('construction.columns.subledger'), align: 'right', cell: (row) => <span className="tabular-nums">{money(row.subledger)}</span> },
              { key: 'ledger', header: t('construction.columns.ledger'), align: 'right', cell: (row) => <span className="tabular-nums">{money(row.ledger)}</span> },
              { key: 'difference', header: t('construction.columns.difference'), align: 'right', cell: (row) => <span className={row.difference === '0.0000' ? 'tabular-nums text-slate-500' : 'font-semibold tabular-nums text-red-600 dark:text-red-400'}>{money(row.difference)}</span> },
            ]}
            empty={<p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">{t('construction.reconciliationEmpty')}</p>}
            emptyAsRow
          />
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('construction.reconciliationHelp')}</p>
        </div>
      )}
      {data.selected ? (
        <CipDrawer
          key={data.selected.id}
          record={data.selected}
          data={data}
          closeHref={mergeHref('/assets/construction', currentParams, { cip: undefined })}
        />
      ) : null}
    </div>
  )
}
