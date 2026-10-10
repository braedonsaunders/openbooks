'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Drawer,
  Input,
  Label,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  UrlDrawer,
} from '@openbooks/ui'
import { DrawerTabStrip } from '@/components/drawer-tab-strip'
import { DrawerSublist, SublistAddButton, SublistEmpty, SublistPager, useSublistRows } from '@/components/drawer-sublist'
import { confirmDialog } from '@/lib/confirm'
import { useAppAction } from '@/lib/use-app-action'
import type { GrantDrawerData, GrantGroupOption } from './view'

type GrantTab = 'terms' | 'budget' | 'drawdowns' | 'reports' | 'activity'

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline'> = {
  draft: 'outline',
  awarded: 'warning',
  active: 'success',
  closed_out: 'secondary',
  closed: 'secondary',
  void: 'outline',
}

const DRAWDOWN_STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline'> = {
  draft: 'outline',
  submitted: 'warning',
  paid: 'success',
  recognized: 'success',
  void: 'secondary',
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</Label>
      {children}
    </div>
  )
}

/**
 * Grant record drawer — terms, budget and allowable costs, drawdowns,
 * reports and deadlines, activity and history.
 *
 * Every lifecycle action dispatches to its named command route: non-posting
 * commands to /api/grants/commands under grants.manage, posting commands to
 * /api/grants/postings, which additionally proves gl.post before the body
 * parses. A refusal pins beside the record with the server's own remedy;
 * `res.ok` is checked before any body is parsed.
 */
export function GrantDrawer({ drawer }: { drawer: GrantDrawerData }) {
  const t = useTranslations('nonprofit')
  const router = useRouter()
  const action = useAppAction()
  const [tab, setTab] = useState<GrantTab>('terms')

  async function run(url: string, payload: Record<string, unknown>, success: string) {
    return action.execute(
      () => fetchAction(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
      {
        fallbackMessage: t('grants.actionFailed'),
        onOk: async () => {
          toast.success(success)
          router.refresh()
        },
      },
    )
  }

  async function runPosting(payload: Record<string, unknown>, success: string) {
    return run('/api/grants/postings', payload, success)
  }

  async function runCommand(payload: Record<string, unknown>, success: string) {
    return run('/api/grants/commands', payload, success)
  }

  if (drawer.mode === 'create') {
    return (
      <UrlDrawer open closeHref={drawer.closeHref} size="2xl" title={t('grants.newTitle')} description={t('grants.newDescription')}>
        <ActionAlert error={action.refusal} fallbackMessage={t('grants.actionFailed')} />
        <CreateGrantForm
          drawer={drawer}
          busy={action.busy}
          onSubmit={(payload) => runCommand({ action: 'create', ...payload }, t('grants.created'))}
        />
      </UrlDrawer>
    )
  }

  const { terms, budget, activity } = drawer
  const canManage = drawer.canManage

  return (
    <UrlDrawer
      open
      closeHref={drawer.closeHref}
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono text-sm text-slate-500 dark:text-slate-400">{terms.code}</span>
          <span>{terms.name}</span>
          <Badge variant={STATUS_VARIANT[terms.status] ?? 'outline'}>{terms.status}</Badge>
        </span>
      }
      description={t('grants.details')}
      subtabs={
        <DrawerTabStrip
          ariaLabel={t('grants.tabsAria')}
          activeKey={tab}
          onSelect={setTab}
          tabs={(
            [
              { key: 'terms', label: t('grants.tabs.terms') },
              { key: 'budget', label: t('grants.tabs.budget') },
              { key: 'drawdowns', label: t('grants.tabs.drawdowns') },
              { key: 'reports', label: t('grants.tabs.reports') },
              { key: 'activity', label: t('grants.tabs.activity') },
            ] as const
          ).map((item) => ({ key: item.key, label: item.label }))}
        />
      }
    >
      <ActionAlert error={action.refusal} fallbackMessage={t('grants.actionFailed')} />
      {tab === 'terms' ? (
        <GrantTermsTab drawer={drawer} onCommand={runCommand} onPosting={runPosting} busy={action.busy} canManage={canManage} />
      ) : null}
      {tab === 'budget' ? <GrantBudgetTab budget={budget} /> : null}
      {tab === 'drawdowns' ? (
        <GrantDrawdownsTab drawer={drawer} onCommand={runCommand} onPosting={runPosting} busy={action.busy} canManage={canManage} />
      ) : null}
      {tab === 'reports' ? (
        <GrantReportsTab drawer={drawer} onCommand={runCommand} busy={action.busy} canManage={canManage} />
      ) : null}
      {tab === 'activity' ? <GrantActivityTab activity={activity} /> : null}
    </UrlDrawer>
  )
}

