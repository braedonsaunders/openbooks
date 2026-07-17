'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Input, Label, SearchSelect, Select, UrlDrawer } from '@openbooks/ui'

interface ItemOpt { id: string; code?: string | null; name?: string | null }
interface LocOpt { id: string; code?: string | null }
interface AccountOpt { id: string; number?: string | null; name?: string | null }

const ACTIONS = ['receive', 'issue', 'adjust', 'transfer', 'build', 'landed'] as const
type Action = (typeof ACTIONS)[number]
const BASES = ['value', 'quantity'] as const

const field = 'space-y-1.5'

/**
 * Post an inventory movement — receive, issue, or adjust. Costing follows the
 * item's profile; the movement posts a balanced entry through the kernel.
 */
export function InventoryActionDrawer({
  items,
  stockLocations,
  accounts,
}: {
  items: ItemOpt[]
  stockLocations: LocOpt[]
  accounts: AccountOpt[]
}) {
  const t = useTranslations('inventory')
  const tCommon = useTranslations('common')
  const router = useRouter()

  const [action, setAction] = useState<Action>('receive')
  const [itemId, setItemId] = useState('')
  const [stockLocationId, setStockLocationId] = useState('')
  const [toStockLocationId, setToStockLocationId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [unitCost, setUnitCost] = useState('')
  const [offsetAccountId, setOffsetAccountId] = useState('')
  const [basis, setBasis] = useState<string>('value')
  const [memo, setMemo] = useState('')
  const [busy, setBusy] = useState(false)

  const itemOptions = items.map((i) => ({ value: i.id, label: `${i.code ? `${i.code} · ` : ''}${i.name ?? ''}`.trim() }))
  const locOptions = stockLocations.map((l) => ({ value: l.id, label: l.code ?? '' }))
  const accountOptions = accounts.map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() }))

  const needsCost = action === 'receive'
  const needsOffset = action === 'receive' || action === 'landed'
  const itemLabel = action === 'build' ? t('drawer.assemblyItem') : t('labels.item')
  const quantityLabel =
    action === 'landed' ? t('drawer.amount') : action === 'adjust' ? t('drawer.quantityDelta') : t('labels.quantity')
  const offsetLabel = action === 'landed' ? t('drawer.freightAccount') : t('drawer.offsetAccount')

  async function submit() {
    if (!itemId || !stockLocationId || !quantity) {
      toast.error(t('drawer.missingFields'))
      return
    }
    setBusy(true)
    const res = await fetch('/api/inventory/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action,
        itemId,
        stockLocationId,
        toStockLocationId: toStockLocationId || undefined,
        quantity,
        unitCost: unitCost || undefined,
        offsetAccountId: offsetAccountId || undefined,
        basis: action === 'landed' ? basis : undefined,
        memo: memo || undefined,
      }),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? t('drawer.failed'))
      setBusy(false)
      return
    }
    toast.success(t('drawer.posted', { value: data.value }))
    setBusy(false)
    router.push('/inventory')
    router.refresh()
  }

  return (
    <UrlDrawer
      open
      closeHref="/inventory"
      size="lg"
      title={t('drawer.title')}
      headerActions={
        <Button disabled={busy} onClick={submit}>
          {busy ? tCommon('actions.saving') : t('drawer.post')}
        </Button>
      }
    >
      <div className="space-y-5 p-1">
        <div className={field}>
          <Label>{t('drawer.action')}</Label>
          <Select value={action} onChange={(e) => setAction(e.target.value as Action)}>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {t(`drawer.actions.${a}`)}
              </option>
            ))}
          </Select>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t(`drawer.hint.${action}`)}</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className={field}>
            <Label>{itemLabel}<span className="text-red-500"> *</span></Label>
            <SearchSelect
              value={itemId}
              onChange={setItemId}
              options={itemOptions}
              placeholder={t('drawer.selectItem')}
              sheetTitle={itemLabel}
              ariaLabel={itemLabel}
            />
          </div>
          <div className={field}>
            <Label>{action === 'transfer' ? t('drawer.fromLocation') : t('labels.location')}<span className="text-red-500"> *</span></Label>
            <SearchSelect
              value={stockLocationId}
              onChange={setStockLocationId}
              options={locOptions}
              placeholder={t('drawer.selectLocation')}
              sheetTitle={t('labels.location')}
              ariaLabel={t('labels.location')}
            />
          </div>
          {action === 'transfer' ? (
            <div className={field}>
              <Label>{t('drawer.toLocation')}<span className="text-red-500"> *</span></Label>
              <SearchSelect
                value={toStockLocationId}
                onChange={setToStockLocationId}
                options={locOptions.filter((o) => o.value !== stockLocationId)}
                placeholder={t('drawer.selectLocation')}
                sheetTitle={t('drawer.toLocation')}
                ariaLabel={t('drawer.toLocation')}
              />
            </div>
          ) : null}
          <div className={field}>
            <Label>
              {quantityLabel}
              <span className="text-red-500"> *</span>
            </Label>
            <Input inputMode="decimal" className="text-right tabular-nums" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </div>
          {action === 'landed' ? (
            <div className={field}>
              <Label>{t('drawer.basis')}</Label>
              <Select value={basis} onChange={(e) => setBasis(e.target.value)}>
                {BASES.map((b) => (
                  <option key={b} value={b}>
                    {t(`drawer.bases.${b}`)}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          {needsCost || action === 'adjust' ? (
            <div className={field}>
              <Label>
                {t('labels.unitCost')}
                {needsCost ? <span className="text-red-500"> *</span> : null}
              </Label>
              <Input inputMode="decimal" className="text-right tabular-nums" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
            </div>
          ) : null}
          {needsOffset ? (
            <div className={`${field} sm:col-span-2`}>
              <Label>{offsetLabel}<span className="text-red-500"> *</span></Label>
              <SearchSelect
                value={offsetAccountId}
                onChange={setOffsetAccountId}
                options={accountOptions}
                placeholder={t('drawer.selectAccount')}
                sheetTitle={offsetLabel}
                ariaLabel={offsetLabel}
              />
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {action === 'landed' ? t('drawer.freightHint') : t('drawer.offsetHint')}
              </p>
            </div>
          ) : null}
          <div className={`${field} sm:col-span-2`}>
            <Label>{tCommon('labels.memo')}</Label>
            <Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder={t('drawer.memoPlaceholder')} />
          </div>
        </div>
      </div>
    </UrlDrawer>
  )
}
