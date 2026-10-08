'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Plus, Trash2 } from 'lucide-react'
import { Badge, Button, Input, Label, SearchSelect, Select, Textarea } from '@openbooks/ui'
import { Switch } from '@/components/switch'
import { canonicalDecimal, multiplyDecimal } from '@openbooks/engine/money/decimal'
import { add } from '@openbooks/engine/money'
import { useMoney } from '@/components/money-provider'
import { TransactionDrawer } from '@/components/transaction-drawer'
import { JournalEntryLink } from '@/components/journal-entry-link'
import { readApiErrorMessage } from '@/lib/api-error'
import { promptDialog } from '@/lib/prompt'
import { useDirtyClose } from '@/lib/use-dirty-close'
import type { InternalBillingDrawerData, InternalBillingOption } from '@/lib/internal-billing'

/**
 * The internal billing flyout. The simple path is: pick the rule (chosen for
 * you when there is only one), say who provides the work ("From"), and who
 * receives each line ("To"). Accounts come from the rule; dimensions an
 * organization does not use never appear. A draft edits in place and Post
 * saves and posts in one step; a posted document is read-only and voids.
 */

interface LineState {
  key: string
  itemId: string
  description: string
  quantity: string
  rate: string
  subsidiaryId: string
  departmentId: string
  projectId: string
  locationId: string
  classId: string
  isBillable: boolean | null
  billRate: string
}

interface HeaderState {
  ruleCode: string
  documentDate: string
  subsidiaryId: string
  departmentId: string
  projectId: string
  locationId: string
  classId: string
  referenceNumber: string
  memo: string
}

let keySeed = 0
const nextKey = () => `line-${++keySeed}`

function blankLine(): LineState {
  return {
    key: nextKey(), itemId: '', description: '', quantity: '1', rate: '', subsidiaryId: '', departmentId: '',
    projectId: '', locationId: '', classId: '', isBillable: null, billRate: '',
  }
}

function lineAmount(line: Pick<LineState, 'quantity' | 'rate'>): string | null {
  const quantity = canonicalDecimal(line.quantity === '' ? '1' : line.quantity, 8)
  const rate = canonicalDecimal(line.rate, 4)
  if (quantity === null || rate === null) return null
  try {
    return multiplyDecimal(quantity, rate, 4)
  } catch {
    return null
  }
}

