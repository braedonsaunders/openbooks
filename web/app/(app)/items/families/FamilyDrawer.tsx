'use client'

import { useCallback, useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge, EmptyState } from '@openbooks/ui'
import { DrawerTabStrip } from '@/components/drawer-tab-strip'
import { familyTabFromParam, familyTabs, type FamilyTabKey } from './family-tabs'
import { apiJson } from '@/lib/api-error'
import { toast } from 'sonner'
import { FamilyOptionsEditor, type EditableOption } from './FamilyOptionsEditor'
import { FamilyVariantsGrid, type GridVariant } from './FamilyVariantsGrid'
import { ItemPriceMatrixEditor } from '../ItemPriceMatrixEditor'

interface FamilyDetail {
  id: string
  code: string
  name: string
  description: string | null
  category: string | null
  kind: string
  defaultUnit: string | null
  defaultRate: string | null
  status: 'active' | 'inactive'
  options: { id: string; name: string; position: number; values: string[] }[]
  variants: {
    id: string
    code: string | null
    name: string
    optionValues: Record<string, string>
    kind: string
    unit: string | null
    defaultRate: string | null
    defaultCost: string | null
    isActive: boolean
    onHand: string
    barcode: { value: string; kind: string } | null
  }[]
}

const VARIANT_KINDS = ['inventory', 'non_inventory', 'service', 'kit', 'assembly'] as const

/**
 * Drawer-chrome subtab strip for the family workspace. Rendered by the owning
 * page as the `UrlDrawer` `subtabs` node so the outer drawer shell stays
 * mounted while the operator moves between the variant matrix, pricing,
 * options and details — the same pattern item drawers use for `itemSetup`.
 */
export function FamilyDrawerSubtabs() {
  const t = useTranslations('items.families')
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const active = familyTabFromParam(searchParams.get('familyTab'))

  function selectTab(key: FamilyTabKey) {
    const next = new URLSearchParams(searchParams.toString())
    next.set('familyTab', key)
    const query = next.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }

  return (
    <DrawerTabStrip
      tabs={familyTabs().map((key) => ({
        key,
        label: key === 'details' ? t('defaults.title') : t(`${key}.title`),
      }))}
      activeKey={active}
      onSelect={selectTab}
      ariaLabel={t('drawerTitle')}
    />
  )
}

/**
 * One drawer shell through create, loading, detail, refusal and retry: the
 * header names the family once, and exactly one concept body is active at a
 * time — variants, pricing, options or details — chosen by `familyTab`.
 */
