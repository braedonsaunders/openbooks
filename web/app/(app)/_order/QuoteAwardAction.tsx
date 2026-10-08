'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, DisclosureSection, Drawer, Input, Label, Select } from '@openbooks/ui'
import { useMoney } from '@/components/money-provider'
import {
  planQuoteAward,
  type AwardLineMapping,
  type AwardPlan,
  type AwardSourceLine,
  type AwardTaskSpec,
} from '@openbooks/engine/src/projects/award-plan.ts'
import { readApiErrorMessage } from '../../../lib/api-error'

/**
 * Award an issued quote: one action on the quote that opens a drawer to
 * create the project (or add the work to one of the customer's projects)
 * with the quoted hours, cost and price as its budget. The everyday path is
 * a name, a type and one button; the line-to-task grouping sits behind
 * "Customize tasks". The plan shown here is the same pure plan the server
 * computes, so the summary is exactly what the award writes. Once awarded,
 * the action becomes a link to the project.
 */

interface AwardPreview {
  quote: { id: string; documentNumber: string; status: string; customerName: string | null; projectId: string | null; projectName: string | null }
  awarded: { projectId: string; projectName: string } | null
  blocked: string | null
  defaults: { mode: 'new' | 'existing'; projectId: string | null; name: string; projectTypeId: string | null; contractValue: string | null }
  projectTypes: { id: string; key: string; name: string; pricesFromContract: boolean }[]
  projects: { id: string; name: string; code: string | null }[]
  existingTasks: { id: string; code: string | null; name: string }[]
  productionQuantitiesAvailable: boolean
  lines: AwardSourceLine[]
  plan: AwardPlan | null
  planError: string | null
}

const EXISTING_PREFIX = 'existing:'

/** Hours without trailing fractional zeros. */
function hoursText(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
}

