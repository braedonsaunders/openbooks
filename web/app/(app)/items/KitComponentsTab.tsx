'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge, Button, EmptyState } from '@openbooks/ui'
import { readApiErrorMessage } from '@/lib/api-error'
import { BomDrawer, type BomAssembly, type BomComponent } from '../inventory/BomWorkspace'
import { LineGrid, type LineGridColumn } from '../../../components/line-grid'
import { componentLabel, effectiveWindowKind, isComponentIdentityMissing, strictIsCurrent, trimKitQty } from './kit-component-labels'

interface KitBomDetail {
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
 * A kit's Components tab: what the bundle contains. Everyday depth names the
 * components in plain words; editing reuses the bill-of-materials editor as
 * a stacked drawer so the operator never leaves the item. Per-warehouse
 * stock lives on the sibling Availability tab, never stacked below the
 * recipe.
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
        assemblyItemId?: string
        version?: string | null
        components?: (BomComponent & { code?: string | null; name?: string | null; isActive?: boolean | null; joinedId?: string | null; isCurrent?: boolean })[]
        validItems?: { id: string; code: string | null; name: string | null; unit: string | null }[]
      }
      // Identity comes with the line, not from the editor's eligible
      // choices: a component the picker would no longer offer still names
      // itself from its own catalog snapshot. Current-ness is strict: a
      // line without a real boolean flag makes the whole payload
      // unreadable, and the reader refuses instead of guessing current.
      const parsed = (bomBody.components ?? []).map((line) => ({ line, current: strictIsCurrent(line.isCurrent) }))
      if (parsed.some((entry) => entry.current === null)) {
        setLoadError(t('kit.loadFailed'))
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

  // The summary counts the recipe effective today, never expired windows:
  // history stays visible line by line below, each with its own window.
  const summary = useMemo(() => {
    if (loading || loadError || !bom) return null
    if (bom.components.length === 0) return t('kit.noRecipeSummary')
    const current = bom.components.filter((line) => line.isCurrent)
    if (current.length === 0) return t('kit.noCurrentRecipe')
    const parts = current.map((line) => `${trimKitQty(line.quantityPer)} ${line.label}`)
    return t('kit.recipeSummary', { count: current.length, parts: parts.join(' + ') })
  }, [bom, loading, loadError, t])

  // Rows key on the unique BOM line id, never the component: adjacent
  // effectivity windows repeat the same component, so component keys
  // duplicate and reconciliation clobbers one window with the other.
  const columns = useMemo<LineGridColumn<{ id: string; componentItemId: string; label: string; quantityPer: string; isActive: boolean | null; identityMissing: boolean; effectiveFrom: string | null; effectiveTo: string | null; caption: string | null }>[]>(
    () => [
      {
        key: 'label',
        label: t('kit.component'),
        width: 'minmax(200px,1fr)',
        type: 'readonly',
        // An inactive component stays on the recipe as evidence with its
        // status beside its name; a line with no joined catalog row keeps
        // its short storage id with the notice naming what happened to it.
        // A bounded window captions its dates so history is never mistaken
        // for double consumption.
        render: (row) => {
          const name = row.identityMissing ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              <span className="font-mono">{row.label}</span>
              <Badge variant="outline">{t('kit.unknownComponent')}</Badge>
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
        label: t('kit.perKit'),
        width: '130px',
        type: 'readonly',
        align: 'right',
        render: (row) => trimKitQty(row.quantityPer),
      },
    ],
    [t, tCommon],
  )

  if (loading) {
    return <p role="status" className="py-4 text-sm text-slate-600 dark:text-slate-300">{t('kit.loading')}</p>
  }
  if (loadError || !bom) {
    return (
      <div role="alert" className="space-y-3 py-4">
        <p className="text-sm text-red-700 dark:text-red-300">{loadError ?? t('kit.loadFailed')}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => { void load() }}>
          {tCommon('actions.retry')}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
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
            rows={bom.components.map((line) => {
              const kind = effectiveWindowKind({ from: line.effectiveFrom, to: line.effectiveTo })
              let caption: string | null = null
              if (kind === 'range' && line.effectiveFrom && line.effectiveTo) caption = t('kit.effectiveRange', { from: line.effectiveFrom, to: line.effectiveTo })
              else if (kind === 'from' && line.effectiveFrom) caption = t('kit.effectiveFrom', { from: line.effectiveFrom })
              else if (kind === 'ended' && line.effectiveTo) caption = t('kit.effectiveEnded', { to: line.effectiveTo })
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
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('kit.consequence')}</p>
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
