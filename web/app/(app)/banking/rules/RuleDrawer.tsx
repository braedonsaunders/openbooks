'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Ban, Bolt, Eye, Plus, Trash2, Wand2, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Drawer, Input, Label, Select, SearchSelect, UrlDrawer, cn } from '@openbooks/ui'
import { ConditionBuilder } from '../../../../components/conditions/ConditionBuilder'
import { SplitLinesEditor, type AllocationLine, type CodingConfig } from '../../../../components/allocations/SplitLinesEditor'
import { LivePreview } from '../../../../components/live-preview/LivePreview'
import type { ConditionGroup, FieldDef } from '../../../../lib/conditions'
import { money } from '../../../../lib/format'

interface Opt {
  value: string
  label: string
}
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
      if (data.matched === 0 && data.excluded === 0 && data.suggested === 0) {
        toast.info(t('runNoneMatched', { scanned: data.scanned }))
      } else {
        toast.success(t('runDone', { matched: data.matched, excluded: data.excluded }))
        if (data.suggested > 0) toast.info(t('runSuggested', { suggested: data.suggested }))
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

type PreviewData = {
  scanned: number
  matched: number
  conflicts: number
  matches: {
    lineId: string
    posted_on: string
    amount: string
    description: string | null
    counterparty_ref: string | null
    stolenBy?: string | null
    splitPreview?: { accountId: string; amount: string }[]
  }[]
}

export function RuleDrawer({
  rule,
  accounts,
  reconAccounts,
  departments,
  locations,
  classes,
  taxCodes,
  parties,
  seedFromLine,
}: {
  rule: Record<string, any> | null
  accounts: Opt[]
  reconAccounts: AccountOpt[]
  departments: Opt[]
  locations: Opt[]
  classes: Opt[]
  taxCodes: Opt[]
  parties: Opt[]
  seedFromLine?: { description?: string | null; amount?: string | null } | null
}) {
  const t = useTranslations('banking.rules')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const creating = !rule

  // Field catalog for the condition builder (localized).
  const catalog: FieldDef[] = useMemo(
    () => [
      { key: 'description', label: t('fields.description'), kind: 'text', placeholder: t('descriptionPlaceholder') },
      { key: 'payee', label: t('fields.payee'), kind: 'text' },
      { key: 'anyText', label: t('fields.anyText'), kind: 'text' },
      { key: 'reference', label: t('fields.reference'), kind: 'text' },
      { key: 'amount', label: t('fields.amount'), kind: 'number' },
      {
        key: 'flow',
        label: t('fields.flow'),
        kind: 'flow',
        options: [
          { value: 'in', label: t('signIn') },
          { value: 'out', label: t('signOut') },
        ],
      },
      { key: 'date', label: t('fields.date'), kind: 'date' },
    ],
    [t],
  )
  const operatorLabels = useMemo(
    () =>
      Object.fromEntries(
        (
          [
            'contains', 'notContains', 'equals', 'startsWith', 'endsWith', 'isBlank',
            'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'is', 'on', 'before', 'after', 'withinDays',
          ] as const
        ).map((k) => [k, t(`ops.${k}`)]),
      ),
    [t],
  )

  // ---- initial state (v2, or migrated from a v1 rule) -----------------------
  const initial = useMemo(() => migrateRule(rule, seedFromLine), [rule, seedFromLine])

  const [name, setName] = useState(initial.name)
  const [priority, setPriority] = useState(String(initial.priority))
  const [isActive, setIsActive] = useState(initial.isActive)
  const [scope, setScope] = useState<string[]>(initial.accountScope)
  const [group, setGroup] = useState<ConditionGroup>(initial.match)
  const [action, setAction] = useState<'categorize' | 'exclude'>(initial.action)
  const [mode, setMode] = useState<'auto' | 'suggest'>(initial.mode)
  const [lines, setLines] = useState<AllocationLine[]>(initial.lines)
  const [partyId, setPartyId] = useState(initial.partyId)
  const [memo, setMemo] = useState(initial.memo)
  const [previewAccount, setPreviewAccount] = useState(reconAccounts[0]?.id ?? '')
  const [busy, setBusy] = useState(false)

  const closeHref = '/banking/rules'

  const codings: CodingConfig[] = useMemo(() => {
    const c: CodingConfig[] = []
    if (departments.length) c.push({ key: 'department', label: t('coding.department'), options: departments })
    if (locations.length) c.push({ key: 'location', label: t('coding.location'), options: locations })
    if (classes.length) c.push({ key: 'class', label: t('coding.class'), options: classes })
    if (taxCodes.length) c.push({ key: 'tax', label: t('coding.tax'), options: taxCodes })
    return c
  }, [departments, locations, classes, taxCodes, t])

  const accountName = (id: string) => accounts.find((a) => a.value === id)?.label ?? id

  const draftBody = useMemo(
    () => ({
      criteria: { version: 2, match: group, accountScope: scope.length ? scope : undefined },
      outcome:
        action === 'exclude'
          ? { action: 'exclude' }
          : { action: 'categorize', version: 2, mode, lines: serializeLines(lines), partyId: partyId || undefined, memo: memo || undefined },
      priority: Number(priority) || 100,
      id: rule?.id,
    }),
    [group, scope, action, mode, lines, partyId, memo, priority, rule?.id],
  )

  async function save() {
    setBusy(true)
    const res = await fetch('/api/banking/rules', {
      method: creating ? 'POST' : 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, isActive, ...draftBody }),
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

  const canSave = name.trim() !== '' && group.rules.length > 0 && (action === 'exclude' || lines.some((l) => l.accountId))

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="xl"
      title={creating ? t('newTitle') : rule!.name}
      description={t('drawerDescription')}
      headerActions={
        <>
          {!creating && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={remove} className="text-red-600 hover:text-red-700 dark:text-red-400">
              <Trash2 size={14} /> {tCommon('actions.delete')}
            </Button>
          )}
          <Button disabled={busy || !canSave} onClick={save}>
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
      <div className="grid gap-5 p-1 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* ---- builder column ---- */}
        <div className="space-y-5">
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

          <div className="space-y-1.5">
            <Label>{t('scope.label')}</Label>
            <div className="flex flex-wrap gap-1.5">
              {reconAccounts.map((a) => {
                const on = scope.includes(a.id)
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setScope((s) => (on ? s.filter((x) => x !== a.id) : [...s, a.id]))}
                    className={cn(
                      'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                      on
                        ? 'border-teal-500 bg-teal-50 text-teal-700 dark:border-teal-500 dark:bg-teal-950/40 dark:text-teal-300'
                        : 'border-slate-200 text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:text-slate-300',
                    )}
                  >
                    {a.label}
                  </button>
                )
              })}
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">{scope.length === 0 ? t('scope.allHint') : t('scope.someHint', { count: scope.length })}</p>
          </div>

          <fieldset className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <legend className="px-1 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{t('whenLegend')}</legend>
            <ConditionBuilder
              catalog={catalog}
              group={group}
              onChange={setGroup}
              operatorLabels={operatorLabels}
              labels={{
                match: t('cb.match'),
                allOf: t('cb.allOf'),
                anyOf: t('cb.anyOf'),
                addCondition: t('cb.addCondition'),
                addGroup: t('cb.addGroup'),
                noConditions: t('cb.noConditions'),
                remove: t('cb.remove'),
                valuePlaceholder: t('cb.valuePlaceholder'),
                andJoin: t('cb.and'),
                toJoin: t('cb.to'),
              }}
            />
          </fieldset>

          <fieldset className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <legend className="px-1 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{t('thenLegend')}</legend>
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-700">
                <ActionTab active={action === 'categorize'} onClick={() => setAction('categorize')} icon={<Workflow size={13} />} label={t('actionCategorize')} />
                <ActionTab active={action === 'exclude'} onClick={() => setAction('exclude')} icon={<Ban size={13} />} label={t('actionExclude')} />
              </div>
              {action === 'categorize' ? (
                <div className="ml-auto inline-flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-700">
                  <ActionTab active={mode === 'suggest'} onClick={() => setMode('suggest')} icon={<Eye size={13} />} label={t('modeSuggest')} />
                  <ActionTab active={mode === 'auto'} onClick={() => setMode('auto')} icon={<Bolt size={13} />} label={t('modeAuto')} />
                </div>
              ) : null}
            </div>

            {action === 'categorize' ? (
              <div className="space-y-3">
                <SplitLinesEditor
                  lines={lines}
                  onChange={setLines}
                  accountOptions={accounts}
                  codings={codings}
                  showDescription
                  labels={{
                    remainder: t('split.remainder'),
                    percent: t('split.percent'),
                    fixed: t('split.fixed'),
                    addLine: t('split.addLine'),
                    removeLine: t('split.removeLine'),
                    accountPlaceholder: t('split.accountPlaceholder'),
                    descriptionPlaceholder: t('split.descriptionPlaceholder'),
                    account: tCommon('labels.account'),
                    portion: t('split.portion'),
                    none: '—',
                  }}
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>{t('assignPayee')}</Label>
                    <SearchSelect options={parties} value={partyId} onChange={(v) => setPartyId(v ?? '')} placeholder={t('payeePlaceholder')} clearable emptyLabel={t('noPayee')} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('memoLabel')}</Label>
                    <Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder={t('memoPlaceholder')} />
                  </div>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">{mode === 'suggest' ? t('suggestHint') : t('autoHint')}</p>
              </div>
            ) : (
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('excludeHint')}</p>
            )}
          </fieldset>
        </div>

        {/* ---- live preview column ---- */}
        <div className="space-y-2">
          <div className="rounded-xl border border-teal-200 p-3 dark:border-teal-900/60">
            <div className="mb-2 flex items-center gap-1.5">
              <Eye size={14} className="text-teal-600 dark:text-teal-400" />
              <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('preview.title')}</span>
              <div className="ml-auto min-w-[9rem]">
                <SearchSelect
                  options={reconAccounts.map((a) => ({ value: a.id, label: a.label }))}
                  value={previewAccount}
                  onChange={(v) => setPreviewAccount(v ?? '')}
                  placeholder={t('preview.pickAccount')}
                  triggerClassName="h-7 text-xs"
                />
              </div>
            </div>
            {!previewAccount ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('preview.pickAccountHint')}</p>
            ) : (
              <LivePreview<PreviewData>
                deps={[previewAccount, JSON.stringify(draftBody.criteria), JSON.stringify(draftBody.outcome), priority]}
                enabled={group.rules.length > 0}
                loadingLabel={t('preview.loading')}
                errorLabel={t('preview.error')}
                load={async (signal) => {
                  const res = await fetch('/api/banking/rules/preview', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ accountId: previewAccount, ...draftBody, limit: 12 }),
                    signal,
                  })
                  if (!res.ok) throw new Error('preview failed')
                  return (await res.json()) as PreviewData
                }}
                render={(data) => (
                  <div className="space-y-2.5">
                    <div className="flex items-baseline gap-2">
                      <span className="text-2xl font-medium text-teal-700 tabular-nums dark:text-teal-300">{data.matched}</span>
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        {t('preview.matched', { count: data.matched })}
                        {data.conflicts > 0 ? ` · ${t('preview.conflicts', { count: data.conflicts })}` : ` · ${t('preview.noConflicts')}`}
                      </span>
                    </div>
                    <div className="space-y-1">
                      {data.matches.length === 0 ? (
                        <p className="text-xs text-slate-400 dark:text-slate-500">{t('preview.none')}</p>
                      ) : (
                        data.matches.map((m) => (
                          <div key={m.lineId} className={cn('flex items-center gap-2 rounded-md bg-slate-50 px-2 py-1 text-xs dark:bg-slate-900/50', m.stolenBy && 'opacity-60')}>
                            <span className="tabular-nums text-slate-400">{m.posted_on.slice(5)}</span>
                            <span className="flex-1 truncate text-slate-700 dark:text-slate-200">{m.description ?? m.counterparty_ref ?? '—'}</span>
                            <span className={cn('tabular-nums font-medium', Number(m.amount) >= 0 ? 'text-teal-700 dark:text-teal-300' : 'text-slate-600 dark:text-slate-300')}>{money(m.amount)}</span>
                            {m.stolenBy ? <span className="text-[10px] text-slate-400" title={m.stolenBy}>{t('preview.stolen')}</span> : null}
                          </div>
                        ))
                      )}
                    </div>
                    {action === 'categorize' && lines.length > 1 && data.matches[0]?.splitPreview ? (
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">
                        {t('preview.split')}: {data.matches[0].splitPreview.map((s) => `${accountName(s.accountId).split(' · ')[0]} ${money(s.amount)}`).join(' · ')}
                      </p>
                    ) : null}
                  </div>
                )}
              />
            )}
          </div>
          {!creating && previewAccount ? (
            <p className="px-1 text-[11px] text-slate-400 dark:text-slate-500">{t('preview.healthHint')}</p>
          ) : null}
        </div>
      </div>
    </UrlDrawer>
  )
}