export function QuoteAwardAction({ quoteId, docStatus }: { quoteId: string; docStatus: string }) {
  const t = useTranslations('estimates.award')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const { money } = useMoney()
  const eligible = docStatus === 'approved' || docStatus === 'posted'
  const [preview, setPreview] = useState<AwardPreview | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Form state.
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [projectId, setProjectId] = useState('')
  const [name, setName] = useState('')
  const [typeId, setTypeId] = useState('')
  const [contractValue, setContractValue] = useState('')
  const [startsOn, setStartsOn] = useState('')
  const [costs, setCosts] = useState<Record<string, string>>({})
  const [production, setProduction] = useState(false)
  const [customized, setCustomized] = useState(false)
  const [tasks, setTasks] = useState<AwardTaskSpec[]>([])
  const [mapping, setMapping] = useState<Record<string, string>>({})

  const load = useCallback(async (targetProjectId?: string) => {
    const query = targetProjectId ? `?projectId=${encodeURIComponent(targetProjectId)}` : ''
    const response = await fetch(`/api/estimates/${quoteId}/award${query}`, { cache: 'no-store' })
    if (!response.ok) throw new Error(await readApiErrorMessage(response, t('loadFailed')))
    return (await response.json()) as AwardPreview
  }, [quoteId, t])

  useEffect(() => {
    if (!eligible) return
    let cancelled = false
    load()
      .then((data) => { if (!cancelled) setPreview(data) })
      // The quote drawer stays usable without the award: a failed probe
      // simply leaves the action out.
      .catch(() => { if (!cancelled) setPreview(null) })
    return () => { cancelled = true }
  }, [eligible, load])

  function resetGrouping(data: AwardPreview) {
    const plan = data.plan
    setCustomized(false)
    setTasks(plan ? plan.tasks.map((task) => ({ key: task.key, code: task.code, name: task.name, existingTaskId: null })) : [])
    setMapping(plan ? Object.fromEntries(plan.lines.map((line) => [line.lineId, line.taskKey])) : {})
  }

  function openDrawer() {
    if (!preview) return
    setError(null)
    setMode(preview.defaults.mode)
    setProjectId(preview.defaults.projectId ?? '')
    setName(preview.defaults.name)
    setTypeId(preview.defaults.projectTypeId ?? '')
    setContractValue(preview.defaults.contractValue ?? '')
    setStartsOn('')
    setCosts({})
    setProduction(false)
    resetGrouping(preview)
    setOpen(true)
  }

  async function chooseProject(id: string) {
    setProjectId(id)
    if (!id) return
    try {
      const data = await load(id)
      setPreview(data)
      resetGrouping(data)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('loadFailed'))
    }
  }

  // Task groups, pruned to those that still carry a line, with existing-task
  // targets expanded into their own groups.
  const grouping = useMemo(() => {
    const used = new Set(Object.values(mapping))
    const specs: AwardTaskSpec[] = tasks.filter((task) => used.has(task.key))
    for (const key of used) {
      if (!key.startsWith(EXISTING_PREFIX) || specs.some((task) => task.key === key)) continue
      const existing = preview?.existingTasks.find((task) => `${EXISTING_PREFIX}${task.id}` === key)
      if (existing) specs.push({ key, code: existing.code, name: existing.name, existingTaskId: existing.id })
    }
    const lines: AwardLineMapping[] = Object.entries(mapping).map(([lineId, taskKey]) => ({ lineId, taskKey }))
    return { specs, lines }
  }, [mapping, tasks, preview])

  const lineCosts = useMemo(
    () => Object.entries(costs).filter(([, cost]) => cost.trim() !== '').map(([lineId, cost]) => ({ lineId, cost: cost.trim() })),
    [costs],
  )

  const planResult = useMemo((): { plan: AwardPlan | null; error: string | null } => {
    if (!preview || preview.lines.length === 0) return { plan: preview?.plan ?? null, error: preview?.planError ?? null }
    try {
      return {
        plan: planQuoteAward({
          lines: preview.lines,
          ...(customized ? { tasks: grouping.specs, mapping: grouping.lines } : {}),
          lineCosts,
          productionQuantities: production,
          usedCodes: new Set(mode === 'existing'
            ? preview.existingTasks.map((task) => task.code).filter((code): code is string => !!code)
            : []),
        }),
        error: null,
      }
    } catch (planError) {
      return { plan: null, error: planError instanceof Error ? planError.message : t('failed') }
    }
  }, [preview, customized, grouping, lineCosts, production, mode, t])

  function chooseType(id: string) {
    setTypeId(id)
    const type = preview?.projectTypes.find((option) => option.id === id)
    setContractValue(type?.pricesFromContract && planResult.plan ? planResult.plan.totals.price : '')
  }

  async function submit() {
    if (!preview) return
    setBusy(true)
    setError(null)
    try {
      const target = mode === 'existing'
        ? { mode: 'existing' as const, projectId }
        : {
            mode: 'new' as const,
            name: name.trim() || null,
            projectTypeId: typeId || null,
            startsOn: startsOn || null,
            contractValue: contractValue.trim() === '' ? null : contractValue.trim(),
          }
      const response = await fetch(`/api/estimates/${quoteId}/award`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target,
          ...(customized ? { tasks: grouping.specs, mapping: grouping.lines } : {}),
          ...(lineCosts.length > 0 ? { lineCosts } : {}),
          ...(production ? { productionQuantities: true } : {}),
        }),
      })
      if (!response.ok) throw new Error(await readApiErrorMessage(response, t('failed')))
      const result = (await response.json()) as { projectId: string }
      toast.success(t('awarded'))
      setOpen(false)
      router.push(`/projects?project=${encodeURIComponent(result.projectId)}`)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t('failed'))
    } finally {
      setBusy(false)
    }
  }

  if (!eligible || !preview) return null
  if (preview.awarded) {
    return (
      <Link
        href={`/projects?project=${encodeURIComponent(preview.awarded.projectId)}`}
        className="inline-flex h-9 items-center rounded-md px-2 text-sm font-medium text-teal-700 hover:underline dark:text-teal-300"
      >
        {t('awardedTo', { project: preview.awarded.projectName })}
      </Link>
    )
  }
  if (docStatus !== 'approved') return null

  const plan = planResult.plan
  const missing = plan?.missingCost ?? []
  const lineById = new Map(preview.lines.map((line) => [line.lineId, line]))
  const taskedToQuoteProject = !!preview.quote.projectId
  const canSubmit = !busy && !preview.blocked && !!plan && missing.every((line) => (costs[line.lineId] ?? '').trim() !== '')
    && (mode === 'new' ? name.trim() !== '' : projectId !== '')
  const taskOptions = [
    ...grouping.specs.filter((task) => !task.existingTaskId).map((task) => ({ value: task.key, label: `${task.code ? `${task.code} · ` : ''}${task.name}` })),
    ...(mode === 'existing' ? preview.existingTasks.map((task) => ({
      value: `${EXISTING_PREFIX}${task.id}`,
      label: t('existingTaskOption', { task: `${task.code ? `${task.code} · ` : ''}${task.name}` }),
    })) : []),
  ]

  return (
    <>
      <Button variant="outline" disabled={busy} onClick={openDrawer} title={preview.blocked ?? undefined}>
        {t('action')}
      </Button>
      <Drawer
        open={open}
        onClose={() => { if (!busy) setOpen(false) }}
        stacked
        size="lg"
        title={t('title', { number: preview.quote.documentNumber })}
        description={t('description')}
        headerActions={
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setOpen(false)}>
              {tCommon('actions.cancel')}
            </Button>
            <Button size="sm" disabled={!canSubmit} onClick={() => void submit()}>
              {busy ? t('awarding') : mode === 'existing' ? t('submitExisting') : t('submit')}
            </Button>
          </div>
        }
      >
        <div className="space-y-5">
          {preview.blocked || error ? (
            <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
              {preview.blocked ?? error}
            </p>
          ) : null}

          <div className="space-y-3">
            {taskedToQuoteProject ? (
              <p className="text-sm text-slate-600 dark:text-slate-300">{t('taggedToProject', { project: preview.quote.projectName ?? '' })}</p>
            ) : (
              <div className="flex gap-4 text-sm" role="radiogroup" aria-label={t('target')}>
                <label className="flex items-center gap-2">
                  <input type="radio" name="award-target" checked={mode === 'new'} onChange={() => setMode('new')} />
                  {t('newProject')}
                </label>
                {preview.projects.length > 0 ? (
                  <label className="flex items-center gap-2">
                    <input type="radio" name="award-target" checked={mode === 'existing'} onChange={() => setMode('existing')} />
                    {t('existingProject')}
                  </label>
                ) : null}
              </div>
            )}

            {mode === 'new' ? (
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2 space-y-1.5">
                  <Label>{t('projectName')} <span className="text-red-500">*</span></Label>
                  <Input value={name} maxLength={300} onChange={(event) => setName(event.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>{t('projectType')}</Label>
                  <Select value={typeId} onChange={(event) => chooseType(event.target.value)}>
                    <option value="">{t('noType')}</option>
                    {preview.projectTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>{t('startsOn')}</Label>
                  <Input type="date" value={startsOn} onChange={(event) => setStartsOn(event.target.value)} />
                </div>
                <div className="col-span-2 space-y-1.5">
                  <Label>{t('contractValue')}</Label>
                  <Input inputMode="decimal" value={contractValue} onChange={(event) => setContractValue(event.target.value)} />
                  <p className="text-xs text-slate-500 dark:text-slate-400">{t('contractValueHint')}</p>
                </div>
              </div>
            ) : taskedToQuoteProject ? null : (
              <div className="space-y-1.5">
                <Label>{t('existingProject')} <span className="text-red-500">*</span></Label>
                <Select value={projectId} onChange={(event) => void chooseProject(event.target.value)}>
                  <option value="">{t('chooseProject')}</option>
                  {preview.projects.map((project) => (
                    <option key={project.id} value={project.id}>{project.code ? `${project.code} · ${project.name}` : project.name}</option>
                  ))}
                </Select>
              </div>
            )}
          </div>

          {plan ? (
            <p className="rounded-md bg-slate-50 px-3 py-2 text-sm font-medium tabular-nums text-slate-800 dark:bg-slate-800/60 dark:text-slate-100">
              {t('summary', {
                tasks: plan.tasks.length,
                hours: hoursText(plan.totals.hours),
                cost: money(plan.totals.cost),
                price: money(plan.totals.price),
              })}
            </p>
          ) : planResult.error ? (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">{planResult.error}</p>
          ) : null}

          {missing.length > 0 ? (
            <div className="space-y-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('missingCostTitle')}</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">{t('missingCostHint')}</p>
              </div>
              {missing.map((line) => (
                <div key={line.lineId} className="grid grid-cols-[1fr_10rem] items-center gap-3">
                  <span className="min-w-0 truncate text-sm text-slate-700 dark:text-slate-200">
                    {t('lineLabel', { number: line.lineNumber })} · {line.description ?? lineById.get(line.lineId)?.itemName ?? ''}
                    <span className="ml-2 text-xs text-slate-400 dark:text-slate-500">{t('priceValue', { amount: money(line.price) })}</span>
                  </span>
                  <Input
                    inputMode="decimal"
                    aria-label={t('costInput')}
                    placeholder={t('costInput')}
                    value={costs[line.lineId] ?? ''}
                    onChange={(event) => setCosts((current) => ({ ...current, [line.lineId]: event.target.value }))}
                  />
                </div>
              ))}
            </div>
          ) : null}

          {preview.productionQuantitiesAvailable ? (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5" checked={production} onChange={(event) => setProduction(event.target.checked)} />
              <span>
                {t('productionQuantities')}
                <span className="block text-xs text-slate-500 dark:text-slate-400">{t('productionQuantitiesHint')}</span>
              </span>
            </label>
          ) : null}

          <DisclosureSection title={t('customize')}>
            <div className="space-y-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-slate-400 dark:text-slate-500">
                    <th className="py-1.5 pr-2 font-semibold">{t('columns.line')}</th>
                    <th className="py-1.5 pr-2 font-semibold">{t('columns.description')}</th>
                    <th className="py-1.5 pr-2 text-right font-semibold">{t('columns.price')}</th>
                    <th className="py-1.5 font-semibold">{t('columns.task')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                  {preview.lines.map((line) => (
                    <tr key={line.lineId}>
                      <td className="py-1.5 pr-2 tabular-nums text-slate-500">{line.lineNumber}</td>
                      <td className="max-w-[16rem] truncate py-1.5 pr-2">{line.description ?? line.itemName ?? ''}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{money(plan?.lines.find((planned) => planned.lineId === line.lineId)?.price ?? line.amount)}</td>
                      <td className="py-1.5">
                        <Select
                          aria-label={t('columns.task')}
                          value={mapping[line.lineId] ?? ''}
                          onChange={(event) => {
                            const value = event.target.value
                            setCustomized(true)
                            if (value === '__own') {
                              const key = `own:${line.lineId}`
                              setTasks((current) => current.some((task) => task.key === key)
                                ? current
                                : [...current, { key, code: null, name: line.description?.split(/\r?\n/)[0]?.trim() || line.itemName || t('lineLabel', { number: line.lineNumber }) }])
                              setMapping((current) => ({ ...current, [line.lineId]: key }))
                            } else {
                              setMapping((current) => ({ ...current, [line.lineId]: value }))
                            }
                          }}
                        >
                          {taskOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                          <option value="__own">{t('ownTask')}</option>
                        </Select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {grouping.specs.some((task) => !task.existingTaskId) ? (
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-200">{t('tasksHeading')}</h3>
                  {grouping.specs.filter((task) => !task.existingTaskId).map((task) => (
                    <div key={task.key} className="grid grid-cols-[6rem_1fr] gap-2">
                      <Input
                        aria-label={t('taskCode')}
                        placeholder={t('taskCode')}
                        className="font-mono"
                        value={task.code ?? ''}
                        onChange={(event) => {
                          setCustomized(true)
                          setTasks((current) => current.map((entry) => entry.key === task.key ? { ...entry, code: event.target.value } : entry))
                        }}
                      />
                      <Input
                        aria-label={t('taskName')}
                        placeholder={t('taskName')}
                        value={task.name}
                        onChange={(event) => {
                          setCustomized(true)
                          setTasks((current) => current.map((entry) => entry.key === task.key ? { ...entry, name: event.target.value } : entry))
                        }}
                      />
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </DisclosureSection>
        </div>
      </Drawer>
    </>
  )
}