export function InternalBillingDrawer(props: InternalBillingDrawerData & { initialMode?: 'view' | 'edit' }) {
  const t = useTranslations('internalBilling')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const { money } = useMoney(props.currency)
  const detail = props.detail
  const status = detail?.document.status ?? 'draft'
  const editable = props.canPost && status === 'draft'

  const initialHeader: HeaderState = useMemo(() => ({
    ruleCode: detail?.rule?.code ?? (props.rules.length === 1 ? props.rules[0]!.code : ''),
    documentDate: detail?.document.documentDate ?? props.today,
    subsidiaryId: detail?.document.subsidiaryId ?? props.defaultSubsidiaryId ?? '',
    departmentId: detail?.document.departmentId ?? '',
    projectId: detail?.document.projectId ?? '',
    locationId: detail?.document.locationId ?? '',
    classId: detail?.document.classId ?? '',
    referenceNumber: detail?.document.referenceNumber ?? '',
    memo: detail?.document.memo ?? '',
  }), [detail, props.rules, props.today, props.defaultSubsidiaryId])
  const initialLines: LineState[] = useMemo(() => detail?.lines.length
    ? detail.lines.map((line) => ({
        key: nextKey(),
        itemId: line.itemId ?? '',
        description: line.description ?? '',
        quantity: canonicalDecimal(line.quantity, 8) ?? line.quantity,
        rate: canonicalDecimal(line.rate, 4) ?? line.rate,
        subsidiaryId: line.subsidiaryId ?? '',
        departmentId: line.departmentId ?? '',
        projectId: line.projectId ?? '',
        locationId: line.locationId ?? '',
        classId: line.classId ?? '',
        isBillable: line.isBillable,
        billRate: line.billRate ? canonicalDecimal(line.billRate, 4) ?? line.billRate : '',
      }))
    : [blankLine()], [detail])

  const [header, setHeader] = useState(initialHeader)
  const [lines, setLines] = useState(initialLines)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = editable && (JSON.stringify(header) !== JSON.stringify(initialHeader) ||
    JSON.stringify(lines.map(({ key: _key, ...rest }) => rest)) !== JSON.stringify(initialLines.map(({ key: _key, ...rest }) => rest)))
  const { beforeClose } = useDirtyClose({
    dirty,
    busy,
    onClose: () => router.push(props.closeHref as never),
    message: tCommon('feedback.unsavedChanges'),
    confirmLabel: tCommon('actions.close'),
  })

  const rule = props.rules.find((choice) => choice.code === header.ruleCode) ?? null
  const method = rule?.method ?? detail?.rule?.method ?? null
  const billableAllowed = method !== null && method !== 'revenue_credit'
  const total = lines.reduce((sum, line) => add(sum, lineAmount(line) ?? '0'), '0')

  const setHeaderField = (key: keyof HeaderState, value: string) => setHeader((current) => ({ ...current, [key]: value }))
  const setLine = (key: string, patch: Partial<LineState>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)))

  const optionList = (options: InternalBillingOption[] | null) => (options ?? []).map((option) => ({ value: option.id, label: option.label }))

  function payload() {
    return {
      ruleCode: header.ruleCode,
      documentDate: header.documentDate || null,
      subsidiaryId: header.subsidiaryId || null,
      departmentId: header.departmentId || null,
      projectId: header.projectId || null,
      locationId: header.locationId || null,
      classId: header.classId || null,
      referenceNumber: header.referenceNumber || null,
      memo: header.memo || null,
      lines: lines.map((line) => ({
        itemId: line.itemId || null,
        description: line.description || null,
        quantity: line.quantity || null,
        rate: line.rate || null,
        subsidiaryId: line.subsidiaryId || null,
        departmentId: line.departmentId || null,
        projectId: line.projectId || null,
        locationId: line.locationId || null,
        classId: line.classId || null,
        isBillable: billableAllowed && line.projectId ? line.isBillable : false,
        billRate: billableAllowed && line.projectId && line.billRate ? line.billRate : null,
      })),
    }
  }

  /** Persist the draft; resolves to its id, or null after showing the refusal. */
  async function save(): Promise<string | null> {
    const res = await fetch(detail ? `/api/internal-billing/${detail.document.id}` : '/api/internal-billing', {
      method: detail ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(detail ? { ...payload(), expectedRevision: detail.document.revision } : payload()),
    })
    if (!res.ok) {
      setError(await readApiErrorMessage(res, t('feedback.saveFailed')))
      return null
    }
    const saved = (await res.json()) as { id: string }
    return saved.id
  }

  function openRecord(id: string) {
    const target = new URL(props.closeHref, window.location.origin)
    target.searchParams.set('doc', id)
    router.replace(`${target.pathname}${target.search}` as never)
    router.refresh()
  }

  async function onSave() {
    setBusy(true)
    setError(null)
    try {
      const id = await save()
      if (!id) return
      toast.success(t('feedback.saved'))
      openRecord(id)
    } catch {
      setError(t('feedback.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function onPost() {
    setBusy(true)
    setError(null)
    try {
      const id = dirty || !detail ? await save() : detail.document.id
      if (!id) return
      const res = await fetch(`/api/internal-billing/${id}/post`, { method: 'POST' })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, t('feedback.postFailed')))
        // The draft was saved; keep the operator on it to correct and retry.
        if (!detail) openRecord(id)
        return
      }
      const outcome = (await res.json()) as { status: string }
      toast.success(outcome.status === 'pending_approval' ? t('feedback.pendingApproval') : t('feedback.posted'))
      openRecord(id)
    } catch {
      setError(t('feedback.postFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function onVoid() {
    if (!detail) return
    const reason = await promptDialog({
      title: t('void.title'),
      message: t('void.message'),
      label: t('void.reason'),
      multiline: true,
      confirmLabel: tCommon('actions.void'),
    })
    if (!reason) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/internal-billing/${detail.document.id}/void`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, expectedRevision: detail.document.revision }),
      })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, t('feedback.voidFailed')))
        return
      }
      toast.success(t('feedback.voided'))
      router.refresh()
    } catch {
      setError(t('feedback.voidFailed'))
    } finally {
      setBusy(false)
    }
  }

  const statusKey = status === 'pending_approval' ? 'pending_approval' : status
  const title = detail ? detail.document.documentNumber : t('drawer.newTitle')
  const field = (id: string, label: string, control: React.ReactNode) => (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {control}
    </div>
  )
  const picker = (id: string, label: string, value: string, options: InternalBillingOption[] | null, onChange: (value: string) => void, placeholder?: string) =>
    options ? field(id, label, (
      <SearchSelect
        id={id}
        value={value}
        onChange={onChange}
        options={optionList(options)}
        clearable
        placeholder={placeholder ?? t('drawer.none')}
        disabled={!editable}
      />
    )) : null

  return (
    <TransactionDrawer
      closeHref={props.closeHref}
      beforeClose={beforeClose}
      recordId={detail?.document.id ?? ''}
      showEvidenceTabs={Boolean(detail)}
      title={
        <span className="flex items-center gap-2">
          {title}
          {detail ? <Badge variant={status === 'posted' ? 'success' : status === 'voided' ? 'outline' : 'secondary'}>{tCommon(`status.${statusKey}` as never)}</Badge> : null}
        </span>
      }
      description={rule ? `${rule.name} · ${t(`methods.${rule.method}.label`)}` : detail?.rule ? `${detail.rule.name} · ${t(`methods.${detail.rule.method}.label`)}` : t('drawer.description')}
      primaryAction={editable ? (
        <Button disabled={busy || !header.ruleCode} onClick={onPost}>
          {busy ? tCommon('actions.posting') : tCommon('actions.post')}
        </Button>
      ) : null}
      actions={
        <>
          {editable ? (
            <Button variant="ghost" disabled={busy || !header.ruleCode} onClick={onSave}>
              {busy ? tCommon('actions.saving') : t('drawer.saveDraft')}
            </Button>
          ) : null}
          {props.canPost && status === 'posted' ? (
            <Button variant="ghost" disabled={busy} onClick={onVoid}>
              <Trash2 size={14} /> {tCommon('actions.void')}
            </Button>
          ) : null}
        </>
      }
      footer={
        <div className="flex w-full items-center gap-3">
          <span className="text-xs text-slate-500 dark:text-slate-400">{dirty ? tCommon('feedback.unsavedChanges') : null}</span>
          <span className="flex-1" />
          {detail?.document.postedEntryId ? (
            <JournalEntryLink entryId={detail.document.postedEntryId} className="text-sm font-medium text-teal-700 hover:underline dark:text-teal-300">
              {t('drawer.journalEntry')}
            </JournalEntryLink>
          ) : null}
          <span className="text-sm tabular-nums text-slate-600 dark:text-slate-300">
            {t('drawer.total')} <strong className="text-slate-900 dark:text-slate-100">{money(total)}</strong>
          </span>
        </div>
      }
    >
      <div className="space-y-6 p-1">
        {error ? (
          <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        ) : null}

        {props.rules.length === 0 && !detail ? (
          <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            {t('drawer.noRules')}
          </p>
        ) : null}

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('drawer.from')}</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            {props.rules.length > 1 || !header.ruleCode ? field('ib-rule', t('fields.rule'), (
              <Select
                id="ib-rule"
                value={header.ruleCode}
                onChange={(event) => setHeaderField('ruleCode', event.target.value)}
                disabled={!editable}
              >
                <option value="">{t('drawer.chooseRule')}</option>
                {props.rules.map((choice) => <option key={choice.code} value={choice.code}>{choice.name}</option>)}
              </Select>
            )) : null}
            {field('ib-date', tCommon('labels.date'), (
              <Input id="ib-date" type="date" value={header.documentDate} disabled={!editable}
                onChange={(event) => setHeaderField('documentDate', event.target.value)} />
            ))}
            {picker('ib-subsidiary', tCommon('labels.subsidiary'), header.subsidiaryId, props.options.subsidiaries, (value) => setHeaderField('subsidiaryId', value))}
            {picker('ib-department', tCommon('labels.department'), header.departmentId, props.options.departments, (value) => setHeaderField('departmentId', value))}
            {picker('ib-project', tCommon('labels.project'), header.projectId, props.options.projects, (value) => setHeaderField('projectId', value))}
            {picker('ib-location', tCommon('labels.location'), header.locationId, props.options.locations, (value) => setHeaderField('locationId', value))}
            {picker('ib-class', tCommon('labels.class'), header.classId, props.options.classes, (value) => setHeaderField('classId', value))}
          </div>
          {method ? <p className="text-xs text-slate-500 dark:text-slate-400">{t(`methods.${method}.description`)}</p> : null}
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('drawer.to')}</h3>
          <div className="space-y-3">
            {lines.map((line, index) => {
              const amount = lineAmount(line)
              const billed = detail?.lines[index]?.billed ?? false
              return (
                <div key={line.key} className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                  <div className="grid gap-3 sm:grid-cols-2">
                    {method === 'intercompany_sale'
                      ? picker(`ib-${line.key}-subsidiary`, tCommon('labels.subsidiary'), line.subsidiaryId, props.options.subsidiaries, (value) => setLine(line.key, { subsidiaryId: value }), t('drawer.chooseSubsidiary'))
                      : null}
                    {picker(`ib-${line.key}-department`, tCommon('labels.department'), line.departmentId, props.options.departments, (value) => setLine(line.key, { departmentId: value }), t('drawer.sameAsFrom'))}
                    {picker(`ib-${line.key}-project`, tCommon('labels.project'), line.projectId, props.options.projects, (value) => setLine(line.key, { projectId: value }), t('drawer.sameAsFrom'))}
                    {picker(`ib-${line.key}-location`, tCommon('labels.location'), line.locationId, props.options.locations, (value) => setLine(line.key, { locationId: value }), t('drawer.sameAsFrom'))}
                    {picker(`ib-${line.key}-class`, tCommon('labels.class'), line.classId, props.options.classes, (value) => setLine(line.key, { classId: value }), t('drawer.sameAsFrom'))}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_1fr]">
                    {field(`ib-${line.key}-item`, tCommon('labels.item'), (
                      <SearchSelect id={`ib-${line.key}-item`} value={line.itemId} clearable disabled={!editable}
                        placeholder={t('drawer.none')} options={optionList(props.options.items)}
                        onChange={(value) => setLine(line.key, { itemId: value })} />
                    ))}
                    {field(`ib-${line.key}-qty`, tCommon('labels.quantity'), (
                      <Input id={`ib-${line.key}-qty`} inputMode="decimal" value={line.quantity} disabled={!editable}
                        onChange={(event) => setLine(line.key, { quantity: event.target.value })} />
                    ))}
                    {field(`ib-${line.key}-rate`, t('fields.rate'), (
                      <Input id={`ib-${line.key}-rate`} inputMode="decimal" value={line.rate} disabled={!editable}
                        onChange={(event) => setLine(line.key, { rate: event.target.value })} />
                    ))}
                    <div className="space-y-1.5">
                      <span className="block text-sm font-medium">{tCommon('labels.amount')}</span>
                      <span className="block py-2 text-sm tabular-nums">{amount === null ? '—' : money(amount)}</span>
                    </div>
                  </div>
                  {field(`ib-${line.key}-description`, tCommon('labels.description'), (
                    <Textarea id={`ib-${line.key}-description`} rows={1} value={line.description} disabled={!editable}
                      onChange={(event) => setLine(line.key, { description: event.target.value })} />
                  ))}
                  {billableAllowed && line.projectId ? (
                    <div className="flex flex-wrap items-center gap-4">
                      <span className="flex items-center gap-2 text-sm">
                        <Switch
                          on={line.isBillable ?? rule?.billableByDefault ?? false}
                          disabled={!editable}
                          label={t('fields.billable')}
                          onToggle={() => setLine(line.key, { isBillable: !(line.isBillable ?? rule?.billableByDefault ?? false) })}
                        />
                        {t('fields.billable')}
                      </span>
                      {(line.isBillable ?? rule?.billableByDefault ?? false) ? (
                        <div className="flex items-center gap-2">
                          <Label htmlFor={`ib-${line.key}-bill-rate`} className="text-sm">{t('fields.billRate')}</Label>
                          <Input id={`ib-${line.key}-bill-rate`} className="w-32" inputMode="decimal" value={line.billRate}
                            placeholder={line.rate} disabled={!editable}
                            onChange={(event) => setLine(line.key, { billRate: event.target.value })} />
                        </div>
                      ) : null}
                      {billed ? <Badge variant="secondary">{t('drawer.billed')}</Badge> : null}
                    </div>
                  ) : null}
                  {editable && lines.length > 1 ? (
                    <div className="flex justify-end">
                      <Button variant="ghost" size="sm" onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))}>
                        <Trash2 size={14} /> {t('drawer.removeLine')}
                      </Button>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
          {editable ? (
            <Button variant="outline" size="sm" onClick={() => setLines((current) => [...current, blankLine()])}>
              <Plus size={14} /> {t('drawer.addLine')}
            </Button>
          ) : null}
        </section>

        <section className="grid gap-4 sm:grid-cols-2">
          {field('ib-reference', tCommon('labels.reference'), (
            <Input id="ib-reference" value={header.referenceNumber} disabled={!editable}
              onChange={(event) => setHeaderField('referenceNumber', event.target.value)} />
          ))}
          {field('ib-memo', tCommon('labels.memo'), (
            <Textarea id="ib-memo" rows={2} value={header.memo} disabled={!editable}
              onChange={(event) => setHeaderField('memo', event.target.value)} />
          ))}
        </section>
      </div>
    </TransactionDrawer>
  )
}
