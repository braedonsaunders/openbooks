'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge, Button, DisclosureSection, EmptyState } from '@openbooks/ui'
import { readApiErrorMessage } from '@/lib/api-error'
import { BomDrawer, type BomAssembly, type BomComponent } from '../inventory/BomWorkspace'
import { LineGrid, type LineGridColumn } from '../../../components/line-grid'

interface KitAvailabilityComponent {
  itemId: string
  itemLabel: string
  onHand: string
  committed: string
  available: string
}

interface KitAvailability {
  itemId: string
  allLocations: {
    kit: { itemId: string; itemLabel: string; onHand: string; committed: string; available: string } | null
    components: (KitAvailabilityComponent | null)[]
  }
  warehouses: {
    warehouseId: string
    warehouseCode: string
    kit: { itemId: string; itemLabel: string; onHand: string; committed: string; available: string } | null
    components: (KitAvailabilityComponent | null)[]
  }[]
}

interface KitBomDetail {
  assemblyItemId: string
  version: string | null
  components: (BomComponent & { label: string })[]
}

const trimQty = (quantity: string) => quantity.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')

/**
 * A kit's Components tab: what the bundle contains and what it can still
 * sell. Everyday depth names the components and the available kits in plain
 * words; editing reuses the bill-of-materials editor as a stacked drawer so
 * the operator never leaves the item; per-warehouse stock sits one
 * deliberate click away in the availability disclosure.
 */