export function FamilyDrawer({ familyId, canManage }: { familyId: string; canManage: boolean }) {
  const t = useTranslations('items.families')
  const tCommon = useTranslations('common')
  const searchParams = useSearchParams()
  const activeTab = familyTabFromParam(searchParams.get('familyTab'))
  const [detail, setDetail] = useState<FamilyDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(familyId !== 'new')

  // Fetch chain rather than an async body: every state update sits in a
  // promise continuation, never synchronously in the effect that calls this.
  const load = useCallback(() => {
    if (familyId === 'new') return Promise.resolve()
    return apiJson<FamilyDetail>(`/api/item-families/${familyId}`).then(
      (next) => {
        setDetail(next)
        setError(null)
        setLoading(false)
      },
      (loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : String(loadError))
        setLoading(false)
      },
    )
  }, [familyId])

  useEffect(() => {
    void load()
  }, [load])

  if (familyId === 'new') return <CreateFamily />

  if (loading) return <p className="py-8 text-center text-sm text-slate-500">{tCommon('feedback.loading')}</p>
  if (error || !detail) {
    return (
      <EmptyState
        title={t('loadFailed')}
        description={error ?? t('notFound')}
        action={
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-md border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            {tCommon('actions.retry')}
          </button>
        }
      />
    )
  }

  const variantValues: Record<string, Record<string, number>> = {}
  for (const variant of detail.variants) {
    for (const [option, value] of Object.entries(variant.optionValues)) {
      variantValues[option] ??= {}
      variantValues[option]![value] = (variantValues[option]![value] ?? 0) + 1
    }
  }
  const gridVariants: GridVariant[] = detail.variants.map((variant) => ({
    id: variant.id,
    code: variant.code,
    name: variant.name,
    optionValues: variant.optionValues,
    price: variant.defaultRate,
    barcode: variant.barcode,
    onHand: variant.onHand,
    isActive: variant.isActive,
  }))

  return (
    <div className="space-y-7">
      <div>
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-sm text-slate-500">{detail.code}</span>
          <Badge variant={detail.status === 'active' ? 'success' : 'outline'}>
            {detail.status === 'active' ? tCommon('status.active') : tCommon('status.inactive')}
          </Badge>
        </div>
        <h2 className="mt-1 text-lg font-semibold">{detail.name}</h2>
        <p className="mt-1 text-sm text-slate-500">
          {t('summary', { options: detail.options.length, variants: detail.variants.length })}
        </p>
      </div>

      {activeTab === 'variants' ? (
        <section className="space-y-3">
          <div>
            <h3 className="text-base font-semibold">{t('variants.title')}</h3>
            <p className="mt-0.5 text-sm text-slate-500">{t('variants.description')}</p>
          </div>
          <FamilyVariantsGrid
            key={`${detail.id}:${detail.variants.length}`}
            familyId={detail.id}
            optionNames={detail.options.map((option) => option.name)}
            variants={gridVariants}
            familyRate={detail.defaultRate}
            canManage={canManage}
            onChanged={() => void load()}
          />
        </section>
      ) : null}

      {activeTab === 'pricing' ? (
        <section className="space-y-3">
          <div>
            <h3 className="text-base font-semibold">{t('pricing.title')}</h3>
            <p className="mt-0.5 text-sm text-slate-500">{t('pricing.description')}</p>
          </div>
          <ItemPriceMatrixEditor familyId={detail.id} canManage={canManage} />
        </section>
      ) : null}

      {activeTab === 'options' ? (
        <section className="space-y-3">
          <div>
            <h3 className="text-base font-semibold">{t('options.title')}</h3>
            <p className="mt-0.5 text-sm text-slate-500">{t('options.description')}</p>
          </div>
          <FamilyOptionsEditor
            key={detail.options.map((option) => option.id).join(',')}
            initial={detail.options.map((option) => ({ id: option.id, name: option.name, values: option.values }))}
            variantValues={variantValues}
            disabled={!canManage}
            onSave={async (options) => {
              try {
                await apiJson(`/api/item-families/${detail.id}/options`, {
                  method: 'PUT',
                  body: JSON.stringify({ options }),
                })
                toast.success(t('options.saved'))
                await load()
              } catch (saveError) {
                throw new Error(saveError instanceof Error ? saveError.message : String(saveError))
              }
            }}
          />
        </section>
      ) : null}

      {activeTab === 'details' ? (
        <section className="space-y-3">
          <div>
            <h3 className="text-base font-semibold">{t('defaults.title')}</h3>
            <p className="mt-0.5 text-sm text-slate-500">{t('defaults.description')}</p>
          </div>
          <DefaultsForm
            detail={detail}
            canManage={canManage}
            onSaved={() => void load()}
          />
        </section>
      ) : null}
    </div>
  )
}

