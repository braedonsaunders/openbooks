'use client'

import Link from 'next/link'
import { useId, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { AlertTriangle } from 'lucide-react'
import { Alert, Button, Drawer, Input, Label, Select, Textarea } from '@openbooks/ui'
import { SublistAddButton, SublistHeading } from '../../../../components/drawer-sublist'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { promptDialog } from '../../../../lib/prompt'
import { useDirtyClose } from '../../../../lib/use-dirty-close'
import { programResourceUrl, validateMembershipDraft, type MembershipDraft } from '../../../../lib/hrm/benefits-portfolio'
import type { BuilderOption } from '../../../../lib/hrm/benefits-portfolio'
import { TransactionDrawer } from '../../../../components/transaction-drawer'
import { InspectorPanel } from '../../../../components/builder/builder-kit'
import { PreparedPagedTable } from '../../../../components/prepared-paged-table'
import { AwardPortfolioTable } from './PortfolioTables'
import type { ProgramDetailDrawer } from '../../../../lib/hrm/benefits-workspace'

/**
 * Program detail drawer, opened from a row through the `program=<id>`
 * search param. Loader-resolved policy, memberships, and incentive source
 * accounts with their amounts; closing navigates the param away.
 * Activation, closure (with the required reason), and membership writes
 * ride the benefit-programs route, and the list refreshes after every
 * transition. Preview reads the posted financial and approved time sources;
 * settlement records controlled awards only after the period has closed.
 */
export function ProgramDrawer({
  drawer,
  closeHref,
  canManage,
  employmentOptions,
}: {
  drawer: ProgramDetailDrawer
  closeHref: string
  /** Holds hrm.benefits.manage (mirrors the program route guards). */
  canManage: boolean
  employmentOptions: BuilderOption[]
}) {
  const t = useTranslations('hrm')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const reasonId = useId()
  const [working, setWorking] = useState(false)
  const searchParams = useSearchParams()
  const [tab, setTab] = useState(() => { const requested=searchParams.get('transactionTab'); return ['participants','activity','delivery','audit'].includes(requested ?? '') ? requested! : 'details' })
  const [closing, setClosing] = useState(false)
  const [reason, setReason] = useState('')
  const [adding, setAdding] = useState(false)
  const [simulateFrom, setSimulateFrom] = useState(drawer.simulation?.periodFrom ?? '')
  const [simulateTo, setSimulateTo] = useState(drawer.simulation?.periodTo ?? '')
  const [member, setMember] = useState<MembershipDraft>({
    employmentId: '',
    effectiveFrom: '',
    effectiveTo: '',
    weight: '',
    role: '',
  })
  const [memberError, setMemberError] = useState<string | null>(null)
  const program = drawer.program

  function close() {
    router.push(closeHref as never)
    router.refresh()
  }

  const closeGuard = useDirtyClose({
    dirty: reason.trim().length > 0 || adding,
    busy: working,
    onClose: close,
    message: tCommon('feedback.unsavedChanges'),
    confirmLabel: tCommon('confirm.discardChanges'),
  })

  async function act(body: Record<string, unknown>) {
    setWorking(true)
    try {
      // Activation and closure patch the program resource; the id rides the
      // path, never the body.
      const res = await fetch(programResourceUrl(program.id), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t('portfolio.programActionFailed')))
        return
      }
      setClosing(false)
      setAdding(false)
      router.refresh()
    } catch {
      toast.error(t('portfolio.programActionFailed'))
    } finally {
      setWorking(false)
    }
  }

  async function addMember() {
    const errors = validateMembershipDraft(member)
    if (program.allocation === 'role' && member.weight.trim() === '') errors.weight = 'portfolio.validation.weight'
    const first = errors.employmentId ?? errors.effectiveFrom ?? errors.effectiveTo ?? errors.weight
    if (first) {
      setMemberError(t(first))
      return
    }
    setMemberError(null)
    setWorking(true)
    try {
      // Membership writes post the program resource; the program id rides
      // the path, never the body.
      const res = await fetch(programResourceUrl(program.id), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'addMember',
          employmentId: member.employmentId,
          effectiveFrom: member.effectiveFrom,
          effectiveTo: member.effectiveTo === '' ? null : member.effectiveTo,
          weight: member.weight.trim() === '' ? null : member.weight.trim(),
          role: member.role.trim() === '' ? null : member.role.trim(),
        }),
      })
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t('portfolio.programActionFailed')))
        return
      }
      setAdding(false)
      setMember({ employmentId: '', effectiveFrom: '', effectiveTo: '', weight: '', role: '' })
      router.refresh()
    } catch {
      toast.error(t('portfolio.programActionFailed'))
    } finally {
      setWorking(false)
    }
  }

  async function settle() {
    if (!drawer.simulation) return
    setWorking(true)
    try {
      // Settlement records one draft award per payable recipient,
      // atomically and idempotently: a retried settlement returns the
      // existing awards when revision, sources, and values match.
      const res = await fetch(programResourceUrl(program.id), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'settle',
          periodFrom: drawer.simulation.periodFrom,
          periodTo: drawer.simulation.periodTo,
        }),
      })
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t('portfolio.programActionFailed')))
        return
      }
      // Settlement opens the delivery workspace with the recorded obligations.
      const base = closeHref.split('?')[0]
      router.push(`${base}?view=delivery` as never)
      router.refresh()
    } catch {
      toast.error(t('portfolio.programActionFailed'))
    } finally {
      setWorking(false)
    }
  }

  function simulate() {
    if (!simulateFrom || !simulateTo) {
      toast.error(t('portfolio.simulatePeriodRequired'))
      return
    }
    const separator = drawer.simulateHref.includes('?') ? '&' : '?'
    router.push(
      `${drawer.simulateHref}${separator}simulate=1&periodFrom=${encodeURIComponent(simulateFrom)}&periodTo=${encodeURIComponent(simulateTo)}` as never,
    )
  }

  const lifecycleActions = <>        {canManage && !drawer.drawerRefusal ? (
          <div className="flex flex-wrap justify-end gap-2">
            {program.status === 'draft' ? (
              <>
                <Button disabled={working} onClick={() => act({ action: 'activate' })}>
                  {t('portfolio.activateProgram')}
                </Button>
              </>
            ) : null}
            {program.status === 'active' && !closing ? (
              <Button variant="outline" onClick={() => {setClosing(true);setTab('details')}}>
                {t('portfolio.closeProgram')}
              </Button>
            ) : null}
          </div>
        ) : null}
