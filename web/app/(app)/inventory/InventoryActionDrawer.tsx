'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Input, Label, SearchSelect, Select, UrlDrawer } from '@openbooks/ui'

interface ItemOpt { id: string; code?: string | null; name?: string | null }
interface LocOpt { id: string; code?: string | null }
interface AccountOpt { id: string; number?: string | null; name?: string | null }

const ACTIONS = ['receive', 'issue', 'adjust'] as const
type Action = (typeof ACTIONS)[number]

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
  const [quantity, setQuantity] = useState('')
  const [unitCost, setUnitCost] = useState('')
  const [offsetAccountId, setOffsetAccountId] = useState('')
  const [memo, setMemo] = useState('')
  const [busy, setBusy] = useState(false)

  const itemOptions = items.map((i) => ({ value: i.id, label: `${i.code ? `${i.code} · ` : ''}${i.name ?? ''}`.trim() }))
  const locOptions = stockLocations.map((l) => ({ value: l.id, label: l.code ?? '' }))
  const accountOptions = accounts.map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() }))

  const needsCost = action === 'receive'
  const needsOffset = action === 'receive'

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
        quantity,
        unitCost: unitCost || undefined,
        offsetAccountId: offsetAccountId || undefined,
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
            <Label>{t('labels.item')}<span className="text-red-500"> *</span></Label>
            <SearchSelect
              value={itemId}
              onChange={setItemId}
              options={itemOptions}
              placeholder={t('drawer.selectItem')}
              sheetTitle={t('labels.item')}
              ariaLabel={t('labels.item')}
            />
          </div>
          <div className={field}>
            <Label>{t('labels.location')}<span className="text-red-500"> *</span></Label>
            <SearchSelect
              value={stockLocationId}
              onChange={setStockLocationId}
              options={locOptions}
              placeholder={t('drawer.selectLocation')}
              sheetTitle={t('labels.location')}
              ariaLabel={t('labels.location')}
            />
          </div>
          <div className={field}>
            <Label>
              {action === 'adjust' ? t('drawer.quantityDelta') : t('labels.quantity')}
              <span className="text-red-500"> *</span>
            </Label>
            <Input inputMode="decimal" className="text-right tabular-nums" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </div>
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
              <Label>{t('drawer.offsetAccount')}<span className="text-red-500"> *</span></Label>
              <SearchSelect
                value={offsetAccountId}
                onChange={setOffsetAccountId}
                options={accountOptions}
                placeholder={t('drawer.selectAccount')}
                sheetTitle={t('drawer.offsetAccount')}
                ariaLabel={t('drawer.offsetAccount')}
              />
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('drawer.offsetHint')}</p>
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
