'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  Badge,
  Button,
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
} from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../../lib/api-error'

/**
 * The automation recipe builder — the brief-sanctioned linear recipe mode.
 *
 * The flows builder is graph-based (nodes.tsx cards over TriggerData /
 * ActionData); the six automation trigger kinds and the changed_to /
 * contains / is_null condition ops have no vocabulary there, so the recipe
 * edits as three linear panels — Trigger, Who and When (rules + the
 * all/any condition tree), Actions (ordered) — over the same @openbooks/ui
 * primitives. No new graph node or card components: this is the recipe
 * mode, not a second builder. Every save PATCHes the recipe (version
 * bumps); res.ok is checked before any body is parsed.
 */

export type BuilderAutomation = {
  id: string
  name: string
  description: string | null
  status: string
  version: number
  trigger: Record<string, unknown>
  rules: Record<string, unknown>
  conditions: Record<string, unknown>
  actions: Record<string, unknown>[]
  errorMessage: string | null
}

export type BuilderRun = {
  id: string
  status: string
  version: number
  subjectKind: string | null
  createdAt: string
}

const TRIGGER_KINDS = ['schedule', 'date_relative', 'field_change', 'event', 'document', 'manual'] as const
// field_change, event and document are not offered: no production writer
// stages their events, so enabling a recipe on one is refused by the API —
// offering them would report success for work that never happened.
const UNAVAILABLE_TRIGGER_KINDS = ['field_change', 'event', 'document'] as const
// delay, approve_step, start_flow and webhook are not offered: none has
// real execution semantics (no continuation store, no gate minting, no
// flow dispatch, no webhook transport), so offering them would report
// success for work that never happened. The API refuses them at publish
// with the remedy named; stored legacy rows still render as JSON below.
const ACTION_KINDS = ['create_task', 'send_email', 'send_notification', 'start_process', 'update_field'] as const
const CONDITION_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'is_null', 'changed_to'] as const

type ConditionLeaf = { field: string; op: string; value: string }

function toLeaves(conditions: Record<string, unknown>): { mode: 'all' | 'any'; leaves: ConditionLeaf[] } {
  const root = conditions.root as { all?: unknown[]; any?: unknown[] } | undefined
  const list = Array.isArray(root?.all) ? root.all : Array.isArray(root?.any) ? root.any : []
  const mode = Array.isArray(root?.any) ? 'any' : 'all'
  const leaves = (list as Record<string, unknown>[]).filter((n) => typeof n.field === 'string').map((n) => ({
    field: String(n.field),
    op: typeof n.op === 'string' ? n.op : 'eq',
    value: n.value === undefined || n.value === null ? '' : typeof n.value === 'string' ? n.value : JSON.stringify(n.value),
  }))
  return { mode, leaves }
}

function fromLeaves(mode: 'all' | 'any', leaves: ConditionLeaf[]): Record<string, unknown> {
  if (leaves.length === 0) return {}
  const nodes = leaves.filter((l) => l.field.trim()).map((l) => {
    let value: unknown = l.value
    if (l.value !== '') {
      try {
        value = JSON.parse(l.value)
      } catch {
        value = l.value
      }
    }
    return { field: l.field.trim(), op: l.op, ...(l.op === 'is_null' ? {} : { value }) }
  })
  return { root: { [mode]: nodes } }
}