function CreateFamily() {
  const t = useTranslations('items.families')
  const tItems = useTranslations('items')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [kind, setKind] = useState<string>('inventory')
  const [category, setCategory] = useState('')
  const [unit, setUnit] = useState('')
  const [rate, setRate] = useState('')
  const [options, setOptions] = useState<EditableOption[]>([{ id: null, name: '', values: [] }])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function create(): Promise<void> {
    setError(null)
    setBusy(true)
    try {
      const family = await apiJson<{ id: string }>(`/api/item-families`, {
        method: 'POST',
        body: JSON.stringify({
          code,
          name,
          kind,
          category: category === '' ? null : category,
          defaultUnit: unit === '' ? null : unit,
          defaultRate: rate === '' ? null : rate,
          options: options.map((option) => ({ name: option.name, values: option.values })),
        }),
      })
      toast.success(t('created'))
      router.replace(`/items/families?family=${family.id}`)
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-500">{t('createHint')}</p>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t('fields.code')}</span>
          <input type="text" value={code} onChange={(event) => setCode(event.target.value)} className="w-full rounded border border-slate-200 px-2 py-1.5 dark:border-slate-700 dark:bg-transparent" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{tCommon('labels.name')}</span>
          <input type="text" value={name} onChange={(event) => setName(event.target.value)} className="w-full rounded border border-slate-200 px-2 py-1.5 dark:border-slate-700 dark:bg-transparent" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{tItems('labels.kind')}</span>
          <select value={kind} onChange={(event) => setKind(event.target.value)} className="w-full rounded border border-slate-200 px-2 py-1.5 dark:border-slate-700 dark:bg-transparent">
            {VARIANT_KINDS.map((value) => (
              <option key={value} value={value}>{tItems(`kinds.${value}`)}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{tItems('labels.category')}</span>
          <input type="text" value={category} onChange={(event) => setCategory(event.target.value)} className="w-full rounded border border-slate-200 px-2 py-1.5 dark:border-slate-700 dark:bg-transparent" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{tItems('labels.unit')}</span>
          <input type="text" value={unit} onChange={(event) => setUnit(event.target.value)} className="w-full rounded border border-slate-200 px-2 py-1.5 dark:border-slate-700 dark:bg-transparent" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{tItems('labels.defaultRate')}</span>
          <input type="text" value={rate} onChange={(event) => setRate(event.target.value)} inputMode="decimal" className="w-full rounded border border-slate-200 px-2 py-1.5 dark:border-slate-700 dark:bg-transparent" />
        </label>
      </div>
      <FamilyOptionsEditor
        initial={options}
        variantValues={{}}
        onSave={async (next) => {
          setOptions(next.map((option) => ({ id: null, name: option.name, values: option.values.map((entry) => (typeof entry === 'string' ? entry : entry.value)) })))
        }}
      />
      {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
      <button
        type="button"
        disabled={busy}
        onClick={() => void create()}
        className="rounded-md bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
      >
        {busy ? t('creating') : t('create')}
      </button>
    </div>
  )
}

function DefaultsForm({ detail, canManage, onSaved }: { detail: FamilyDetail; canManage: boolean; onSaved: () => void }) {
  const t = useTranslations('items.families')
  const tItems = useTranslations('items')
  const tCommon = useTranslations('common')
  const [category, setCategory] = useState(detail.category ?? '')
  const [unit, setUnit] = useState(detail.defaultUnit ?? '')
  const [rate, setRate] = useState(detail.defaultRate ?? '')
  const [kind, setKind] = useState(detail.kind)
  const [status, setStatus] = useState(detail.status)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(): Promise<void> {
    setError(null)
    setBusy(true)
    try {
      await apiJson(`/api/item-families/${detail.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          category: category === '' ? null : category,
          defaultUnit: unit === '' ? null : unit,
          defaultRate: rate === '' ? null : rate,
          kind,
          status,
        }),
      })
      toast.success(t('defaults.saved'))
      onSaved()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">{t('defaults.description')}</p>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{tItems('labels.category')}</span>
          <input type="text" value={category} disabled={!canManage || busy} onChange={(event) => setCategory(event.target.value)} className="w-full rounded border border-slate-200 px-2 py-1.5 dark:border-slate-700 dark:bg-transparent" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{tItems('labels.unit')}</span>
          <input type="text" value={unit} disabled={!canManage || busy} onChange={(event) => setUnit(event.target.value)} className="w-full rounded border border-slate-200 px-2 py-1.5 dark:border-slate-700 dark:bg-transparent" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{tItems('labels.defaultRate')}</span>
          <input type="text" value={rate} disabled={!canManage || busy} onChange={(event) => setRate(event.target.value)} inputMode="decimal" className="w-full rounded border border-slate-200 px-2 py-1.5 dark:border-slate-700 dark:bg-transparent" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{tItems('labels.kind')}</span>
          <select value={kind} disabled={!canManage || busy} onChange={(event) => setKind(event.target.value)} className="w-full rounded border border-slate-200 px-2 py-1.5 dark:border-slate-700 dark:bg-transparent">
            {VARIANT_KINDS.map((value) => (
              <option key={value} value={value}>{tItems(`kinds.${value}`)}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t('fields.status')}</span>
          <select value={status} disabled={!canManage || busy} onChange={(event) => setStatus(event.target.value as 'active' | 'inactive')} className="w-full rounded border border-slate-200 px-2 py-1.5 dark:border-slate-700 dark:bg-transparent">
            <option value="active">{tCommon('status.active')}</option>
            <option value="inactive">{tCommon('status.inactive')}</option>
          </select>
        </label>
      </div>
      {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
      {canManage ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="rounded-md border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          {busy ? t('defaults.saving') : t('defaults.save')}
        </button>
      ) : null}
    </div>
  )
}