function AccountSelect({
  label,
  value,
  onChange,
  options,
  types,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: { id: string; number: string | null; name: string; type: string }[]
  types: string[]
}) {
  const items = options.filter((opt) => types.includes(opt.type))
  return (
    <Field label={label}>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        {items.map((opt) => (
          <option key={opt.id} value={opt.id}>
            {`${opt.number ?? ''} ${opt.name}`.trim()}
          </option>
        ))}
      </Select>
    </Field>
  )
}

function defaultAccountIds(options: { id: string; type: string }[]): Record<string, string> {
  const pick = (types: string[]) => options.find((opt) => types.includes(opt.type))?.id ?? ''
  return {
    bankAccountId: pick(['asset_bank']),
    grantsReceivableAccountId: pick(['asset_receivable']),
    refundableAdvanceAccountId: pick(['liability_current_other', 'liability_long_term', 'liability_payable']),
    grantRevenueAccountId: pick(['income', 'income_other']),
    exchangeReceivableAccountId: pick(['asset_receivable']),
    exchangeRevenueAccountId: pick(['income', 'income_other']),
  }
}

function PostingAccountsForm({
  t,
  options,
  value,
  onChange,
}: {
  t: ReturnType<typeof useTranslations>
  options: { id: string; number: string | null; name: string; type: string }[]
  value: Record<string, string>
  onChange: (next: Record<string, string>) => void
}) {
  const set = (key: string) => (next: string) => onChange({ ...value, [key]: next })
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <AccountSelect label={t('grants.bankAccount')} value={value.bankAccountId ?? ''} onChange={set('bankAccountId')} options={options} types={['asset_bank']} />
      <AccountSelect label={t('grants.receivableAccount')} value={value.grantsReceivableAccountId ?? ''} onChange={set('grantsReceivableAccountId')} options={options} types={['asset_receivable']} />
      <AccountSelect label={t('grants.advanceAccount')} value={value.refundableAdvanceAccountId ?? ''} onChange={set('refundableAdvanceAccountId')} options={options} types={['liability_current_other', 'liability_long_term', 'liability_payable']} />
      <AccountSelect label={t('grants.revenueAccount')} value={value.grantRevenueAccountId ?? ''} onChange={set('grantRevenueAccountId')} options={options} types={['income', 'income_other']} />
      <AccountSelect label={t('grants.exchangeReceivableAccount')} value={value.exchangeReceivableAccountId ?? ''} onChange={set('exchangeReceivableAccountId')} options={options} types={['asset_receivable']} />
      <AccountSelect label={t('grants.exchangeRevenueAccount')} value={value.exchangeRevenueAccountId ?? ''} onChange={set('exchangeRevenueAccountId')} options={options} types={['income', 'income_other']} />
    </div>
  )
}

type IndirectTerms = {
  indirectRate: string
  indirectBase: string
  mtdcExclusionAccountGroupId: string
  mtdcSubawardAccountGroupId: string
  mtdcSubawardThreshold: string
}

const EMPTY_INDIRECT_TERMS: IndirectTerms = {
  indirectRate: '',
  indirectBase: 'direct_costs',
  mtdcExclusionAccountGroupId: '',
  mtdcSubawardAccountGroupId: '',
  mtdcSubawardThreshold: '',
}

function groupLabel(group: GrantGroupOption) {
  return `${group.name} (${group.dimension})`
}

