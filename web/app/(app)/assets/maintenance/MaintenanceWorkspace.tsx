'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import type { MaintenanceQueueRow } from '@openbooks/engine/assets/asset-maintenance'
import { Badge, Button, Label, Popover, Select } from '@openbooks/ui'
import { PagedTable, type PagedColumn } from '@/components/paged-table'
import { FilterChips } from '@/components/filter-bar'
import { mergeHref } from '@/lib/list-params'
import { useAppAction } from '@/lib/use-app-action'
import { postJson } from '../depth-client'
import type { MaintenanceData } from './_data'
import { ScheduleDrawer } from './ScheduleDrawer'
import { ScheduleFields, scheduleBody, type ScheduleFormValues } from './ScheduleFields'

const STANDING_VARIANT = { scheduled: 'secondary', due: 'warning', overdue: 'destructive' } as const

export function NewScheduleButton({ data }: { data: MaintenanceData }) {
  const t = useTranslations('assets')
  const router = useRouter()
  const action = useAppAction()
  const [open, setOpen] = useState(false)
  const [assetId, setAssetId] = useState(data.assets[0]?.id ?? '')
  const [values, setValues] = useState<ScheduleFormValues>({
    name: '', intervalMonths: '12', intervalUsage: '', usageUnit: '', startsOn: data.today, leadDays: '14', vendorPartyId: '', estimatedCost: '',
  })
  async function create() {
    await action.execute(
      () => postJson<{ id: string }>('/api/assets/maintenance/schedules', { assetId, ...scheduleBody(values) }, t('maintenance.saveFailed')),
      {
        fallbackMessage: t('maintenance.saveFailed'),
        successMessage: t('maintenance.created'),
        onOk: (created) => { setOpen(false); router.push(`/assets/maintenance?schedule=${created.id}`); router.refresh() },
      },
    )
  }
  return (
    <Popover open={open} onOpenChange={setOpen} align="end" trigger={<Button onClick={() => setOpen((value) => !value)}>{t('maintenance.new')}</Button>}>
      <div className="w-[34rem] space-y-3 p-3">
        <ActionAlert error={action.refusal} fallbackMessage={t('maintenance.saveFailed')} />
        <div className="space-y-1.5"><Label htmlFor="new-schedule-asset">{t('maintenance.fields.asset')}</Label>
          <Select id="new-schedule-asset" value={assetId} onChange={(event) => setAssetId(event.target.value)}>
            {data.assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.label}</option>)}
          </Select>
        </div>
        <ScheduleFields idPrefix="new-schedule" values={values} vendors={data.vendors} onChange={(patch) => setValues((current) => ({ ...current, ...patch }))} />
        <Button className="w-full" disabled={action.busy || !assetId || !values.name.trim()} onClick={create}>{t('maintenance.create')}</Button>
      </div>
    </Popover>
  )
}

export function MaintenanceWorkspace({
  data,
  currentParams,
}: {
  data: MaintenanceData
  currentParams: Record<string, string | string[] | undefined>
}) {
  const t = useTranslations('assets')
  const router = useRouter()
  const columns: PagedColumn<MaintenanceQueueRow>[] = [
    { key: 'asset', header: t('maintenance.columns.asset'), cell: (row) => <span><span className="font-mono text-[13px]">{row.assetNumber}</span> {row.assetName}</span>, search: (row) => `${row.assetNumber} ${row.assetName}` },
    { key: 'name', header: t('maintenance.columns.task'), cell: (row) => row.name, search: (row) => row.name },
    { key: 'dueOn', header: t('maintenance.columns.nextDueOn'), cell: (row) => row.nextDueOn ?? '—' },
    { key: 'dueUsage', header: t('maintenance.columns.nextDueUsage'), align: 'right', cell: (row) => (row.nextDueUsage ? `${row.nextDueUsage} ${row.usageUnit ?? ''}` : '—') },
    { key: 'current', header: t('maintenance.columns.currentUsage'), align: 'right', cell: (row) => (row.currentUsage ? `${row.currentUsage} ${row.usageUnit ?? ''}` : '—') },
    { key: 'standing', header: t('maintenance.columns.standing'), cell: (row) => <Badge variant={STANDING_VARIANT[row.standing]}>{t(`maintenance.standing.${row.standing}`)}</Badge> },
  ]
  return (
    <div className="space-y-4">
      <PagedTable
        rows={data.rows}
        columns={columns}
        source="asset_maintenance_schedules"
        searchable
        pageSize={25}
        rowKey={(row) => row.scheduleId}
        onRowClick={(row) => router.push(mergeHref('/assets/maintenance', currentParams, { schedule: row.scheduleId }))}
        rowLabel={(row) => `${row.assetNumber} ${row.name}`}
        rowSelected={(row) => row.scheduleId === data.selected?.id}
        empty={<p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">{t('maintenance.empty')}</p>}
        emptyAsRow
        toolbarAfter={
          <FilterChips
            basePath="/assets/maintenance"
            currentParams={currentParams}
            paramKey="standing"
            label={t('maintenance.columns.standing')}
            allLabel={t('maintenance.standing.all')}
            options={(['due', 'overdue'] as const).map((value) => ({ value, label: t(`maintenance.standing.${value}`) }))}
          />
        }
      />
      {data.selected ? (
        <ScheduleDrawer
          key={data.selected.id}
          schedule={data.selected}
          data={data}
          closeHref={mergeHref('/assets/maintenance', currentParams, { schedule: undefined })}
        />
      ) : null}
    </div>
  )
}
