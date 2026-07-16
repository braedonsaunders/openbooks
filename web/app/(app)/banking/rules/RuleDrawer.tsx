'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus, Trash2, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button, Drawer, Input, Label, Select, UrlDrawer } from '@openbooks/ui'

interface AccountOpt {
  id: string
  label: string
}

export function NewRuleButton() {
  const t = useTranslations('banking.rules')
  const router = useRouter()
  return (
    <Button onClick={() => router.push('/banking/rules?rule=new')}>
      <Plus size={15} /> {t('newRule')}
    </Button>
  )
}

/** Pick a reconcilable account and run active rules against its unmatched lines. */
export function RunRulesButton({ accounts }: { accounts: AccountOpt[] }) {
  const t = useTranslations('banking.rules')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [busy, setBusy] = useState(false)

  async function run() {
    if (!accountId) return
    setBusy(true)
    try {
      const res = await fetch('/api/banking/rules/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? t('runFailed'))
        return
      }
      if (data.matched === 0 && data.excluded === 0) {
        toast.info(t('runNoneMatched', { scanned: data.scanned }))
      } else {
        toast.success(t('runDone', { matched: data.matched, excluded: data.excluded }))
      }
      setOpen(false)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} disabled={accounts.length === 0}>
        <Wand2 size={15} /> {t('runRules')}
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        size="sm"
        title={t('runTitle')}
        description={t('runDescription')}
        headerActions={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>{tCommon('actions.cancel')}</Button>
            <Button disabled={busy || !accountId} onClick={run}>
              {busy ? tCommon('actions.running') : t('runRules')}
            </Button>
          </>
        }
      >
        <div className="space-y-1.5 p-1">
          <Label>{tCommon('labels.account')}</Label>
          <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </Select>
        </div>
      </Drawer>
    </>
  )
}

export function RuleDrawer({ rule, accounts }: { rule: Record<string, any> | null; accounts: AccountOpt[] }) {
  const t = useTranslations('banking.rules')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const creating = !rule
  const c = rule?.criteria ?? {}
  const o = rule?.outcome ?? {}

  const [name, setName] = useState<string>(rule?.name ?? '')
  const [priority, setPriority] = useState<string>(String(rule?.priority ?? 100))
  const [isActive, setIsActive] = useState<boolean>(rule?.is_active ?? true)
  const [descriptionContains, setDescriptionContains] = useState<string>(c.descriptionContains ?? '')
  const [amountSign, setAmountSign] = useState<string>(c.amountSign ?? 'any')
  const [minAmount, setMinAmount] = useState<string>(c.minAmount != null ? String(c.minAmount) : '')
  const [maxAmount, setMaxAmount] = useState<string>(c.maxAmount != null ? String(c.maxAmount) : '')
  const [action, setAction] = useState<string>(o.action ?? 'categorize')
  const [accountId, setAccountId] = useState<string>(o.accountId ?? accounts[0]?.id ?? '')
  const [busy, setBusy] = useState(false)

  const closeHref = '/banking/rules'

  async function save() {
    setBusy(true)
    const res = await fetch('/api/banking/rules', {
      method: creating ? 'POST' : 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: rule?.id,
        name,
        priority: Number(priority) || 100,
        isActive,
        criteria: {
          descriptionContains: descriptionContains.trim() || undefined,
          amountSign,
          minAmount: minAmount.trim() || undefined,
          maxAmount: maxAmount.trim() || undefined,
        },
        outcome: action === 'exclude' ? { action: 'exclude' } : { action: 'categorize', accountId },
      }),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? t('saveFailed'))
      setBusy(false)
      return
    }
    toast.success(creating ? t('created') : t('saved'))
    router.push(closeHref)
    router.refresh()
  }

  async function remove() {
    if (!rule?.id) return
    if (!confirm(t('deleteConfirm'))) return
    setBusy(true)
    const res = await fetch(`/api/banking/rules/${rule.id}`, { method: 'DELETE' })
    if (!res.ok) {
      const data = await res.json()
      toast.error(data.error ?? t('deleteFailed'))
      setBusy(false)
      return
    }
    toast.success(t('deleted'))
    router.push(closeHref)
    router.refresh()
  }

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="md"
      title={creating ? t('newTitle') : rule!.name}
      description={t('drawerDescription')}
      headerActions={
        <>
          {!creating && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={remove} className="text-red-600 hover:text-red-700 dark:text-red-400">
              <Trash2 size={14} /> {tCommon('actions.delete')}
            </Button>
          )}
          <Button disabled={busy || !name.trim() || (action === 'categorize' && !accountId)} onClick={save}>
            {busy ? tCommon('actions.saving') : creating ? t('createRule') : tCommon('actions.save')}
          </Button>
        </>
      }
      footer={
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
          />
          {tCommon('labels.active')}
        </label>
      }
    >
      <div className="space-y-5 p-1">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{tCommon('labels.name')}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('priority')}</Label>
            <Input inputMode="numeric" value={priority} onChange={(e) => setPriority(e.target.value)} />
          </div>
        </div>

        <fieldset className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <legend className="px-1 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{t('whenLegend')}</legend>
          <div className="space-y-1.5">
            <Label>{t('descriptionContains')}</Label>
            <Input value={descriptionContains} onChange={(e) => setDescriptionContains(e.target.value)} placeholder={t('descriptionPlaceholder')} />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>{t('amountSign')}</Label>
              <Select value={amountSign} onChange={(e) => setAmountSign(e.target.value)}>
                <option value="any">{t('signAny')}</option>
                <option value="in">{t('signIn')}</option>
                <option value="out">{t('signOut')}</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('minAmount')}</Label>
              <Input inputMode="decimal" value={minAmount} onChange={(e) => setMinAmount(e.target.value)} placeholder={t('optional')} className="text-right tabular-nums" />
            </div>
            <div className="space-y-1.5">
              <Label>{t('maxAmount')}</Label>
              <Input inputMode="decimal" value={maxAmount} onChange={(e) => setMaxAmount(e.target.value)} placeholder={t('optional')} className="text-right tabular-nums" />
            </div>
          </div>
        </fieldset>

        <fieldset className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <legend className="px-1 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{t('thenLegend')}</legend>
          <div className="space-y-1.5">
            <Label>{t('action')}</Label>
            <Select value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="categorize">{t('actionCategorize')}</option>
              <option value="exclude">{t('actionExclude')}</option>
            </Select>
          </div>
          {action === 'categorize' ? (
            <div className="space-y-1.5">
              <Label>{t('offsetAccount')}</Label>
              <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </Select>
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('offsetHint')}</p>
            </div>
          ) : (
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('excludeHint')}</p>
          )}
        </fieldset>
      </div>
    </UrlDrawer>
  )
}
