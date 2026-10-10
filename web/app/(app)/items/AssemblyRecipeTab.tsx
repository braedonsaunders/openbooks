'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge, Button, EmptyState } from '@openbooks/ui'
import { readApiErrorMessage } from '@/lib/api-error'
import { BomDrawer, type BomAssembly, type BomComponent } from '../inventory/BomWorkspace'
import { LineGrid, type LineGridColumn } from '../../../components/line-grid'
import { componentLabel, effectiveWindowKind, isComponentIdentityMissing, strictIsCurrent, trimKitQty } from './kit-component-labels'

interface AssemblyBomDetail {
  assemblyItemId: string
  version: string | null
  components: (BomComponent & {
    label: string
    code: string | null
    name: string | null
    isActive: boolean | null
    identityMissing: boolean
    isCurrent: boolean
  })[]
}

/**
 * An assembly's Recipe tab: what manufacturing builds the finished item
 * from. Reads like the kit Components tab, but the editor keeps the
 * manufacturing recipe columns (operations, by-products, formula and batch
 * quantities) because assembly revisions approve through manufacturing, not
 * the kit direct save. An assembly without an inventory costing profile
 * cannot stage a recipe the save would keep, so the tab names that
 * prerequisite instead of offering an editor that could only be refused.
 */
export function AssemblyRecipeTab({
  itemId,
  itemLabel,
  canManage,
  tabHref,
  editing,
  hasCostingProfile,
}: {
  itemId: string
  itemLabel: string
  canManage: boolean
  /** This tab's own URL; the editor opens and closes by adding or dropping
   *  `assemblyBom=edit` on it (the house pattern for in-context editing). */
  tabHref: string
  editing: boolean
  /** Whether the item holds an inventory costing profile. Without one the
   *  tab explains the prerequisite instead of loading a recipe. */
  hasCostingProfile: boolean
}) {
  const t = useTranslations('items')
  const tCommon = useTranslations('common')
  const tInventory = useTranslations('inventory')
  const router = useRouter()
  const [bom, setBom] = useState<AssemblyBomDetail | null>(null)
  const [bomVersion, setBomVersion] = useState<string | null>(null)
  const [validItems, setValidItems] = useState<{ id: string; code: string | null; name: string | null }[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(hasCostingProfile)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const bomRes = await fetch(`/api/inventory/bom?assemblyItemId=${encodeURIComponent(itemId)}`, { cache: 'no-store' })
      if (!bomRes.ok) {
        setLoadError(await readApiErrorMessage(bomRes, t('assembly.loadFailed')))
        setLoading(false)
        return
      }
      const bomBody = (await bomRes.json()) as {
        assemblyItemId?: string
        version?: string | null
        components?: (BomComponent & { code?: string | null; name?: string | null; isActive?: boolean | null; joinedId?: string | null; isCurrent?: boolean })[]
        validItems?: { id: string; code: string | null; name: string | null; unit: string | null }[]
      }
      const parsed = (bomBody.components ?? []).map((line) => ({ line, current: strictIsCurrent(line.isCurrent) }))
      if (parsed.some((entry) => entry.current === null)) {
        setLoadError(t('assembly.loadFailed'))
        setLoading(false)
        return
      }
      setBom({
        assemblyItemId: bomBody.assemblyItemId ?? itemId,
        version: bomBody.version ?? null,
        components: parsed.map(({ line, current }) => ({
          ...line,
          code: line.code ?? null,
          name: line.name ?? null,
          isActive: line.isActive ?? null,
          label: componentLabel({
            componentItemId: line.componentItemId,
            code: line.code ?? null,
            name: line.name ?? null,
          }),
          identityMissing: isComponentIdentityMissing(line.joinedId ?? null),
          isCurrent: current === true,
        })),
      })
      setBomVersion(bomBody.version ?? null)
      setValidItems(bomBody.validItems ?? [])
    } catch {
      setLoadError(t('assembly.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [itemId, t])

  useEffect(() => {
    if (!hasCostingProfile) return
    queueMicrotask(() => { void load() })
  }, [hasCostingProfile, load])

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

  const columns = useMemo<LineGridColumn<{ id: string; componentItemId: string; label: string; quantityPer: string; isActive: boolean | null; identityMissing: boolean; effectiveFrom: string | null; effectiveTo: string | null; caption: string | null }>[]>(
    () => [
      {
        key: 'label',
        label: tInventory('bom.values.component'),
        width: 'minmax(200px,1fr)',
        type: 'readonly',
        render: (row) => {
          const name = row.identityMissing ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              <span className="font-mono">{row.label}</span>
              <Badge variant="outline">{t('assembly.unknownComponent')}</Badge>
            </span>
          ) : row.isActive === false ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              <span>{row.label}</span>
              <Badge variant="secondary">{tCommon('status.inactive')}</Badge>
            </span>
          ) : row.label
          return (
            <span>
              <span>{name}</span>
              {row.caption ? <span className="block text-xs text-slate-500 dark:text-slate-400">{row.caption}</span> : null}
            </span>
          )
        },
      },
      {
        key: 'quantityPer',
        label: tInventory('labels.quantity'),
        width: '130px',
        type: 'readonly',
        align: 'right',
        render: (row) => trimKitQty(row.quantityPer),
      },
    ],
    [tCommon, tInventory],
  )

  if (!hasCostingProfile) {
    return (
      <p role="note" className="rounded-lg border border-dashed border-slate-300 px-3 py-5 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
        {t('assembly.needsCosting')}
      </p>
    )
  }

  if (loading) {
    return <p role="status" className="py-4 text-sm text-slate-600 dark:text-slate-300">{t('assembly.loading')}</p>
  }
  if (loadError || !bom) {
    return (
      <div role="alert" className="space-y-3 py-4">
        <p className="text-sm text-red-700 dark:text-red-300">{loadError ?? t('assembly.loadFailed')}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => { void load() }}>
          {tCommon('actions.retry')}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1" />
        {canManage ? (
          <Button type="button" variant="outline" size="sm" onClick={() => router.push(`${tabHref}&assemblyBom=edit`, { scroll: false })}>
            {bom.components.length === 0 ? t('assembly.addRecipe') : t('assembly.editRecipe')}
          </Button>
        ) : null}
      </div>
      {bom.components.length === 0 ? (
        <EmptyState
          title={t('assembly.emptyTitle')}
          description={t('assembly.emptyDescription')}
          action={canManage ? (
            <Button type="button" size="sm" onClick={() => router.push(`${tabHref}&assemblyBom=edit`, { scroll: false })}>
              {t('assembly.addRecipe')}
            </Button>
          ) : undefined}
        />
      ) : (
        <>
          {bom.components.length > 0 && !bom.components.some((line) => line.isCurrent) ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('assembly.noCurrentRecipe')}</p>
          ) : null}
          <LineGrid
          columns={columns}
          rows={bom.components.map((line) => {
            const kind = effectiveWindowKind({ from: line.effectiveFrom, to: line.effectiveTo })
            let caption: string | null = null
            if (kind === 'range' && line.effectiveFrom && line.effectiveTo) caption = t('assembly.effectiveRange', { from: line.effectiveFrom, to: line.effectiveTo })
            else if (kind === 'from' && line.effectiveFrom) caption = t('assembly.effectiveFrom', { from: line.effectiveFrom })
            else if (kind === 'ended' && line.effectiveTo) caption = t('assembly.effectiveEnded', { to: line.effectiveTo })
            return {
              id: line.id,
              componentItemId: line.componentItemId,
              label: line.label,
              quantityPer: line.quantityPer,
              isActive: line.isActive,
              identityMissing: line.identityMissing,
              effectiveFrom: line.effectiveFrom,
              effectiveTo: line.effectiveTo,
              caption,
            }
          })}
          onRowsChange={() => undefined}
          emptyRow={() => ({ id: '', componentItemId: '', label: '', quantityPer: '', isActive: null, identityMissing: false, effectiveFrom: null, effectiveTo: null, caption: null })}
          getRowKey={(row) => row.id}
          readOnly
        />
        </>
      )}
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
