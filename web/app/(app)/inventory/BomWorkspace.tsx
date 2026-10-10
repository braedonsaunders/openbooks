'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useDirtyClose } from '@/lib/use-dirty-close'
import { toast } from 'sonner'
import { Plus } from 'lucide-react'
import { Button, Label, SearchSelect, Textarea, UrlDrawer } from '@openbooks/ui'
import { isAssemblyCapableKind } from '@openbooks/engine/src/inventory/bom-policy.ts'
import { LineGrid, type LineGridColumn } from '../../../components/line-grid'
import { PagedTable, type PagedColumn } from '../../../components/paged-table'

export interface BomComponent {
  id: string
  componentItemId: string
  quantityPer: string
  quantityBasis: "per_unit"|"per_batch"|"per_formula"
  formulaOutputQuantity:string
  sortOrder: number
  effectiveFrom: string | null
  effectiveTo: string | null
  operationSeq: number | null
  scrapPct: string | null
  isByproduct: boolean
  outputCostWeight?:string|null
}

export interface BomAssembly extends Record<string, unknown> {
  assemblyItemId: string
  assemblyCode: string | null
  assemblyName: string | null
  componentCount: number
  version: string
  components: BomComponent[]
}

type ItemOption = { id: string; code: string | null; name: string | null; kind?: string | null }
type EditableBomLine = Record<string, unknown> & {
  componentItemId: string
  quantityPer: string
  quantityBasis: "per_unit"|"per_batch"|"per_formula"
  formulaOutputQuantity:string
  effectiveFrom: string
  effectiveTo: string
  operationSeq: string
  scrapPct: string
  isByproduct: string
  outputCostWeight:string
}