function ActionTab({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
        active ? 'bg-teal-50 text-teal-800 dark:bg-teal-950/50 dark:text-teal-200' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

/** Serialize editor allocation lines to the stored split shape. */
function serializeLines(lines: AllocationLine[]) {
  return lines
    .filter((l) => l.accountId)
    .map((l) => ({
      accountId: l.accountId,
      portion: l.portion,
      departmentId: l.departmentId ?? undefined,
      locationId: l.locationId ?? undefined,
      classId: l.classId ?? undefined,
      taxCodeId: l.taxCodeId ?? undefined,
      partyId: l.partyId ?? undefined,
      description: l.description ?? undefined,
    }))
}

/** Read a saved rule (v1 or v2) into the studio's editable state. */
function migrateRule(rule: Record<string, any> | null, seed?: { description?: string | null; amount?: string | null } | null) {
  const c = rule?.criteria ?? {}
  const o = rule?.outcome ?? {}
  const v2 = c?.version === 2 && c.match

  let match: ConditionGroup
  if (v2) {
    match = c.match
  } else {
    // Migrate a v1 flat rule into an equivalent and-group.
    const rules: ConditionGroup['rules'] = []
    if (c.descriptionContains) rules.push({ field: 'anyText', op: 'contains', value: c.descriptionContains })
    if (c.amountSign === 'in' || c.amountSign === 'out') rules.push({ field: 'flow', op: 'is', value: c.amountSign })
    if (typeof c.minAmount === 'number' && typeof c.maxAmount === 'number') rules.push({ field: 'amount', op: 'between', value: [c.minAmount, c.maxAmount] })
    else if (typeof c.minAmount === 'number') rules.push({ field: 'amount', op: 'gte', value: c.minAmount })
    else if (typeof c.maxAmount === 'number') rules.push({ field: 'amount', op: 'lte', value: c.maxAmount })
    match = { combinator: 'and', rules }
  }
  // Seed a brand-new rule from a bank line the user clicked "create rule from".
  if (!rule && seed?.description) {
    match = { combinator: 'and', rules: [{ field: 'anyText', op: 'contains', value: seed.description.slice(0, 60) }] }
  }

  const action: 'categorize' | 'exclude' = o.action === 'exclude' ? 'exclude' : 'categorize'
  const v2o = o?.action === 'categorize' && o?.version === 2
  const lines: AllocationLine[] = v2o && Array.isArray(o.lines)
    ? o.lines.map((l: any) => ({
        accountId: l.accountId ?? '',
        portion: l.portion ?? { kind: 'remainder' },
        departmentId: l.departmentId ?? null,
        locationId: l.locationId ?? null,
        classId: l.classId ?? null,
        taxCodeId: l.taxCodeId ?? null,
        partyId: l.partyId ?? null,
        description: l.description ?? null,
      }))
    : o.action === 'categorize' && o.accountId
      ? [{ accountId: o.accountId, portion: { kind: 'remainder' }, partyId: o.partyId ?? null }]
      : [{ accountId: '', portion: { kind: 'remainder' } }]

  return {
    name: rule?.name ?? '',
    priority: rule?.priority ?? 100,
    isActive: rule?.is_active ?? true,
    accountScope: v2 && Array.isArray(c.accountScope) ? (c.accountScope as string[]) : [],
    match,
    action,
    mode: (v2o ? o.mode : 'suggest') as 'auto' | 'suggest',
    lines,
    partyId: (v2o ? o.partyId : o.partyId) ?? '',
    memo: (v2o ? o.memo : '') ?? '',
  }
}