</>
  const tableText = {
    program: t('portfolio.columns.program'), recipient: t('portfolio.columns.recipient'),
    period: t('portfolio.columns.period'), value: t('portfolio.columns.value'), status: t('portfolio.columns.status'),
    emptyTitle: t('portfolio.awardsEmptyTitle'), emptyDescription: t('programWorkspace.activityEmpty'),
    totalLabel: t('portfolio.totalLabel'), truncatedLabel: t('portfolio.awardsTruncated'),
  }
  const activity = <div className="space-y-4 p-4">
    {program.family !== 'incentive' && canManage && program.status === 'active' ? <div className="flex justify-end"><Button asChild size="sm"><Link href={`${program.programHref}&award=new` as never}>{t(program.family === 'reward' ? 'programWorkspace.giveReward' : 'programWorkspace.createGrant')}</Link></Button></div> : null}
    {drawer.activityRefusal ? <Alert variant="destructive">{drawer.activityRefusal.message}</Alert> : <AwardPortfolioTable rows={drawer.activity} text={tableText} total={drawer.activity.length} truncated={drawer.activityTruncated} />}
  </div>
  const deliveryRows = drawer.activity.filter(award => ['approved', 'queued', 'delivered'].includes(award.status))
  return (
    <TransactionDrawer recordId={program.id} targetTable="hrm_benefit_programs" closeHref={closeHref}
      title={program.name} description={program.code} beforeClose={closeGuard.beforeClose} actions={lifecycleActions}
      primaryAction={canManage && program.status === 'draft' && !drawer.drawerRefusal ? <Button variant="outline" size="sm" onClick={()=>router.push(drawer.editHref as never)}>{t('portfolio.editProgram')}</Button> : null}
      showAttachments={false} detailsLabel={t('programWorkspace.rules')} activeTab={tab} onActiveTabChange={setTab}
      detailTabs={[
        { key: 'participants', label: t('programWorkspace.participants'), content: <div className="p-4">        {!drawer.drawerRefusal ? <div>
          <div className="mb-3 flex items-start justify-between gap-3">
            <SublistHeading title={t('portfolio.membersTitle')} />
            {canManage && program.status !== 'closed' ? (
              <div className="shrink-0"><SublistAddButton label={t('portfolio.addMember')} onClick={() => setAdding(true)} /></div>
            ) : null}
          </div>
          <PreparedPagedTable source="hrm_benefit_program_participants" rows={drawer.members.map(m => ({
            id:m.id,searchText:`${m.employeeLabel} ${m.role ?? ''}`,cells:[
              m.employeeHref ? <Link key="employee" href={m.employeeHref as never} className="font-medium text-teal-700 hover:underline">{m.employeeLabel}</Link> : m.employeeLabel,
              <span key="range" className="tabular-nums">{m.rangeLabel}</span>,m.role ?? '—',m.weight ?? '—',
              canManage && program.status !== 'closed' ? <Button key="remove" variant="ghost" size="sm" disabled={working} onClick={async()=>{
                const removal=await promptDialog({title:t('portfolio.removeReasonPrompt'),label:t('portfolio.removeReasonPrompt'),confirmLabel:t('portfolio.removeMember')})
                if(removal===null) return
                if(!removal.trim()){toast.error(t('portfolio.removeReasonRequired'));return}
                await act({action:'removeMember',membershipId:m.id,reason:removal.trim()})
              }}>{t('portfolio.removeMember')}</Button> : null,
            ],
          }))} columns={[{key:'employee',header:t('benefits.columns.employee')},{key:'effective',header:t('portfolio.columns.effective')},{key:'role',header:t('portfolio.members.role')},{key:'weight',header:t('portfolio.members.weight'),align:'right'},{key:'actions',header:''}]} empty={<p>{drawer.membersEmpty}</p>} />
          <Drawer
            open={adding && canManage && program.status !== 'closed'}
            onClose={() => { if (!working) setAdding(false) }}
            stacked
            size="md"
            title={t('portfolio.addMember')}
            footer={(
              <>
                <Button variant="outline" disabled={working} onClick={() => setAdding(false)}>
                  {t('portfolio.builder.cancel')}
                </Button>
                <Button disabled={working} onClick={addMember}>
                  {t('portfolio.addMember')}
                </Button>
              </>
            )}
          >
            <div className="flex flex-col gap-3">
              <div>
                <Label htmlFor="program-member-employment">{t('portfolio.awardFields.recipient')}</Label>
                <Select
                  id="program-member-employment"
                  value={member.employmentId}
                  onChange={(e) => setMember((c) => ({ ...c, employmentId: e.target.value }))}
                >
                  <option value="">{t('portfolio.builder.chooseRecipient')}</option>
                  {employmentOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="program-member-from">{t('portfolio.builder.fields.effectiveFrom')}</Label>
                  <Input
                    id="program-member-from"
                    type="date"
                    value={member.effectiveFrom}
                    onChange={(e) => setMember((c) => ({ ...c, effectiveFrom: e.target.value }))}
                  />
                </div>
                <div>
                  <Label htmlFor="program-member-to">{t('portfolio.builder.fields.effectiveTo')}</Label>
                  <Input
                    id="program-member-to"
                    type="date"
                    value={member.effectiveTo}
                    onChange={(e) => setMember((c) => ({ ...c, effectiveTo: e.target.value }))}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="program-member-weight">{t('portfolio.members.weight')}</Label>
                  <Input
                    id="program-member-weight"
                    inputMode="decimal"
                    value={member.weight}
                    onChange={(e) => setMember((c) => ({ ...c, weight: e.target.value }))}
                    placeholder={t('portfolio.members.weightPlaceholder')}
                  />
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('portfolio.members.weightHint')}</p>
                </div>
                <div>
                  <Label htmlFor="program-member-role">{t('portfolio.members.role')}</Label>
                  <Input
                    id="program-member-role"
                    value={member.role}
                    onChange={(e) => setMember((c) => ({ ...c, role: e.target.value }))}
                    placeholder={t('portfolio.members.rolePlaceholder')}
                  />
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('portfolio.members.roleHint')}</p>
                </div>
              </div>
              {memberError ? (
                <p role="alert" className="text-xs text-red-700 dark:text-red-300">
                  {memberError}
                </p>
              ) : null}
            </div>
          </Drawer>
        </div> : null}

</div> },
        { key: 'activity', label: t(program.family === 'incentive' ? 'programWorkspace.calculations' : 'programWorkspace.activity'), content: <div>        {!drawer.drawerRefusal && program.family === 'incentive' ? (
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('portfolio.simulate.title')}</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="program-simulate-from">{t('portfolio.simulate.periodFrom')}</Label>
                <Input id="program-simulate-from" type="date" value={simulateFrom} onChange={(e) => setSimulateFrom(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="program-simulate-to">{t('portfolio.simulate.periodTo')}</Label>
                <Input id="program-simulate-to" type="date" value={simulateTo} onChange={(e) => setSimulateTo(e.target.value)} />
              </div>
            </div>
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={simulate}>
                {t('portfolio.simulate.run')}
              </Button>
            </div>
            {drawer.simulationRefusal ? (
              <Alert variant="destructive" className="flex items-start gap-2">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span>
                  <span className="block font-medium">{drawer.simulationRefusal.title}</span>
                  <span className="block text-xs">{drawer.simulationRefusal.message}</span>
                </span>
              </Alert>
            ) : null}
            {drawer.simulation ? (
              <div className="flex flex-col gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                {drawer.simulation.isEstimate ? (
                  <Alert variant="default" className="flex items-start gap-2">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                    <span>{t('portfolio.simulate.estimate')}</span>
                  </Alert>
                ) : null}
                <ul className="space-y-1">
                  {drawer.simulation.summaryLines.map((line) => (
                    <li key={line} className="text-xs text-slate-600 dark:text-slate-300">
                      {line}
                    </li>
                  ))}
                </ul>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  {drawer.simulation.measuredLines.map((line) => (
                    <div key={line.label} className="flex items-baseline justify-between gap-2">
                      <dt className="text-slate-500 dark:text-slate-400">{line.label}</dt>
                      <dd className="font-medium tabular-nums text-slate-900 dark:text-slate-100">{line.value}</dd>
                    </div>
                  ))}
                </dl>
                {drawer.simulation.recipients.length === 0 ? (
                  <p className="text-sm text-slate-500 dark:text-slate-400">{t('portfolio.simulate.noRecipients')}</p>
                ) : (
                  <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                    {drawer.simulation.recipients.map((recipient) => (
                      <li key={recipient.employmentId} className="py-2">
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                          <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{recipient.employeeLabel}</span>
                          <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">{recipient.share}</span>
                          <span className="ml-auto text-sm font-medium tabular-nums text-slate-900 dark:text-slate-100">
                            {recipient.netValue}
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{recipient.explanation}</p>
                      </li>
                    ))}
                  </ul>
                )}
                {drawer.simulation.excluded.length > 0 ? (
                  <ul className="space-y-1">
                    {drawer.simulation.excluded.map((line) => (
                      <li key={line} className="text-xs text-amber-700 dark:text-amber-300">
                        {line}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-slate-500 dark:text-slate-400">{t('portfolio.simulate.totalAwarded')}</span>
                  <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                    {drawer.simulation.totalAwarded}
                  </span>
                </div>
                {canManage && program.status === 'active' && !drawer.simulation.isEstimate ? (
                  <div className="flex justify-end">
                    <Button disabled={working} onClick={settle}>
                      {t('portfolio.simulate.settle')}
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

{activity}</div> },
        { key: 'delivery', label: t('programWorkspace.delivery'), content: <div className="space-y-4 p-4"><p className="text-sm text-slate-500">{t('programWorkspace.deliveryHint')}</p>{drawer.activityRefusal ? <Alert variant="destructive">{drawer.activityRefusal.message}</Alert> : <AwardPortfolioTable rows={deliveryRows} text={tableText} total={deliveryRows.length} truncated={drawer.activityTruncated} />}</div> },
      ]}>
      <div className="flex flex-col gap-5 p-4">
        {drawer.drawerRefusal ? (
          <Alert variant="destructive" className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>
              <span className="block font-medium">{drawer.drawerRefusal.title}</span>
              <span className="block text-xs">{drawer.drawerRefusal.message}</span>
              <Button variant="outline" size="sm" onClick={() => router.refresh()}>{tCommon('actions.retry')}</Button>
            </span>
          </Alert>
        ) : null}
        {program.metric === 'transactions' ? <Button asChild variant="outline"><Link href={`/hrm/benefits?view=programs&transactionRules=${program.id}` as never}>{t('portfolio.transactionRules')}</Link></Button> : null}
        <InspectorPanel title={program.familyLabel}><dl className="grid gap-x-4 gap-y-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-slate-500 dark:text-slate-400">{t('portfolio.columns.status')}</dt>
            <dd className="font-medium text-slate-900 dark:text-slate-100">{program.statusLabel}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500 dark:text-slate-400">{t('portfolio.columns.value')}</dt>
            <dd className="font-medium tabular-nums text-slate-900 dark:text-slate-100">{program.valueLabel}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500 dark:text-slate-400">{t('portfolio.columns.effective')}</dt>
            <dd className="font-medium tabular-nums text-slate-900 dark:text-slate-100">
              {program.effectiveTo ? `${program.effectiveFrom} – ${program.effectiveTo}` : `${program.effectiveFrom} – …`}
            </dd>
          </div>
          {drawer.policyLines.map((line) => <div key={`${line.label}:${line.value}`}>
            <dt className="text-xs text-slate-500 dark:text-slate-400">{line.label}</dt>
            <dd className="font-medium text-slate-900 dark:text-slate-100">{line.value}</dd>
          </div>)}
        </dl></InspectorPanel>

        <InspectorPanel title={t('portfolio.approvalControls.title')}>
          {program.approvalMode === 'none' ? <p className="text-sm text-slate-500 dark:text-slate-400">{t('portfolio.approvalControls.modes.none')} · {t('portfolio.approvalControls.noneHint')}</p> : drawer.approvalPoliciesRefusal ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{drawer.approvalPoliciesRefusal.message}</p> : <>
            <p className="text-sm text-slate-500 dark:text-slate-400">{t(drawer.approvalPolicies?.configured ? 'portfolio.approvalControls.policiesHint' : 'portfolio.approvalControls.unconfiguredStatus')}</p>
            {drawer.approvalPolicies?.policies.map((policy) => drawer.canConfigureApprovalPolicies ? <Link key={policy.id} href={policy.href as never} className="text-sm font-medium text-teal-700 hover:underline dark:text-teal-300">{policy.name}</Link> : <p key={policy.id} className="text-sm font-medium">{policy.name}</p>)}
            {drawer.canConfigureApprovalPolicies ? <div><Button asChild variant="outline" size="sm"><Link href={(drawer.approvalPolicies?.href ?? '/admin/flows') as never}>{t('portfolio.approvalControls.openFlows')}</Link></Button></div> : <p className="text-sm text-slate-500 dark:text-slate-400">{t('portfolio.approvalControls.administratorRemedy')}</p>}
          </>}
        </InspectorPanel>

        {!drawer.drawerRefusal && program.family === 'incentive' && program.metric !== 'approved_hours' && program.metric !== 'transactions' ? <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('portfolio.sourcesTitle')}</h3>
          {drawer.sources.length === 0 ? (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{drawer.sourcesEmpty}</p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
              {drawer.sources.map((s) => (
                <li key={s.id} className="flex items-baseline justify-between gap-3 py-1.5">
                  <span className="text-sm text-slate-600 dark:text-slate-300">{s.accountLabel}</span>
                </li>
              ))}
            </ul>
          )}
        </div> : null}

        {closing ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor={reasonId}>{t('portfolio.closeReasonLabel')}</Label>
            <Textarea id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} required />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setClosing(false)}>
                {t('portfolio.builder.cancel')}
              </Button>
              <Button disabled={working || !reason.trim()} onClick={() => act({ action: 'close', reason: reason.trim() })}>
                {t('portfolio.closeProgram')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </TransactionDrawer>
  )
}