export function KitComponentsTab({
  itemId,
  itemLabel,
  canManage,
  tabHref,
  editing,
}: {
  itemId: string
  itemLabel: string
  canManage: boolean
  /** This tab's own URL; the editor opens and closes by adding or dropping
   *  `kitBom=edit` on it (the house pattern for in-context editing), so
   *  closing unmounts the overlay after its exit animation. */
  tabHref: string
  editing: boolean
}) {
  const t = useTranslations('items')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [bom, setBom] = useState<KitBomDetail | null>(null)
  const [bomVersion, setBomVersion] = useState<string | null>(null)
  const [validItems, setValidItems] = useState<{ id: string; code: string | null; name: string | null }[]>([])
  const [availability, setAvailability] = useState<KitAvailability | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const bomRes = await fetch(`/api/inventory/bom?assemblyItemId=${encodeURIComponent(itemId)}`, { cache: 'no-store' })
      if (!bomRes.ok) {
        setLoadError(await readApiErrorMessage(bomRes, t('kit.loadFailed')))
        setLoading(false)
        return
      }
      const bomBody = (await bomRes.json()) as {
        assemblyItemId: string
        version?: string | null
        components?: BomComponent[]
        validItems?: { id: string; code: string | null; name: string | null; unit: string | null }[]
      }
      const labels = new Map((bomBody.validItems ?? []).map((item) => [item.id, item]))
      setBom({
        assemblyItemId: bomBody.assemblyItemId,
        version: bomBody.version ?? null,
        components: (bomBody.components ?? []).map((line) => ({
          ...line,
          label: labels.get(line.componentItemId)?.name ?? line.componentItemId,
        })),
      })
      setBomVersion(bomBody.version ?? null)
      setValidItems(bomBody.validItems ?? [])
      const atpRes = await fetch(`/api/items/${encodeURIComponent(itemId)}/kit-availability`, { cache: 'no-store' })
      if (!atpRes.ok) {
        setLoadError(await readApiErrorMessage(atpRes, t('kit.loadFailed')))
        setLoading(false)
        return
      }
      setAvailability((await atpRes.json()) as KitAvailability)
    } catch {
      setLoadError(t('kit.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [itemId, t])

  useEffect(() => {
    queueMicrotask(() => { void load() })
  }, [load])

  const assembly: BomAssembly | null = useMemo(() => {
    if (!bom) return null
    return {
      assemblyItemId: bom.assemblyItemId,
      assemblyCode: null,
      assemblyName: itemLabel,
      componentCount: bom.components.length,
      version: bomVersion ?? '',
      components: bom.components,
    }
  }, [bom, bomVersion, itemLabel])

  const available = availability?.allLocations.kit?.available
  const summary = useMemo(() => {
    if (loading || loadError || !bom) return null
    if (bom.components.length === 0) return t('kit.noRecipeSummary')
    const parts = bom.components.map((line) => `${trimQty(line.quantityPer)} ${line.label}`)
    return t('kit.recipeSummary', { count: bom.components.length, parts: parts.join(' + ') })
  }, [bom, loading, loadError, t])

  const columns = useMemo<LineGridColumn<{ componentItemId: string; label: string; quantityPer: string }>[]>(
    () => [
      { key: 'label', label: t('kit.component'), width: 'minmax(200px,1fr)', type: 'readonly' },
      {
        key: 'quantityPer',
        label: t('kit.perKit'),
        width: '130px',
        type: 'readonly',
        align: 'right',
        render: (row) => trimQty(row.quantityPer),
      },
    ],
    [t],
  )

  const availabilityRows = useMemo(() => {
    if (!availability) return []
    return availability.warehouses.flatMap((warehouse) =>
      (warehouse.kit ? [{ warehouse: warehouse.warehouseCode, ...warehouse.kit }] : []).concat(
        warehouse.components
          .filter((component) => component !== null)
          .map((component) => ({ warehouse: warehouse.warehouseCode, ...component! })),
      ),
    )
  }, [availability])

  const availabilityColumns = useMemo<LineGridColumn<{ warehouse: string; itemLabel: string; onHand: string; committed: string; available: string }>[]>(
    () => [
      { key: 'warehouse', label: tCommon('labels.warehouse'), width: '110px', type: 'readonly' },
      { key: 'itemLabel', label: tCommon('labels.item'), width: 'minmax(170px,1fr)', type: 'readonly' },
      { key: 'onHand', label: t('kit.onHand'), width: '100px', type: 'readonly', align: 'right', render: (row) => trimQty(row.onHand) },
      { key: 'committed', label: t('kit.committed'), width: '100px', type: 'readonly', align: 'right', render: (row) => trimQty(row.committed) },
      { key: 'available', label: t('kit.available'), width: '100px', type: 'readonly', align: 'right', render: (row) => trimQty(row.available) },
    ],
    [t, tCommon],
  )

  if (loading) {
    return <p role="status" className="py-4 text-sm text-slate-600 dark:text-slate-300">{t('kit.loading')}</p>
  }
  if (loadError || !bom) {
    return <p role="alert" className="py-4 text-sm text-red-700 dark:text-red-300">{loadError ?? t('kit.loadFailed')}</p>
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {available !== undefined ? (
          <Badge variant={bom.components.length === 0 ? 'secondary' : 'success'}>
            {t('kit.availableBadge', { count: trimQty(available) })}
          </Badge>
        ) : null}
        <span className="text-sm text-slate-600 dark:text-slate-300">{summary}</span>
        <span className="flex-1" />
        {canManage ? (
          <Button type="button" variant="outline" size="sm" onClick={() => router.push(`${tabHref}&kitBom=edit`, { scroll: false })}>
            {bom.components.length === 0 ? t('kit.addComponents') : t('kit.editComponents')}
          </Button>
        ) : null}
      </div>
      {bom.components.length === 0 ? (
        <EmptyState
          title={t('kit.emptyTitle')}
          description={t('kit.emptyDescription')}
          action={canManage ? (
            <Button type="button" size="sm" onClick={() => router.push(`${tabHref}&kitBom=edit`, { scroll: false })}>
              {t('kit.addComponents')}
            </Button>
          ) : undefined}
        />
      ) : (
        <>
          <LineGrid
            columns={columns}
            rows={bom.components.map((line) => ({
              componentItemId: line.componentItemId,
              label: line.label,
              quantityPer: line.quantityPer,
            }))}
            onRowsChange={() => undefined}
            emptyRow={() => ({ componentItemId: '', label: '', quantityPer: '' })}
            getRowKey={(row) => row.componentItemId}
            readOnly
          />
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('kit.consequence')}</p>
        </>
      )}
      {availability && (availability.allLocations.kit || availability.warehouses.length > 0) ? (
        <DisclosureSection
          title={t('kit.availabilityTitle')}
          summary={available !== undefined ? t('kit.availabilitySummary', { count: trimQty(available) }) : undefined}
        >
          <LineGrid
            columns={availabilityColumns}
            rows={availabilityRows}
            onRowsChange={() => undefined}
            emptyRow={() => ({ warehouse: '', itemLabel: '', onHand: '', committed: '', available: '' })}
            getRowKey={(row) => `${row.warehouse}:${row.itemLabel}`}
            readOnly
          />
        </DisclosureSection>
      ) : null}
      {editing && assembly ? (
        <BomDrawer
          key={assembly.version}
          assembly={assembly}
          assemblies={[]}
          items={validItems}
          fixedAssemblyItemId={itemId}
          fixedAssemblyLabel={itemLabel}
          closeHref={tabHref}
          stacked
          hideManufacturingFields
          onSaved={() => {
            router.push(tabHref, { scroll: false })
            router.refresh()
            void load()
          }}
        />
      ) : null}
    </div>
  )
}