/**
 * The grant's indirect-cost terms as the engine accepts them. The MTDC
 * settings travel only with the MTDC base; an unchosen excluded-cost group is
 * sent as null so the server can refuse a reimbursement by name rather than
 * the form guessing a default.
 */
function indirectPayload(value: IndirectTerms): Record<string, unknown> {
  const mtdc = value.indirectBase === 'modified_total_direct'
  return {
    ...(value.indirectRate.trim() ? { indirectRate: value.indirectRate.trim() } : {}),
    indirectBase: value.indirectBase,
    ...(mtdc
      ? {
          mtdcExclusionAccountGroupId: value.mtdcExclusionAccountGroupId || null,
          mtdcSubawardAccountGroupId: value.mtdcSubawardAccountGroupId || null,
          mtdcSubawardThreshold: value.mtdcSubawardAccountGroupId ? value.mtdcSubawardThreshold.trim() || null : null,
        }
      : {}),
  }
}

function IndirectTermsFields({
  value,
  onChange,
  groups,
}: {
  value: IndirectTerms
  onChange: (next: IndirectTerms) => void
  groups: GrantGroupOption[]
}) {
  const t = useTranslations('nonprofit')
  const set = (key: keyof IndirectTerms) => (next: string) => onChange({ ...value, [key]: next })
  return (
    <>
      <Field label={t('grants.indirectRate')}>
        <Input value={value.indirectRate} onChange={(e) => set('indirectRate')(e.target.value)} inputMode="decimal" />
      </Field>
      <Field label={t('grants.indirectBase')}>
        <Select value={value.indirectBase} onChange={(e) => set('indirectBase')(e.target.value)}>
          <option value="direct_costs">{t('grants.indirectBaseDirect')}</option>
          <option value="modified_total_direct">{t('grants.indirectBaseMtdc')}</option>
        </Select>
      </Field>
      {value.indirectBase === 'modified_total_direct' ? (
        <>
          <Field label={t('grants.mtdcExclusionGroup')}>
            <Select value={value.mtdcExclusionAccountGroupId} onChange={(e) => set('mtdcExclusionAccountGroupId')(e.target.value)}>
              <option value="">{t('grants.mtdcChooseGroup')}</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>{groupLabel(group)}</option>
              ))}
            </Select>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('grants.mtdcExclusionHint')}</p>
          </Field>
          <Field label={t('grants.mtdcSubawardGroup')}>
            <Select value={value.mtdcSubawardAccountGroupId} onChange={(e) => set('mtdcSubawardAccountGroupId')(e.target.value)}>
              <option value="">{t('grants.mtdcNoSubaward')}</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>{groupLabel(group)}</option>
              ))}
            </Select>
          </Field>
          {value.mtdcSubawardAccountGroupId ? (
            <Field label={t('grants.mtdcSubawardThreshold')}>
              <Input value={value.mtdcSubawardThreshold} onChange={(e) => set('mtdcSubawardThreshold')(e.target.value)} inputMode="decimal" />
            </Field>
          ) : null}
        </>
      ) : null}
    </>
  )
}

