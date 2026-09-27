'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useDirtyClose } from '@/lib/use-dirty-close'
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
  effectiveFrom: string | null
  effectiveTo: string | null
  operationSeq: number | null
  scrapPct: string | null
  isByproduct: boolean
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
  effectiveFrom: string
  effectiveTo: string
  operationSeq: string
  scrapPct: string
  isByproduct: string
}

function editableLine(line?: Partial<BomComponent>): EditableBomLine {
  return {
    componentItemId: line?.componentItemId ?? '',
    quantityPer: line?.quantityPer ?? '',
    effectiveFrom: line?.effectiveFrom ?? '',
    effectiveTo: line?.effectiveTo ?? '',
    operationSeq: line?.operationSeq == null ? '' : String(line.operationSeq),
    scrapPct: line?.scrapPct ?? '',
    isByproduct: line?.isByproduct ? 'true' : 'false',
  }
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
  const tInventory = useTranslations('inventory')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const creating = assembly === null
  const [manufacturingEnabled, setManufacturingEnabled] = useState(false)
  const [detailReady, setDetailReady] = useState(false)
  const [version, setVersion] = useState<string | null>(assembly?.version ?? null)
  const [assemblyItemId, setAssemblyItemId] = useState(assembly?.assemblyItemId ?? '')
  const [lines, setLines] = useState<EditableBomLine[]>(() =>
    assembly?.components.map((line) => editableLine(line)) ?? [editableLine()],
  )
  const [originalLines, setOriginalLines] = useState<EditableBomLine[]>(() =>
    assembly?.components.map((line) => editableLine(line)) ?? [editableLine()],
  )
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    async function loadBom() {
      try {
        const query = assembly ? `?assemblyItemId=${encodeURIComponent(assembly.assemblyItemId)}` : ''
        const res = await fetch(`/api/inventory/bom${query}`)
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(typeof data.error === 'string' ? data.error : tCommon('feedback.loadFailed'))
        }
        const data = await res.json() as {
          manufacturingEnabled?: boolean
          version?: string | null
          components?: BomComponent[]
        }
        if (!current) return
        setManufacturingEnabled(data.manufacturingEnabled === true)
        if (assembly) {
          const loaded = data.components?.map((line) => editableLine(line)) ?? []
          const nextLines = loaded.length > 0 ? loaded : [editableLine()]
          setLines(nextLines)
          setOriginalLines(nextLines)
          setVersion(data.version ?? null)
        }
        setDetailReady(true)
      } catch (error) {
        if (current) setSaveError(error instanceof Error ? error.message : tCommon('feedback.loadFailed'))
      }
    }
    void loadBom()
    return () => { current = false }
  }, [assembly?.assemblyItemId, tCommon])
  const closeGuard = useDirtyClose({
    dirty: assemblyItemId !== (assembly?.assemblyItemId ?? '') ||
      JSON.stringify(lines) !== JSON.stringify(originalLines) || reason !== '',
    busy, onClose: () => {},
    message: tCommon('feedback.unsavedChanges'), confirmLabel: tCommon('confirm.discardChanges'),
  })

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
    {
      key: 'effectiveFrom',
      label: tInventory('bom.columns.effectiveFrom'),
      width: '145px',
      type: 'text',
      placeholder: 'YYYY-MM-DD',
    },
    {
      key: 'effectiveTo',
      label: tInventory('bom.columns.effectiveTo'),
      width: '145px',
      type: 'text',
      placeholder: 'YYYY-MM-DD',
    },
    ...(manufacturingEnabled ? [
      {
        key: 'operationSeq',
        label: tInventory('bom.columns.operationSeq'),
        width: '120px',
        type: 'decimal' as const,
        decimalScale: 0,
        align: 'right' as const,
      },
    ] : []),
    {
      key: 'scrapPct',
      label: tInventory('bom.columns.scrapPct'),
      width: '130px',
      type: 'decimal',
      decimalScale: 4,
      align: 'right',
    },
    ...(manufacturingEnabled ? [
      {
        key: 'isByproduct',
        label: tInventory('bom.columns.isByproduct'),
        width: '145px',
        type: 'select' as const,
        options: [
          { value: 'false', label: tInventory('bom.values.component') },
          { value: 'true', label: tInventory('bom.values.byproduct') },
        ],
      },
    ] : []),
  ], [componentOptions, manufacturingEnabled, tInventory, tSetup])

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
            effectiveFrom: line.effectiveFrom || null,
            effectiveTo: line.effectiveTo || null,
            scrapPct: line.scrapPct || null,
            ...(manufacturingEnabled ? {
              operationSeq: line.operationSeq ? Number(line.operationSeq) : null,
              isByproduct: line.isByproduct === 'true',
            } : {}),
          })),
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        if (data.code === 'bom_effectivity_overlap' && typeof data.componentItemId === 'string') {
          const component = items.find((item) => item.id === data.componentItemId)
          const windows = Array.isArray(data.windows) ? data.windows.join(' and ') : ''
          throw new Error(tInventory('bom.refusals.effectivityOverlap', {
            component: component ? itemLabel(component) : data.componentItemId,
            windows,
          }))
        }
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
      beforeClose={closeGuard.beforeClose}
      size="2xl"
      title={tSetup('entities.bom-components.title')}
      description={tSetup('entities.bom-components.description')}
      headerActions={
        <Button disabled={busy || !detailReady} onClick={save}>
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
            disabled={busy || !creating}
            placeholder={tSetup('fields.assemblyItemId')}
            sheetTitle={tSetup('fields.assemblyItemId')}
            ariaLabel={tSetup('fields.assemblyItemId')}
          />
        </div>
        <LineGrid
          columns={lineColumns}
          rows={lines}
          onRowsChange={setLines}
          readOnly={busy || !detailReady}
          emptyRow={() => editableLine()}
        />
        <div className="space-y-1.5">
          <Label>{tCommon('amendment.reason')} <span className="text-red-500">*</span></Label>
          <Textarea
            disabled={busy}
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
