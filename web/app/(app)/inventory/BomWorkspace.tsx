'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Plus } from 'lucide-react'
import { Button, Label, SearchSelect, Textarea, UrlDrawer } from '@openbooks/ui'
import { LineGrid, type LineGridColumn } from '../../../components/line-grid'
import { PagedTable, type PagedColumn } from '../../../components/paged-table'

export interface BomComponent {
  id: string
  componentItemId: string
  quantityPer: string
  sortOrder: number
}

export interface BomAssembly extends Record<string, unknown> {
  assemblyItemId: string
  assemblyCode: string | null
  assemblyName: string | null
  componentCount: number
  version: string
  components: BomComponent[]
}

type ItemOption = { id: string; code: string | null; name: string | null }
type EditableBomLine = Record<string, unknown> & {
  componentItemId: string
  quantityPer: string
}

/** Header action whose URL selector creates exactly one drawer instance. */
export function NewBomButton({ label }: { label: string }) {
  const router = useRouter()
  return (
    <Button
      onClick={() => {
        router.replace('/inventory?inventoryView=bom&bom=new', { scroll: false })
      }}
    >
      <Plus size={15} /> {label}
    </Button>
  )
}

function itemLabel(item: ItemOption): string {
  return `${item.code ? `${item.code} · ` : ''}${item.name ?? ''}`.trim() || item.id
}

export function BomWorkspace({
  assemblies,
  items,
  selected,
  canManage,
}: {
  assemblies: BomAssembly[]
  items: ItemOption[]
  selected?: string
  canManage: boolean
}) {
  const tSetup = useTranslations('admin.setup')
  const router = useRouter()
  const activeKey = selected
  const active = activeKey === 'new'
    ? null
    : assemblies.find((assembly) => assembly.assemblyItemId === activeKey) ?? null

  const columns: PagedColumn<BomAssembly>[] = [
    {
      key: 'assembly',
      header: tSetup('fields.assemblyItemId'),
      cell: (row) => itemLabel({ id: row.assemblyItemId, code: row.assemblyCode, name: row.assemblyName }),
      search: (row) => `${row.assemblyCode ?? ''} ${row.assemblyName ?? ''}`,
    },
    {
      key: 'components',
      header: tSetup('fields.componentItemId'),
      align: 'right',
      cell: (row) => row.componentCount,
      search: (row) => String(row.componentCount),
    },
  ]

  return (
    <>
      <PagedTable
        rows={assemblies}
        columns={columns}
        searchable
        empty={tSetup('empty')}
        emptyAsRow
        rowKey={(row) => row.assemblyItemId}
        onRowClick={(row) => {
          router.replace(`/inventory?inventoryView=bom&bom=${encodeURIComponent(row.assemblyItemId)}`, { scroll: false })
        }}
      />
      {canManage && (activeKey === 'new' || active) ? (
        <BomDrawer key={activeKey} assembly={active} assemblies={assemblies} items={items} />
      ) : null}
    </>
  )
}

function BomDrawer({
  assembly,
  assemblies,
  items,
}: {
  assembly: BomAssembly | null
  assemblies: BomAssembly[]
  items: ItemOption[]
}) {
  const tSetup = useTranslations('admin.setup')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const creating = assembly === null
  const [assemblyItemId, setAssemblyItemId] = useState(assembly?.assemblyItemId ?? '')
  const [lines, setLines] = useState<EditableBomLine[]>(() =>
    assembly?.components.map((line) => ({
      componentItemId: line.componentItemId,
      quantityPer: line.quantityPer,
    })) ?? [{ componentItemId: '', quantityPer: '' }],
  )
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const usedAssemblies = new Set(assemblies.map((candidate) => candidate.assemblyItemId))
  const assemblyOptions = items
    .filter((item) => item.id === assemblyItemId || !usedAssemblies.has(item.id))
    .map((item) => ({ value: item.id, label: itemLabel(item) }))
  const componentOptions = items
    .filter((item) => item.id !== assemblyItemId)
    .map((item) => ({ value: item.id, label: itemLabel(item) }))

  const lineColumns = useMemo<LineGridColumn<EditableBomLine>[]>(() => [
    {
      key: 'componentItemId',
      label: tSetup('fields.componentItemId'),
      width: 'minmax(260px, 1fr)',
      type: 'search-select',
      options: componentOptions,
      required: true,
    },
    {
      key: 'quantityPer',
      label: tSetup('fields.quantityPer'),
      width: '150px',
      type: 'decimal',
      decimalScale: 4,
      align: 'right',
      required: true,
    },
  ], [componentOptions, tSetup])

  async function save() {
    const clean = lines.filter((line) => line.componentItemId || line.quantityPer)
    if (!assemblyItemId || clean.length === 0 || clean.some((line) => !line.componentItemId || !line.quantityPer)) {
      const message = tSetup('validation.required', { field: tSetup('fields.componentItemId') })
      setSaveError(message)
      toast.error(message)
      return
    }
    if (!reason.trim()) {
      const message = tSetup('validation.required', { field: tCommon('amendment.reason') })
      setSaveError(message)
      toast.error(message)
      return
    }

    setBusy(true)
    setSaveError(null)
    try {
      const res = await fetch('/api/inventory/bom', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          assemblyItemId,
          expectedVersion: assembly?.version ?? null,
          reason: reason.trim(),
          components: clean.map((line, index) => ({
            componentItemId: String(line.componentItemId),
            quantityPer: String(line.quantityPer),
            sortOrder: index,
          })),
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(typeof data.error === 'string' && data.error.trim() ? data.error : tCommon('feedback.saveFailed'))
      }
      toast.success(creating ? tSetup('created') : tSetup('updated'))
      router.push('/inventory?inventoryView=bom')
      router.refresh()
    } catch (error) {
      const message = error instanceof Error ? error.message : tCommon('feedback.saveFailed')
      setSaveError(message)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <UrlDrawer
      open
      closeHref="/inventory?inventoryView=bom"
      size="2xl"
      title={tSetup('entities.bom-components.title')}
      description={tSetup('entities.bom-components.description')}
      headerActions={
        <Button disabled={busy} onClick={save}>
          {busy ? tCommon('actions.saving') : tCommon('actions.save')}
        </Button>
      }
    >
      <div className="space-y-5 p-1">
        {saveError ? (
          <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            {saveError}
          </p>
        ) : null}
        <div className="space-y-1.5">
          <Label>{tSetup('fields.assemblyItemId')} <span className="text-red-500">*</span></Label>
          <SearchSelect
            value={assemblyItemId}
            onChange={setAssemblyItemId}
            options={assemblyOptions}
            disabled={!creating}
            placeholder={tSetup('fields.assemblyItemId')}
            sheetTitle={tSetup('fields.assemblyItemId')}
            ariaLabel={tSetup('fields.assemblyItemId')}
          />
        </div>
        <LineGrid
          columns={lineColumns}
          rows={lines}
          onRowsChange={setLines}
          emptyRow={() => ({ componentItemId: '', quantityPer: '' })}
        />
        <div className="space-y-1.5">
          <Label>{tCommon('amendment.reason')} <span className="text-red-500">*</span></Label>
          <Textarea
            value={reason}
            onChange={(event) => {
              setReason(event.target.value)
              setSaveError(null)
            }}
            rows={3}
            placeholder={tCommon('amendment.placeholder')}
          />
        </div>
      </div>
    </UrlDrawer>
  )
}