function CreateGrantForm({
  drawer,
  busy,
  onSubmit,
}: {
  drawer: Extract<GrantDrawerData, { mode: 'create' }>
  busy: boolean
  onSubmit: (payload: Record<string, unknown>) => Promise<boolean>
}) {
  const t = useTranslations('nonprofit')
  const [form, setForm] = useState({
    code: '',
    name: '',
    sponsorPartyId: drawer.sponsorOptions[0]?.id ?? '',
    sponsorKind: 'foundation',
    determination: 'contribution_unconditional',
    barrier: '',
    awardAmount: '',
    periodFrom: '',
    periodTo: '',
    fundId: drawer.fundOptions[0]?.id ?? '',
    allowableAccountGroupId: drawer.groupOptions[0]?.id ?? '',
  })
  const [indirect, setIndirect] = useState<IndirectTerms>(EMPTY_INDIRECT_TERMS)
  const set = (key: keyof typeof form) => (value: string) => setForm((prev) => ({ ...prev, [key]: value }))
  if (!drawer.canManage) return <p className="text-sm text-slate-500">{t('grants.manageRequired')}</p>
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t('grants.code')}><Input value={form.code} onChange={(e) => set('code')(e.target.value)} /></Field>
      <Field label={t('grants.name')}><Input value={form.name} onChange={(e) => set('name')(e.target.value)} /></Field>
      <Field label={t('grants.sponsor')}>
        <Select value={form.sponsorPartyId} onChange={(e) => set('sponsorPartyId')(e.target.value)}>
          {drawer.sponsorOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>{opt.displayName}</option>
          ))}
        </Select>
      </Field>
      <Field label={t('grants.sponsorKind')}>
        <Select value={form.sponsorKind} onChange={(e) => set('sponsorKind')(e.target.value)}>
          {['government', 'foundation', 'corporate'].map((kind) => (
            <option key={kind} value={kind}>{kind}</option>
          ))}
        </Select>
      </Field>
      <Field label={t('grants.determination')}>
        <Select value={form.determination} onChange={(e) => set('determination')(e.target.value)}>
          {['contribution_unconditional', 'contribution_conditional', 'exchange'].map((kind) => (
            <option key={kind} value={kind}>{kind}</option>
          ))}
        </Select>
      </Field>
      <Field label={t('grants.awardAmount')}><Input value={form.awardAmount} onChange={(e) => set('awardAmount')(e.target.value)} inputMode="decimal" /></Field>
      <Field label={t('grants.periodFrom')}><Input type="date" value={form.periodFrom} onChange={(e) => set('periodFrom')(e.target.value)} /></Field>
      <Field label={t('grants.periodTo')}><Input type="date" value={form.periodTo} onChange={(e) => set('periodTo')(e.target.value)} /></Field>
      <Field label={t('grants.fund')}>
        <Select value={form.fundId} onChange={(e) => set('fundId')(e.target.value)}>
          {drawer.fundOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>{`${opt.code} ${opt.name}`.trim()}</option>
          ))}
        </Select>
      </Field>
      <Field label={t('grants.allowableGroup')}>
        <Select value={form.allowableAccountGroupId} onChange={(e) => set('allowableAccountGroupId')(e.target.value)}>
          {drawer.groupOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>{groupLabel(opt)}</option>
          ))}
        </Select>
      </Field>
      <IndirectTermsFields value={indirect} onChange={setIndirect} groups={drawer.groupOptions} />
      {form.determination === 'contribution_conditional' ? (
        <Field label={t('grants.barrier')}><Textarea value={form.barrier} onChange={(e) => set('barrier')(e.target.value)} /></Field>
      ) : null}
      <div className="sm:col-span-2">
        <Button disabled={busy} onClick={() => onSubmit({ ...form, ...indirectPayload(indirect), rightOfReturn: form.determination === 'contribution_conditional' })}>
          {t('grants.createAction')}
        </Button>
      </div>
    </div>
  )
}