export function AutomationBuilder({
  automation,
  runs,
  canSimulate,
  canManage,
  saveFailed,
  backHref,
  backLabel,
}: {
  automation: BuilderAutomation
  runs: BuilderRun[]
  canSimulate: boolean
  canManage: boolean
  saveFailed: string
  backHref: string
  backLabel: string
}) {
  const t = useTranslations('admin.automations')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [name, setName] = useState(automation.name)
  const [version, setVersion] = useState(automation.version)
  const [trigger, setTrigger] = useState<Record<string, unknown>>({ ...automation.trigger })
  // Per-kind trigger config: replacing the whole trigger on a kind switch
  // discarded everything typed for the previous kind (a schedule cron did
  // not survive a round-trip through manual). The cache stashes each kind's
  // fields as it is left and restores them on return; a kind never visited
  // starts clean. Only the current kind's fields ever save.
  const triggerCache = useRef<Record<string, Record<string, unknown>>>({
    [String(automation.trigger.kind ?? 'manual')]: { ...automation.trigger },
  })

  function setTriggerKind(nextKind: string) {
    setTrigger((prev) => {
      const prevKind = String(prev.kind ?? 'manual')
      triggerCache.current[prevKind] = { ...prev }
      const cached = triggerCache.current[nextKind]
      return cached ? { ...cached, kind: nextKind } : { kind: nextKind }
    })
  }
  const [rules, setRules] = useState<Record<string, unknown>>({ ...(automation.rules ?? {}) })
  const cond = toLeaves((automation.conditions ?? {}) as Record<string, unknown>)
  const [condMode, setCondMode] = useState<'all' | 'any'>(cond.mode)
  const [leaves, setLeaves] = useState<ConditionLeaf[]>(cond.leaves)
  const [actions, setActions] = useState<Record<string, unknown>[]>([...automation.actions])
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'build' | 'runs'>('build')
  const [simSubject, setSimSubject] = useState('')
  const [simSteps, setSimSteps] = useState<{ index: number; kind: string; status: string; output?: string; error?: string }[] | null>(null)
  // A refused save names what happened and offers the way back. Local edits
  // stay until the editor chooses Reload, which re-seeds from the loader
  // (the WeeklyGrid stale-revision arrangement).
  const [conflict, setConflict] = useState<string | null>(null)
  const seededVersion = useRef(automation.version)
  useEffect(() => {
    if (seededVersion.current === automation.version) return
    seededVersion.current = automation.version
    setName(automation.name)
    setTrigger({ ...automation.trigger })
    triggerCache.current = {
      [String(automation.trigger.kind ?? 'manual')]: { ...automation.trigger },
    }
    setRules({ ...(automation.rules ?? {}) })
    const reseeded = toLeaves((automation.conditions ?? {}) as Record<string, unknown>)
    setCondMode(reseeded.mode)
    setLeaves(reseeded.leaves)
    setActions([...automation.actions])
    setVersion(automation.version)
    setConflict(null)
  }, [automation])

  const kind = String(trigger.kind ?? 'manual')
  // Readers (automations.read without automations.manage) see the whole
  // recipe but change nothing: every input below takes disabled={ro} and
  // every mutating button renders only for managers. Simulate stays: its
  // API is read-guarded, so running it changes no stored state.
  const ro = !canManage

  async function patch(body: Record<string, unknown>, success: string) {
    setBusy(true)
    setConflict(null)
    try {
      const res = await fetch(`/api/automations/${automation.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, expectedVersion: version }),
      })
      if (res.status === 409) {
        // Another editor saved first: nothing was written. Park the named
        // refusal as a notice with a Reload path and keep the local edits
        // until the editor reloads.
        const message = await readApiErrorMessage(res, saveFailed)
        setConflict(message)
        toast.error(message)
        return
      }
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, saveFailed))
        return
      }
      const payload = (await res.json().catch(() => ({}))) as {
        automation?: { version?: unknown }
      }
      if (typeof payload.automation?.version === 'number') setVersion(payload.automation.version)
      toast.success(success)
      router.refresh()
    } catch {
      toast.error(saveFailed)
    } finally {
      setBusy(false)
    }
  }

  function setTriggerField(key: string, value: string) {
    setTrigger((prev) => ({ ...prev, [key]: value }))
  }

  function setRuleField(key: string, value: string) {
    setRules((prev) => ({ ...prev, [key]: value === '' ? null : value }))
  }

  function updateLeaf(index: number, patchLeaf: Partial<ConditionLeaf>) {
    setLeaves((prev) => prev.map((l, i) => (i === index ? { ...l, ...patchLeaf } : l)))
  }

  function updateAction(index: number, patchAction: Record<string, unknown>) {
    setActions((prev) => prev.map((a, i) => (i === index ? { ...a, ...patchAction } : a)))
  }

  function moveAction(index: number, delta: -1 | 1) {
    setActions((prev) => {
      const next = [...prev]
      const j = index + delta
      if (j < 0 || j >= next.length) return prev
      const tmp = next[index]!
      next[index] = next[j]!
      next[j] = tmp
      return next
    })
  }

  async function simulate() {
    setBusy(true)
    setSimSteps(null)
    try {
      const [entity, id] = simSubject.includes(':') ? simSubject.split(':', 2) as [string, string] : [simSubject || undefined, undefined]
      const res = await fetch(`/api/automations/${automation.id}/simulate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...(entity ? { subjectEntity: entity } : {}), ...(id ? { subjectId: id } : {}) }),
      })
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, saveFailed))
        return
      }
      const payload = (await res.json().catch(() => ({}))) as { simulations?: { steps?: { index: number; kind: string; status: string; output?: string; error?: string }[] }[] }
      setSimSteps(payload.simulations?.[0]?.steps ?? [])
    } catch {
      toast.error(saveFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={backHref} className="text-sm font-medium text-teal-700 hover:underline dark:text-teal-300">
          ← {backLabel}
        </Link>
        <h1 className="text-lg font-semibold">{automation.name}</h1>
        <Badge variant={automation.status === 'enabled' ? 'success' : automation.status === 'error' ? 'destructive' : 'secondary'}>
          {automation.status}
        </Badge>
        <span className="text-xs text-slate-500 tabular-nums">v{version}</span>
      </div>
      {conflict ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
          role="alert"
        >
          <span className="min-w-52 flex-1">{conflict}</span>
          <Button size="sm" variant="outline" onClick={() => router.refresh()}>
            {tCommon('actions.refresh')}
          </Button>
        </div>
      ) : null}
      {automation.errorMessage ? (
        <p className="text-sm text-red-600 dark:text-red-400">{automation.errorMessage}</p>
      ) : null}
      {canManage ? null : (
        <p className="text-sm text-slate-600 dark:text-slate-300">{t('builder.readOnlyNotice')}</p>
      )}
      <div className="inline-flex items-center gap-2">
        <Button variant={tab === 'build' ? 'default' : 'outline'} onClick={() => setTab('build')}>{t('builder.buildTab')}</Button>
        <Button variant={tab === 'runs' ? 'default' : 'outline'} onClick={() => setTab('runs')}>{t('builder.runsTab')}</Button>
      </div>

      {tab === 'build' ? (
        <>
          <section className="rounded-lg border bg-white p-4 dark:bg-slate-900">
            <h2 className="text-sm font-semibold">{t('builder.nameTitle')}</h2>
            <div className="mt-2 grid gap-2">
              <Label htmlFor="ab-name">{t('list.nameLabel')}</Label>
              <Input id="ab-name" value={name} onChange={(e) => setName(e.target.value)} disabled={ro} />
              {canManage ? <div><Button disabled={busy} onClick={() => patch({ name }, t('builder.saved'))}>{t('builder.saveName')}</Button></div> : null}
            </div>
          </section>

          <section className="rounded-lg border bg-white p-4 dark:bg-slate-900">
            <h2 className="text-sm font-semibold">{t('builder.triggerTitle')}</h2>
            <div className="mt-2 grid gap-2">
              <Label htmlFor="ab-trigger-kind">{t('list.triggerLabel')}</Label>
              <Select id="ab-trigger-kind" value={kind} onChange={(e) => setTriggerKind(e.target.value)} disabled={ro}>
                {TRIGGER_KINDS.map((k) => {
                  const unavailable = (UNAVAILABLE_TRIGGER_KINDS as readonly string[]).includes(k)
                  return (
                    <option key={k} value={k} disabled={unavailable}>
                      {t(`triggerKinds.${k}`)}{unavailable ? ` (${t('triggerKindUnavailable')})` : ''}
                    </option>
                  )
                })}
              </Select>
              {(UNAVAILABLE_TRIGGER_KINDS as readonly string[]).includes(kind) ? (
                <p className="text-sm text-amber-700 dark:text-amber-300">{t('triggerKindUnavailableNote')}</p>
              ) : null}
              {kind === 'schedule' ? (
                <>
                  <Label htmlFor="ab-cron">{t('builder.cronLabel')}</Label>
                  <Input id="ab-cron" value={String(trigger.cron ?? '')} onChange={(e) => setTriggerField('cron', e.target.value)} placeholder="0 9 * * MON" disabled={ro} />
                  <Label htmlFor="ab-tz">{t('builder.timezoneLabel')}</Label>
                  <Input id="ab-tz" value={String(trigger.timezone ?? 'UTC')} onChange={(e) => setTriggerField('timezone', e.target.value)} disabled={ro} />
                </>
              ) : null}
              {kind === 'date_relative' ? (
                <>
                  <Label htmlFor="ab-entity">{t('builder.entityLabel')}</Label>
                  <Input id="ab-entity" value={String(trigger.entity ?? '')} onChange={(e) => setTriggerField('entity', e.target.value)} disabled={ro} />
                  <Label htmlFor="ab-datefield">{t('builder.dateFieldLabel')}</Label>
                  <Input id="ab-datefield" value={String(trigger.dateField ?? '')} onChange={(e) => setTriggerField('dateField', e.target.value)} disabled={ro} />
                  <Label htmlFor="ab-offset">{t('builder.offsetLabel')}</Label>
                  <Input id="ab-offset" value={String(trigger.offsetDays ?? 0)} onChange={(e) => setTriggerField('offsetDays', e.target.value)} disabled={ro} />
                  <Label htmlFor="ab-direction">{t('builder.directionLabel')}</Label>
                  <Select id="ab-direction" value={String(trigger.direction ?? 'before')} onChange={(e) => setTriggerField('direction', e.target.value)} disabled={ro}>
                    <option value="before">{t('builder.before')}</option>
                    <option value="after">{t('builder.after')}</option>
                  </Select>
                  <Label htmlFor="ab-attime">{t('builder.atTimeLabel')}</Label>
                  <Input id="ab-attime" value={String(trigger.atTime ?? '09:00')} onChange={(e) => setTriggerField('atTime', e.target.value)} placeholder="09:00" disabled={ro} />
                </>
              ) : null}
              {kind === 'field_change' ? (
                <>
                  <Label htmlFor="ab-fc-entity">{t('builder.entityLabel')}</Label>
                  <Input id="ab-fc-entity" value={String(trigger.entity ?? '')} onChange={(e) => setTriggerField('entity', e.target.value)} disabled={ro} />
                  <Label htmlFor="ab-fc-field">{t('builder.fieldLabel')}</Label>
                  <Input id="ab-fc-field" value={String(trigger.field ?? '')} onChange={(e) => setTriggerField('field', e.target.value)} disabled={ro} />
                  <Label htmlFor="ab-fc-to">{t('builder.changedToLabel')}</Label>
                  <Input id="ab-fc-to" value={String(trigger.to ?? '')} onChange={(e) => setTriggerField('to', e.target.value)} disabled={ro} />
                </>
              ) : null}
              {kind === 'event' ? (
                <>
                  <Label htmlFor="ab-ev-subject">{t('builder.subjectKindLabel')}</Label>
                  <Input id="ab-ev-subject" value={String(trigger.subjectKind ?? '')} onChange={(e) => setTriggerField('subjectKind', e.target.value)} disabled={ro} />
                  <Label htmlFor="ab-ev-kind">{t('builder.eventKindLabel')}</Label>
                  <Input id="ab-ev-kind" value={String(trigger.eventKind ?? '')} onChange={(e) => setTriggerField('eventKind', e.target.value)} disabled={ro} />
                </>
              ) : null}
              {kind === 'document' ? (
                <>
                  <Label htmlFor="ab-doc-event">{t('builder.eventKindLabel')}</Label>
                  <Select id="ab-doc-event" value={String(trigger.event ?? 'signed')} onChange={(e) => setTriggerField('event', e.target.value)} disabled={ro}>
                    <option value="uploaded">{t('builder.documentUploaded')}</option>
                    <option value="signed">{t('builder.documentSigned')}</option>
                    <option value="created_from_template">{t('builder.documentTemplated')}</option>
                  </Select>
                </>
              ) : null}
              {canManage ? <div><Button disabled={busy} onClick={() => patch({ trigger }, t('builder.saved'))}>{t('builder.saveTrigger')}</Button></div> : null}
            </div>
          </section>

          <section className="rounded-lg border bg-white p-4 dark:bg-slate-900">
            <h2 className="text-sm font-semibold">{t('builder.whoWhenTitle')}</h2>
            <p className="mt-1 text-xs text-slate-500">{t('builder.whoWhenHelp')}</p>
            <div className="mt-2 grid gap-2">
              {( ['subsidiaryId', 'departmentId', 'locationId', 'workerType', 'positionId'] as const ).map((key) => (
                <div key={key} className="grid gap-1">
                  <Label htmlFor={`ab-rule-${key}`}>{t(`builder.rule_${key}`)}</Label>
                  <Input
                    id={`ab-rule-${key}`}
                    value={typeof rules[key] === 'string' ? (rules[key] as string) : ''}
                    onChange={(e) => setRuleField(key, e.target.value)}
                    placeholder={t('builder.ruleBlank')}
                    disabled={ro}
                  />
                </div>
              ))}
              <div className="grid gap-1">
                <Label htmlFor="ab-cond-mode">{t('builder.conditionsMode')}</Label>
                <Select id="ab-cond-mode" value={condMode} onChange={(e) => setCondMode(e.target.value as 'all' | 'any')} disabled={ro}>
                  <option value="all">{t('builder.conditionsAll')}</option>
                  <option value="any">{t('builder.conditionsAny')}</option>
                </Select>
              </div>
              {leaves.map((leaf, i) => (
                <div key={i} className="grid grid-cols-[1fr_130px_1fr_auto] items-end gap-2">
                  <div className="grid gap-1">
                    <Label htmlFor={`ab-leaf-field-${i}`}>{t('builder.fieldLabel')}</Label>
                    <Input id={`ab-leaf-field-${i}`} value={leaf.field} onChange={(e) => updateLeaf(i, { field: e.target.value })} disabled={ro} />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor={`ab-leaf-op-${i}`}>{t('builder.opLabel')}</Label>
                    <Select id={`ab-leaf-op-${i}`} value={leaf.op} onChange={(e) => updateLeaf(i, { op: e.target.value })} disabled={ro}>
                      {CONDITION_OPS.map((op) => <option key={op} value={op}>{op}</option>)}
                    </Select>
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor={`ab-leaf-value-${i}`}>{t('builder.valueLabel')}</Label>
                    <Input id={`ab-leaf-value-${i}`} value={leaf.value} onChange={(e) => updateLeaf(i, { value: e.target.value })} disabled={leaf.op === 'is_null' || ro} />
                  </div>
                  {canManage ? <Button variant="outline" onClick={() => setLeaves((prev) => prev.filter((_, j) => j !== i))}>{t('builder.remove')}</Button> : null}
                </div>
              ))}
              {canManage ? (
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setLeaves((prev) => [...prev, { field: '', op: 'eq', value: '' }])}>{t('builder.addCondition')}</Button>
                <Button disabled={busy} onClick={() => patch({ rules, conditions: fromLeaves(condMode, leaves) }, t('builder.saved'))}>{t('builder.saveWhoWhen')}</Button>
              </div>
              ) : null}
            </div>
          </section>

          <section className="rounded-lg border bg-white p-4 dark:bg-slate-900">
            <h2 className="text-sm font-semibold">{t('builder.actionsTitle')}</h2>
            <div className="mt-2 grid gap-3">
              {actions.map((action, i) => (
                <div key={i} className="grid gap-2 rounded-md border p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold tabular-nums">#{i + 1}</span>
                    <Select aria-label={t('builder.actionKindLabel')} value={String(action.kind ?? '')} onChange={(e) => updateAction(i, { kind: e.target.value })} disabled={ro}>
                      {ACTION_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                    </Select>
                    {canManage ? (
                    <>
                    <Button variant="outline" onClick={() => moveAction(i, -1)}>↑</Button>
                    <Button variant="outline" onClick={() => moveAction(i, 1)}>↓</Button>
                    <Button variant="outline" onClick={() => setActions((prev) => prev.filter((_, j) => j !== i))}>{t('builder.remove')}</Button>
                    </>
                    ) : null}
                  </div>
                  <Textarea
                    aria-label={t('builder.actionJsonLabel')}
                    value={JSON.stringify(action, null, 2)}
                    rows={4}
                    disabled={ro}
                    onChange={(e) => {
                      try {
                        updateAction(i, JSON.parse(e.target.value) as Record<string, unknown>)
                      } catch {
                        // Partial JSON while typing is not a save; the last
                        // valid parse stands until the text parses again.
                      }
                    }}
                  />
                </div>
              ))}
              {canManage ? (
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setActions((prev) => [...prev, { kind: 'send_notification', to: 'manager', body: '' }])}>{t('builder.addAction')}</Button>
                <Button disabled={busy} onClick={() => patch({ actions }, t('builder.saved'))}>{t('builder.saveActions')}</Button>
              </div>
              ) : null}
            </div>
          </section>

          {canSimulate ? (
            <section className="rounded-lg border bg-white p-4 dark:bg-slate-900">
              <h2 className="text-sm font-semibold">{t('builder.simulateTitle')}</h2>
              <p className="mt-1 text-xs text-slate-500">{t('builder.simulateHelp')}</p>
              <div className="mt-2 grid gap-2">
                <Label htmlFor="ab-sim-subject">{t('builder.simulateSubjectLabel')}</Label>
                <Input
                  id="ab-sim-subject"
                  value={simSubject}
                  onChange={(e) => setSimSubject(e.target.value)}
                  placeholder={t('builder.simulateSubjectPlaceholder')}
                />
                <div><Button disabled={busy} onClick={simulate}>{t('builder.simulateButton')}</Button></div>
                {simSteps ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>#</TableHead>
                        <TableHead>{t('builder.stepKind')}</TableHead>
                        <TableHead>{t('builder.stepStatus')}</TableHead>
                        <TableHead>{t('builder.stepDetail')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {simSteps.map((s) => (
                        <TableRow key={s.index}>
                          <TableCell className="tabular-nums">{s.index}</TableCell>
                          <TableCell>{s.kind}</TableCell>
                          <TableCell><Badge variant="secondary">{s.status}</Badge></TableCell>
                          <TableCell>{s.error ?? s.output ?? ''}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : null}
              </div>
            </section>
          ) : null}
        </>
      ) : (
        <AutomationRunsPanel runs={runs} statusLabel={t('builder.runStatus')} emptyLabel={t('builder.runsEmpty')} />
      )}
    </div>
  )
}

/**
 * Runs tab: the run log table following the flows RunsPanel pattern (same
 * @openbooks/ui Table + Badge + status columns over loader-resolved rows),
 * with automation statuses and a steps drawer per run.
 */
export function AutomationRunsPanel({
  runs,
  statusLabel,
  emptyLabel,
}: {
  runs: BuilderRun[]
  statusLabel: string
  emptyLabel: string
}) {
  const t = useTranslations('admin.automations')
  const [openRunId, setOpenRunId] = useState<string | null>(null)
  const [steps, setSteps] = useState<{ index: number; kind: string; status: string; output?: string; error?: string }[]>([])
  const [runError, setRunError] = useState<string | null>(null)

  async function openRun(id: string) {
    setOpenRunId(id)
    setSteps([])
    setRunError(null)
    try {
      const res = await fetch(`/api/automations/runs/${id}`)
      if (!res.ok) {
        setRunError(await readApiErrorMessage(res, t('builder.runLoadFailed')))
        return
      }
      const payload = (await res.json().catch(() => ({}))) as {
        run?: { steps?: { index: number; kind: string; status: string; output?: string; error?: string }[]; error?: { message?: string } | null }
      }
      setSteps(payload.run?.steps ?? [])
      if (payload.run?.error && typeof payload.run.error.message === 'string') setRunError(payload.run.error.message)
    } catch {
      setRunError(t('builder.runLoadFailed'))
    }
  }

  if (runs.length === 0) return <p className="text-sm text-slate-500">{emptyLabel}</p>

  return (
    <div className="grid gap-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{statusLabel}</TableHead>
            <TableHead>{t('builder.runVersion')}</TableHead>
            <TableHead>{t('builder.runSubject')}</TableHead>
            <TableHead>{t('builder.runCreated')}</TableHead>
            <TableHead>{t('builder.runSteps')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((r) => (
            <TableRow key={r.id}>
              <TableCell>
                <Badge variant={r.status === 'succeeded' ? 'success' : r.status === 'failed' ? 'destructive' : 'secondary'}>
                  {r.status}
                </Badge>
              </TableCell>
              <TableCell className="tabular-nums">{r.version}</TableCell>
              <TableCell>{r.subjectKind ?? '—'}</TableCell>
              <TableCell className="tabular-nums">{r.createdAt}</TableCell>
              <TableCell>
                <Button variant="outline" onClick={() => openRun(r.id)}>{t('builder.viewSteps')}</Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {openRunId ? (
        <section className="rounded-lg border bg-white p-4 dark:bg-slate-900">
          <h3 className="text-sm font-semibold">{t('builder.stepsTitle')}</h3>
          {runError ? <p className="mt-1 text-sm text-red-600 dark:text-red-400">{runError}</p> : null}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>{t('builder.stepKind')}</TableHead>
                <TableHead>{t('builder.stepStatus')}</TableHead>
                <TableHead>{t('builder.stepDetail')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {steps.map((s) => (
                <TableRow key={s.index}>
                  <TableCell className="tabular-nums">{s.index}</TableCell>
                  <TableCell>{s.kind}</TableCell>
                  <TableCell>
                    <Badge variant={s.status === 'succeeded' || s.status === 'simulated' ? 'success' : s.status === 'failed' ? 'destructive' : 'secondary'}>
                      {s.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{s.error ?? s.output ?? ''}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-2"><Button variant="outline" onClick={() => setOpenRunId(null)}>{t('builder.closeSteps')}</Button></div>
        </section>
      ) : null}
    </div>
  )
}
