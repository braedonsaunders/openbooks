'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { AlertTriangle } from 'lucide-react'
import { Alert, Button, Drawer, Input, Label, Select, Textarea } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { promptDialog } from '../../../../lib/prompt'
import { useDirtyClose } from '../../../../lib/use-dirty-close'
import { programResourceUrl, validateMembershipDraft, type MembershipDraft } from '../../../../lib/hrm/benefits-portfolio'
import type { BuilderOption } from '../../../../lib/hrm/benefits-portfolio'
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
      // Settlement records draft awards: land on payouts where the drafts
      // appear for submit and approval.
      const base = closeHref.split('?')[0]
      router.push(`${base}?view=payouts` as never)
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

  return (
    <Drawer open onClose={() => void closeGuard.close()} title={program.name} description={program.code} size="lg">
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
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <div>
            <dt className="text-xs text-slate-500 dark:text-slate-400">{t('portfolio.columns.family')}</dt>
            <dd className="font-medium text-slate-900 dark:text-slate-100">{program.familyLabel}</dd>
          </div>
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
        </dl>

        {!drawer.drawerRefusal ? <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('portfolio.membersTitle')}</h3>
          {drawer.members.length === 0 ? (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{drawer.membersEmpty}</p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
              {drawer.members.map((m) => (
                <li key={m.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{m.employeeLabel}</span>
                  <span className="text-sm tabular-nums text-slate-500 dark:text-slate-400">{m.rangeLabel}</span>
                  {m.role ? <span className="text-xs text-slate-400 dark:text-slate-500">{m.role}</span> : null}
                  {m.weight !== null ? <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">{t('portfolio.members.weight')}: {m.weight}</span> : null}
                  {canManage && !drawer.drawerRefusal ? (
                    <button
                      type="button"
                      disabled={working}
                      onClick={() =>
                        void (async () => {
                          const removal = await promptDialog({
                            title: t('portfolio.removeReasonPrompt'),
                            label: t('portfolio.removeReasonPrompt'),
                            confirmLabel: t('portfolio.removeMember'),
                          })
                          if (removal === null) return
                          if (removal.trim() === '') {
                            toast.error(t('portfolio.removeReasonRequired'))
                            return
                          }
                          await act({ action: 'removeMember', membershipId: m.id, reason: removal.trim() })
                        })()
                      }
                      className="ml-auto text-xs text-red-700 underline-offset-2 hover:underline dark:text-red-300"
                    >
                      {t('portfolio.removeMember')}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {canManage && program.status !== 'closed' && !adding ? (
            <div className="mt-2 flex justify-end">
              <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
                {t('portfolio.addMember')}
              </Button>
            </div>
          ) : null}
          {adding ? (
            <div className="mt-2 flex flex-col gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <div>
                <Label htmlFor="program-member-employment">{t('portfolio.builder.fields.recipient')}</Label>
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
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setAdding(false)}>
                  {t('portfolio.builder.cancel')}
                </Button>
                <Button size="sm" disabled={working} onClick={addMember}>
                  {t('portfolio.addMember')}
                </Button>
              </div>
            </div>
          ) : null}
        </div> : null}

        {!drawer.drawerRefusal && program.family === 'incentive' && program.metric !== 'approved_hours' ? <div>
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

        {!drawer.drawerRefusal && program.family === 'incentive' ? (
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

        {canManage && !drawer.drawerRefusal ? (
          <div className="flex flex-wrap justify-end gap-2">
            {program.status === 'draft' ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => router.push(drawer.editHref as never)}
                >
                  {t('portfolio.editProgram')}
                </Button>
                <Button disabled={working} onClick={() => act({ action: 'activate' })}>
                  {t('portfolio.activateProgram')}
                </Button>
              </>
            ) : null}
            {program.status === 'active' && !closing ? (
              <Button variant="outline" onClick={() => setClosing(true)}>
                {t('portfolio.closeProgram')}
              </Button>
            ) : null}
          </div>
        ) : null}
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
    </Drawer>
  )
}