function editableLine(line?: Partial<BomComponent>): EditableBomLine {
  return {
    componentItemId: line?.componentItemId ?? '',
    quantityPer: line?.quantityPer ?? '',
    quantityBasis:line?.quantityBasis??'per_unit',formulaOutputQuantity:line?.formulaOutputQuantity?.replace(/\.0+$/,'')??'1',
    effectiveFrom: line?.effectiveFrom ?? '',
    effectiveTo: line?.effectiveTo ?? '',
    operationSeq: line?.operationSeq == null ? '' : String(line.operationSeq),
    scrapPct: line?.scrapPct ?? '',
    isByproduct: line?.isByproduct ? line.outputCostWeight!=null?'co_product':'true' : 'false',
    outputCostWeight:line?.outputCostWeight??'',
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
        source="inventory_bom"
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

/**
 * The bill-of-materials editor, shared by the inventory workspace and the
 * kit tab of the item drawer. A fixed assembly locks the editor onto one
 * parent (a kit) with its own close destination and save callback, so the
 * operator edits components in context instead of leaving the record.
 */
export function BomDrawer({
  assembly,
  assemblies,
  items,
  fixedAssemblyItemId,
  fixedAssemblyLabel,
  closeHref,
  stacked,
  hideManufacturingFields,
  onSaved,
}: {
  assembly: BomAssembly | null
  assemblies: BomAssembly[]
  items: ItemOption[]
  fixedAssemblyItemId?: string
  fixedAssemblyLabel?: string
  closeHref?: string
  stacked?: boolean
  /** Kits ship exactly the quantities named: manufacturing recipe features
   *  are refused server-side for them, so the editor hides those columns. */
  hideManufacturingFields?: boolean
  onSaved?: () => void
}) {
  const tSetup = useTranslations('admin.setup')
  const tManufacturing = useTranslations('manufacturing')
  const tInventory = useTranslations('inventory')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const creating = assembly === null && !fixedAssemblyItemId
  const [manufacturingEnabled, setManufacturingEnabled] = useState(false)
  const [detailReady, setDetailReady] = useState(false)
  const [canProposeRevision,setCanProposeRevision] = useState(false)
  const [parentKind,setParentKind] = useState<string|null>(null)
  const [subsidiaries,setSubsidiaries] = useState<Array<{id:string;name:string}>>([])
  const [subsidiaryId,setSubsidiaryId] = useState('')
  const [loadedVersion,setLoadedVersion] = useState<string|null>(assembly?.version ?? null)
  const [today,setToday] = useState('')
  const requestRef = useRef<{body:string;key:string}|null>(null)
  const [assemblyItemId, setAssemblyItemId] = useState(fixedAssemblyItemId ?? assembly?.assemblyItemId ?? '')
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
        const targetId = assemblyItemId
        const query = targetId ? `?assemblyItemId=${encodeURIComponent(targetId)}` : ''
        const res = await fetch(`/api/inventory/bom${query}`)
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(typeof data.error === 'string' ? data.error : tCommon('feedback.loadFailed'))
        }
        const data = await res.json() as {
          manufacturingEnabled?: boolean
          version?: string | null
          components?: BomComponent[]
          kind?: string
          canProposeRevision?: boolean
          subsidiaries?: Array<{id:string;name:string}>
          today?: string
        }
        if (!current) return
        setManufacturingEnabled(data.manufacturingEnabled === true)
        setCanProposeRevision(data.canProposeRevision === true)
        setParentKind(data.kind ?? null)
        setSubsidiaries(data.subsidiaries ?? [])
        setSubsidiaryId(current => (data.subsidiaries ?? []).some(entity=>entity.id===current) ? current : data.subsidiaries?.length===1 ? data.subsidiaries[0]!.id : '')
        setLoadedVersion(data.version ?? null)
        setToday(data.today ?? '')
        if (assembly || data.components?.length) {
          const loaded = data.components?.map((line) => editableLine(line)) ?? []
          const nextLines = loaded.length > 0 ? loaded : [editableLine()]
          setLines(nextLines)
          setOriginalLines(nextLines)
        } else if (data.manufacturingEnabled && data.kind !== 'kit' && data.today) {
          setLines(current=>current.map(line=>line.effectiveFrom ? line : {...line,effectiveFrom:data.today!}))
        }
        setDetailReady(true)
      } catch (error) {
        if (current) setSaveError(error instanceof Error ? error.message : tCommon('feedback.loadFailed'))
      }
    }
    setDetailReady(false)
    void loadBom()
    return () => { current = false }
  }, [assembly, assemblyItemId, tCommon])
  const closeGuard = useDirtyClose({
    dirty: assemblyItemId !== (fixedAssemblyItemId ?? assembly?.assemblyItemId ?? '') ||
      JSON.stringify(lines) !== JSON.stringify(originalLines) || reason !== '',
    busy, onClose: () => {},
    message: tCommon('feedback.unsavedChanges'), confirmLabel: tCommon('confirm.discardChanges'),
  })

  const showManufacturing = manufacturingEnabled && parentKind !== 'kit' && !hideManufacturingFields
  const usedAssemblies = new Set(assemblies.map((candidate) => candidate.assemblyItemId))
  // A recipe parent must be something the BOM service accepts as an
  // assembly: raw materials and packaging never qualify, so they never
  // appear as choices. Components keep the full profiled catalog.
  const assemblyOptions = items
    .filter((item) => isAssemblyCapableKind(item.kind))
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
    ...(showManufacturing ? [
      {key:'quantityBasis',secondary:true,secondaryDefaultValue:'per_unit',label:tManufacturing('formula.basis'),width:'180px',type:'select' as const,options:[{value:'per_unit',label:tManufacturing('formula.perUnit')},{value:'per_formula',label:tManufacturing('formula.perFormula')},{value:'per_batch',label:tManufacturing('formula.perBatch')}]},
      {key:'formulaOutputQuantity',secondary:true,secondaryDefaultValue:'1',label:tManufacturing('formula.outputQuantity'),width:'170px',type:'decimal' as const,decimalScale:4,align:'right' as const},
    ] : []),
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
    ...(showManufacturing ? [
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
    ...(showManufacturing ? [
      {
        key: 'isByproduct',
        label: tInventory('bom.columns.isByproduct'),
        width: '145px',
        type: 'select' as const,
        options: [
          { value: 'false', label: tInventory('bom.values.component') },
          { value: 'true', label: tInventory('bom.values.byproduct') },
          { value: 'co_product', label: tInventory('bom.values.jointOutput') },
        ],
      },
      {key:'outputCostWeight',label:tInventory('bom.columns.outputCostWeight'),width:'150px',type:'decimal' as const,decimalScale:4,align:'right' as const},
    ] : []),
  ], [componentOptions, showManufacturing, tInventory, tSetup])

  async function save() {
    const clean = lines.filter((line) => line.componentItemId || line.quantityPer)
    if(clean.some(line=>line.isByproduct==='co_product'&&!line.outputCostWeight.trim())) {
      const message=tSetup('validation.required',{field:tInventory('bom.columns.outputCostWeight')});
      setSaveError(message);toast.error(message);return;
    }
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
      const body = JSON.stringify({
          assemblyItemId,
          expectedVersion: loadedVersion,
          ...(showManufacturing ? {subsidiaryId} : {}),
          reason: reason.trim(),
          components: clean.map((line, index) => ({
            componentItemId: String(line.componentItemId),
            quantityPer: String(line.quantityPer),quantityBasis:line.quantityBasis,formulaOutputQuantity:line.quantityBasis==='per_formula'?String(line.formulaOutputQuantity):'1',
            sortOrder: index,
            effectiveFrom: line.effectiveFrom || null,
            effectiveTo: line.effectiveTo || null,
            scrapPct: line.scrapPct || null,
            ...(showManufacturing ? {
              operationSeq: line.operationSeq ? Number(line.operationSeq) : null,
              isByproduct: line.isByproduct !== 'false',outputCostWeight:line.isByproduct==='co_product'?line.outputCostWeight||null:null,
            } : {}),
          })),
        })
      if (requestRef.current?.body !== body) requestRef.current = {body,key:crypto.randomUUID()}
      const res = await fetch('/api/inventory/bom', {method:'PUT',headers:{'content-type':'application/json','Idempotency-Key':requestRef.current.key},body})
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
      const result = await res.json() as {changeId?:string;version?:string|null}
      setOriginalLines(lines)
      setReason('')
      if (result.changeId) {
        toast.success(tManufacturing('bomApproval.proposed'))
        router.push(`/accounting/changes?change=${encodeURIComponent(result.changeId)}`)
        router.refresh()
        return
      }
      setLoadedVersion(result.version ?? null)
      toast.success(creating ? tSetup('created') : tSetup('updated'))
      if (onSaved) {
        onSaved()
      } else {
        router.push('/inventory?inventoryView=bom')
      }
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
      closeHref={closeHref ?? '/inventory?inventoryView=bom'}
      stacked={stacked}
      beforeClose={closeGuard.beforeClose}
      size="2xl"
      title={tSetup('entities.bom-components.title')}
      description={tSetup('entities.bom-components.description')}
      headerActions={
        <Button disabled={busy || !detailReady || showManufacturing && (!canProposeRevision || !subsidiaryId)} onClick={save}>
          {busy ? tCommon('actions.saving') : showManufacturing ? tManufacturing('bomApproval.propose') : tCommon('actions.save')}
        </Button>
      }
    >
      <div className="space-y-5 p-1">
        {showManufacturing?<p className="text-sm text-slate-500">{tManufacturing('formula.help')}</p>:null}
        {saveError ? (
          <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            {saveError}
          </p>
        ) : null}
        {fixedAssemblyItemId ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {fixedAssemblyLabel ?? fixedAssemblyItemId}
          </p>
        ) : (
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
        )}
        {showManufacturing ? <div className="space-y-3 rounded-xl border border-teal-200 bg-teal-50/50 p-4 dark:border-teal-900 dark:bg-teal-950/20">
          <p className="text-sm">{tManufacturing('bomApproval.note')}</p>
          {!canProposeRevision ? <p role="status" className="text-sm text-amber-700">{tManufacturing('bomApproval.authority')}</p> : <div className="space-y-1.5"><Label>{tSetup('fields.subsidiaryId')} *</Label><SearchSelect value={subsidiaryId} onChange={setSubsidiaryId} options={subsidiaries.map(entity=>({value:entity.id,label:entity.name}))} disabled={busy} placeholder={tSetup('fields.subsidiaryId')} /></div>}
        </div> : null}
        <LineGrid
          columns={lineColumns}
          rows={lines}
          onRowsChange={setLines}
          readOnly={busy || !detailReady || showManufacturing && !canProposeRevision}
          emptyRow={() => editableLine(showManufacturing && today ? {effectiveFrom:today} : undefined)}
        />
        {showManufacturing?<p className="text-xs text-slate-500">{tInventory('bom.jointOutputNote')}</p>:null}
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