function GrantTermsTab({
  drawer,
  onCommand,
  onPosting,
  busy,
  canManage,
}: {
  drawer: Extract<GrantDrawerData, { mode: 'record' }>
  onCommand: (payload: Record<string, unknown>, success: string) => Promise<boolean>
  onPosting: (payload: Record<string, unknown>, success: string) => Promise<boolean>
  busy: boolean
  canManage: boolean
}) {
  const t = useTranslations('nonprofit')
  const terms = drawer.terms
  const [evidence, setEvidence] = useState('')
  const [postingDate, setPostingDate] = useState(drawer.asOf)
  const [accounts, setAccounts] = useState<Record<string, string>>(() => defaultAccountIds(drawer.accountOptions))
  const [reason, setReason] = useState('')
  const [amendAmount, setAmendAmount] = useState('')
  const currentIndirect: IndirectTerms = {
    indirectRate: terms.indirectRate,
    indirectBase: terms.indirectBase,
    mtdcExclusionAccountGroupId: terms.mtdcExclusionAccountGroupId ?? '',
    mtdcSubawardAccountGroupId: terms.mtdcSubawardAccountGroupId ?? '',
    mtdcSubawardThreshold: terms.mtdcSubawardThreshold ?? '',
  }
  const [indirect, setIndirect] = useState<IndirectTerms>(currentIndirect)
  const groupName = (id: string | null) => {
    const group = id ? drawer.groupOptions.find((option) => option.id === id) : undefined
    return group ? groupLabel(group) : t('grants.notConfigured')
  }

  // An amendment carries only the indirect terms the operator changed.
  function indirectChanges(): Record<string, unknown> {
    const before = indirectPayload(currentIndirect)
    const after = indirectPayload(indirect)
    return Object.fromEntries(Object.entries(after).filter(([key, next]) => before[key] !== next))
  }

  async function confirmThen(label: string, task: () => Promise<boolean>) {
    if (!(await confirmDialog(label))) return
    await task()
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 p-1 sm:grid-cols-2">
        <Field label={t('grants.sponsorKind')}><p className="text-sm">{terms.sponsorKind}</p></Field>
        <Field label={t('grants.determination')}><p className="text-sm">{terms.determination}</p></Field>
        <Field label={t('grants.awardAmount')}><p className="font-mono text-sm">{terms.awardAmount}</p></Field>
        <Field label={t('grants.period')}><p className="text-sm">{`${terms.periodFrom} – ${terms.periodTo}`}</p></Field>
        <Field label={t('grants.indirectRate')}>
          <p className="text-sm">
            {`${terms.indirectRate} · ${terms.indirectBase === 'modified_total_direct' ? t('grants.indirectBaseMtdc') : t('grants.indirectBaseDirect')}`}
          </p>
        </Field>
        {terms.indirectBase === 'modified_total_direct' ? (
          <>
            <Field label={t('grants.mtdcExclusionGroup')}><p className="text-sm">{groupName(terms.mtdcExclusionAccountGroupId)}</p></Field>
            <Field label={t('grants.mtdcSubawardGroup')}>
              <p className="text-sm">
                {terms.mtdcSubawardAccountGroupId
                  ? `${groupName(terms.mtdcSubawardAccountGroupId)} · ${terms.mtdcSubawardThreshold}`
                  : t('grants.mtdcNoSubaward')}
              </p>
            </Field>
          </>
        ) : null}
        <Field label={t('grants.barrier')}>
          <p className="text-sm">{terms.barrier ?? t('grants.noBarrier')}{terms.barrierMetAt ? ` · ${terms.barrierMetAt}` : ''}</p>
        </Field>
      </div>
      {!canManage ? (
        <p className="text-sm text-slate-500">{t('grants.manageRequired')}</p>
      ) : (
        <div className="space-y-3 border-t border-slate-200 pt-3 dark:border-slate-800">
          {terms.status === 'draft' ? (
            <div className="space-y-3">
              <PostingAccountsForm t={t} options={drawer.accountOptions} value={accounts} onChange={setAccounts} />
              <Field label={t('grants.postingDate')}><Input type="date" value={postingDate} onChange={(e) => setPostingDate(e.target.value)} /></Field>
              <Button disabled={busy} onClick={() => onPosting({ action: 'award', grantId: terms.id, accounts, postingDate }, t('grants.awarded'))}>
                {t('grants.awardAction')}
              </Button>
            </div>
          ) : null}
          {terms.status === 'awarded' ? (
            <Button disabled={busy} onClick={() => onCommand({ action: 'activate', grantId: terms.id }, t('grants.activated'))}>
              {t('grants.activateAction')}
            </Button>
          ) : null}
          {terms.determination === 'contribution_conditional' && !terms.barrierMetAt ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-52 flex-1">
                <Field label={t('grants.evidence')}><Textarea value={evidence} onChange={(e) => setEvidence(e.target.value)} /></Field>
              </div>
              <Button disabled={busy} onClick={() => onCommand({ action: 'satisfyBarrier', grantId: terms.id, evidence }, t('grants.barrierSatisfied'))}>
                {t('grants.satisfyAction')}
              </Button>
            </div>
          ) : null}
          {!['closed_out', 'closed', 'void'].includes(terms.status) ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <h4 className="text-sm font-medium sm:col-span-2">{t('grants.indirectTerms')}</h4>
              <IndirectTermsFields value={indirect} onChange={setIndirect} groups={drawer.groupOptions} />
            </div>
          ) : null}
          {!['closed_out', 'closed', 'void'].includes(terms.status) ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-40 flex-1">
                <Field label={t('grants.amendAmount')}><Input value={amendAmount} onChange={(e) => setAmendAmount(e.target.value)} inputMode="decimal" /></Field>
              </div>
              <div className="min-w-52 flex-1">
                <Field label={t('grants.reason')}><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              </div>
              <Button
                disabled={busy}
                onClick={() => onPosting({
                  action: 'amend', grantId: terms.id, reason,
                  changes: { ...(amendAmount.trim() ? { awardAmount: amendAmount.trim() } : {}), ...indirectChanges() },
                  accounts, postingDate,
                }, t('grants.amended'))}
              >
                {t('grants.amendAction')}
              </Button>
            </div>
          ) : null}
          {!['closed_out', 'closed', 'void'].includes(terms.status) ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-40">
                <Field label={t('grants.postingDate')}><Input type="date" value={postingDate} onChange={(e) => setPostingDate(e.target.value)} /></Field>
              </div>
              <div className="min-w-52 flex-1">
                <Field label={t('grants.reason')}><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              </div>
              <Button
                disabled={busy}
                variant="outline"
                onClick={() => confirmThen(t('grants.voidAction'), () => onPosting({ action: 'void', grantId: terms.id, postingDate, reason }, t('grants.voided')))}
              >
                {t('grants.voidAction')}
              </Button>
              {terms.status === 'active' ? (
                <Button disabled={busy} variant="outline" onClick={() => onCommand({ action: 'closeOut', grantId: terms.id }, t('grants.closedOut'))}>
                  {t('grants.closeOutAction')}
                </Button>
              ) : null}
              {terms.status === 'closed_out' ? (
                <Button disabled={busy} variant="outline" onClick={() => onCommand({ action: 'close', grantId: terms.id }, t('grants.closed'))}>
                  {t('grants.closeAction')}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

function GrantBudgetTab({ budget }: { budget: Extract<GrantDrawerData, { mode: 'record' }>['budget'] }) {
  const t = useTranslations('nonprofit')
  const rows: [string, string | null][] = [
    [t('grants.awardAmount'), budget.awardAmount],
    [t('grants.drawnAmount'), budget.drawnAmount],
    [t('grants.remainingAward'), budget.remainingAward],
    [t('grants.allowableDirect'), budget.allowableDirectCosts],
    [t('grants.indirectCostBase'), budget.indirectCostBase],
    [t('grants.indirectCost'), budget.indirectCost],
    [t('grants.allowableSpend'), budget.allowableSpend],
    [t('grants.reimbursedAmount'), budget.reimbursedAmount],
    [t('grants.reimbursedByOtherGrants'), budget.reimbursedByOtherGrants],
    [t('grants.remainingAllowable'), budget.remainingAllowableSpend],
  ]
  return (
    <div className="space-y-3">
      {budget.measurementRefusal ? (
        <Alert variant="warning">
          <AlertTitle>{t('grants.budgetUnmeasured')}</AlertTitle>
          <AlertDescription>
            <p>{budget.measurementRefusal.message}</p>
            <p>{budget.measurementRefusal.remedy}</p>
          </AlertDescription>
        </Alert>
      ) : null}
      <Table>
        <TableBody>
          {rows.map(([label, value]) => (
            <TableRow key={label}>
              <TableCell>{label}</TableCell>
              <TableCell className="text-right font-mono text-[13px]">{value ?? t('grants.notMeasured')}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function GrantDrawdownsTab({
  drawer,
  onCommand,
  onPosting,
  busy,
  canManage,
}: {
  drawer: Extract<GrantDrawerData, { mode: 'record' }>
  onCommand: (payload: Record<string, unknown>, success: string) => Promise<boolean>
  onPosting: (payload: Record<string, unknown>, success: string) => Promise<boolean>
  busy: boolean
  canManage: boolean
}) {
  const t = useTranslations('nonprofit')
  const terms = drawer.terms
  const [amount, setAmount] = useState('')
  const [kind, setKind] = useState('reimbursement')
  const [postingDate, setPostingDate] = useState(drawer.asOf)
  const [accounts, setAccounts] = useState<Record<string, string>>(() => defaultAccountIds(drawer.accountOptions))
  const [reason, setReason] = useState('')
  const drafts = drawer.drawdowns.filter((item) => item.status === 'draft')
  const submitted = drawer.drawdowns.filter((item) => item.status === 'submitted')
  const paid = drawer.drawdowns.filter((item) => item.status === 'paid')

  return (
    <div className="space-y-4">
      {drawer.drawdowns.length === 0 ? (
        <p className="text-sm text-slate-500">{t('grants.drawdownsEmpty')}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('grants.amount')}</TableHead>
              <TableHead>{t('grants.kind')}</TableHead>
              <TableHead>{t('grants.status')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {drawer.drawdowns.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="font-mono text-[13px]">{item.amount}</TableCell>
                <TableCell>{item.kind}</TableCell>
                <TableCell>
                  <Badge variant={DRAWDOWN_STATUS_VARIANT[item.status] ?? 'outline'}>{item.status}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {canManage && terms.status === 'active' ? (
        <div className="space-y-3 border-t border-slate-200 pt-3 dark:border-slate-800">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-32 flex-1">
              <Field label={t('grants.amount')}><Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></Field>
            </div>
            <div className="min-w-32">
              <Field label={t('grants.kind')}>
                <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                  {['advance', 'reimbursement', 'final'].map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <Button disabled={busy} onClick={() => onCommand({ action: 'createDrawdown', grantId: terms.id, amount, kind }, t('grants.drawdownCreated'))}>
              {t('grants.createDrawdownAction')}
            </Button>
          </div>
          {drafts.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {drafts.map((item) => (
                <Button key={item.id} disabled={busy} variant="outline" size="sm" onClick={() => onCommand({ action: 'submitDrawdown', drawdownId: item.id }, t('grants.drawdownSubmitted'))}>
                  {t('grants.submitDrawdownAction', { amount: item.amount })}
                </Button>
              ))}
            </div>
          ) : null}
          <PostingAccountsForm t={t} options={drawer.accountOptions} value={accounts} onChange={setAccounts} />
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-40">
              <Field label={t('grants.postingDate')}><Input type="date" value={postingDate} onChange={(e) => setPostingDate(e.target.value)} /></Field>
            </div>
            <Button
              disabled={busy}
              onClick={() => onPosting({
                action: 'recordDrawdown', grantId: terms.id,
                drawdownId: submitted[0]?.id, amount, kind, accounts, postingDate,
              }, t('grants.drawdownRecorded'))}
            >
              {t('grants.recordDrawdownAction')}
            </Button>
          </div>
          {paid.length > 0 && terms.determination === 'contribution_conditional' ? (
            <div className="flex flex-wrap gap-2">
              {paid.map((item) => (
                <Button
                  key={item.id}
                  disabled={busy}
                  variant="outline"
                  size="sm"
                  onClick={() => onPosting({
                    action: 'recognizeDrawdown', drawdownId: item.id,
                    grantRevenueAccountId: accounts.grantRevenueAccountId,
                    refundableAdvanceAccountId: accounts.refundableAdvanceAccountId,
                    postingDate,
                  }, t('grants.drawdownRecognized'))}
                >
                  {t('grants.recognizeAction', { amount: item.amount })}
                </Button>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-52 flex-1">
              <Field label={t('grants.reason')}><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            </div>
            {drawer.drawdowns.filter((item) => item.status !== 'void').map((item) => (
              <Button
                key={item.id}
                disabled={busy}
                variant="outline"
                size="sm"
                onClick={() => onPosting({ action: 'voidDrawdown', drawdownId: item.id, postingDate, reason }, t('grants.drawdownVoided'))}
              >
                {t('grants.voidDrawdownAction', { amount: item.amount })}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function GrantReportsTab({
  drawer,
  onCommand,
  busy,
  canManage,
}: {
  drawer: Extract<GrantDrawerData, { mode: 'record' }>
  onCommand: (payload: Record<string, unknown>, success: string) => Promise<boolean>
  busy: boolean
  canManage: boolean
}) {
  const t = useTranslations('nonprofit')
  const tc = useTranslations('common')
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [dueOn, setDueOn] = useState('')
  const list = useSublistRows(drawer.reports, (item) => `${item.title} ${item.dueOn}`)
  async function create() {
    const created = await onCommand({ action: 'createReport', grantId: drawer.terms.id, title, dueOn }, t('grants.reportCreated'))
    if (created) {
      setAdding(false)
      setTitle('')
      setDueOn('')
    }
  }
  return (
    <DrawerSublist
      title={t('grants.reportsTitle')}
      action={canManage ? <SublistAddButton label={t('grants.createReportAction')} onClick={() => setAdding(true)} /> : undefined}
      search={drawer.reports.length ? { value: list.query, onChange: list.setQuery, placeholder: t('grants.reportsSearch') } : undefined}
      footer={drawer.reports.length ? <SublistPager page={list.page} pages={list.pages} onPage={list.setPage} /> : null}
    >
      {drawer.reports.length === 0 ? (
        <SublistEmpty text={t('grants.reportsEmpty')} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('grants.reportTitle')}</TableHead>
              <TableHead>{t('grants.dueOn')}</TableHead>
              <TableHead>{t('grants.status')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.shown.map((item) => (
              <TableRow key={item.id}>
                <TableCell>{item.title}</TableCell>
                <TableCell className="font-mono text-[13px]">{item.dueOn}</TableCell>
                <TableCell>
                  <Badge variant={item.status === 'overdue' ? 'warning' : item.status === 'submitted' ? 'success' : 'outline'}>
                    {item.status}
                  </Badge>
                  {canManage && item.status !== 'submitted' ? (
                    <Button disabled={busy} variant="outline" size="sm" className="ml-2" onClick={() => onCommand({ action: 'submitReport', reportId: item.id }, t('grants.reportSubmitted'))}>
                      {t('grants.submitReportAction')}
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {canManage ? (
        <Drawer
          open={adding}
          onClose={() => { if (!busy) setAdding(false) }}
          stacked
          size="md"
          title={t('grants.createReportAction')}
          footer={(
            <>
              <Button variant="outline" disabled={busy} onClick={() => setAdding(false)}>{tc('actions.cancel')}</Button>
              <Button disabled={busy || !title.trim() || !dueOn} onClick={() => void create()}>{t('grants.createReportAction')}</Button>
            </>
          )}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('grants.reportTitle')}><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
            <Field label={t('grants.dueOn')}><Input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} /></Field>
          </div>
        </Drawer>
      ) : null}
    </DrawerSublist>
  )
}

function GrantActivityTab({ activity }: { activity: Extract<GrantDrawerData, { mode: 'record' }>['activity'] }) {
  const t = useTranslations('nonprofit')
  return (
    <div className="space-y-4">
      <div>
        <h4 className="mb-2 text-sm font-medium">{t('grants.journalEntries')}</h4>
        {activity.journalEntries.length === 0 ? (
          <p className="text-sm text-slate-500">{t('grants.activityEmpty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('grants.entryNumber')}</TableHead>
                <TableHead>{t('grants.postingDate')}</TableHead>
                <TableHead>{t('grants.status')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activity.journalEntries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="font-mono text-[13px]">{entry.entryNumber}</TableCell>
                  <TableCell className="font-mono text-[13px]">{entry.postingDate}</TableCell>
                  <TableCell>{entry.status}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      <div>
        <h4 className="mb-2 text-sm font-medium">{t('grants.changes')}</h4>
        {activity.changes.length === 0 ? (
          <p className="text-sm text-slate-500">{t('grants.activityEmpty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('grants.changeAction')}</TableHead>
                <TableHead>{t('grants.changeAt')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activity.changes.map((change) => (
                <TableRow key={change.id}>
                  <TableCell>{change.action}</TableCell>
                  <TableCell className="font-mono text-[13px]">{change.at}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}
