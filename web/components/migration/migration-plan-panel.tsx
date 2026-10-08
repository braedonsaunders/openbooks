'use client'

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { AlertTriangle, ArrowUpRight, Check, Circle, Clock, Loader2, PartyPopper, RefreshCw, ShieldCheck } from 'lucide-react'
import { Button, cn } from '@openbooks/ui'
import { apiJson } from '@/lib/api-error'
import { formatCivilDate } from '@/lib/format'
import { useViewerFormat } from '@/lib/viewer-format'
import { goLiveBlockers, isConnectorPath, type CutoverCheck, type JourneyStage } from '@/lib/migration/plan-model'
import type { MigrationJourney } from '@/lib/migration/journey'
import { APPLICATION_COMMAND_APPLIED_EVENT } from '@/components/assistant/application-command-card'

export interface MigrationPlanPanelHandle {
  refresh: () => void
}

const POLL_MS = 8_000

/**
 * The measured migration plan beside the conversation. Every state comes
 * from /api/migration/journey — the same derivation the assistant reads —
 * so the panel and the agent always describe one migration. It refreshes
 * after each turn, after any applied command card, and while a connector
 * run is in progress.
 */
export function MigrationPlanPanel({ initial, handle }: { initial: MigrationJourney; handle?: Ref<MigrationPlanPanelHandle> }) {
  const t = useTranslations('sync.migrationAssistant')
  const { locale, dateTime } = useViewerFormat()
  const [journey, setJourney] = useState(initial)
  const [checks, setChecks] = useState<CutoverCheck[] | null>(initial.checks)
  const [measuring, setMeasuring] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const checksRequested = useRef(initial.checks !== null)

  const load = useCallback(async (withChecks = checksRequested.current) => {
    try {
      const body = await apiJson<{ journey?: MigrationJourney }>(`/api/migration/journey${withChecks ? '?checks=1' : ''}`, { cache: 'no-store' }, t('plan.loadFailed'))
      // A malformed answer keeps the last measured plan on screen rather than blanking it.
      if (!body.journey?.facts || !Array.isArray(body.journey.stages)) throw new Error(t('plan.loadFailed'))
      setJourney(body.journey)
      if (body.journey.checks) setChecks(body.journey.checks)
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('plan.loadFailed'))
    }
  }, [t])

  useImperativeHandle(handle, () => ({ refresh: () => { void load() } }), [load])

  // A narrow-screen drawer may reopen after changes made in the conversation.
  // Read current evidence whenever its panel mounts.
  // State changes in load follow the awaited response from the server.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  useEffect(() => {
    const onApplied = () => { void load() }
    window.addEventListener(APPLICATION_COMMAND_APPLIED_EVENT, onApplied)
    return () => window.removeEventListener(APPLICATION_COMMAND_APPLIED_EVENT, onApplied)
  }, [load])

  const running = [journey.facts.runs.preflight, journey.facts.runs.migration, journey.facts.runs.mirror].some((run) => run?.status === 'running')
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => { void load() }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [running, load])

  async function measure() {
    checksRequested.current = true
    setMeasuring(true)
    await load(true)
    setMeasuring(false)
  }

  const { plan } = journey
  const pathLabel = t(`plan.path.${plan.path ?? 'none'}`)
  const source = journey.facts.sourceName ?? (plan.sourceSystem === 'spreadsheet' ? t('plan.spreadsheetSource') : null)
  const showChecks = plan.path !== null && plan.path !== 'mirror'
  const blockers = checks ? goLiveBlockers(checks) : []

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-5 py-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-2">
          <p className="text-[11px] font-semibold tracking-wide text-teal-700 uppercase dark:text-teal-300">{t('plan.title')}</p>
          <button type="button" onClick={() => void load()} className="ml-auto rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800" aria-label={t('plan.refresh')} title={t('plan.refresh')}>
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">{pathLabel}</p>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
          <div>
            <dt className="text-slate-500 dark:text-slate-400">{t('plan.source')}</dt>
            <dd className="mt-0.5 truncate font-medium text-slate-800 dark:text-slate-200">{source ?? t('plan.notSet')}</dd>
          </div>
          <div>
            <dt className="text-slate-500 dark:text-slate-400">{t('plan.cutover')}</dt>
            <dd className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">{plan.cutoverDate ? formatCivilDate(plan.cutoverDate, locale) : t('plan.notSet')}</dd>
          </div>
        </dl>
        {plan.goLive ? (
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-gradient-to-r from-teal-600 to-emerald-500 px-3 py-2 text-sm font-medium text-white shadow-sm">
            <PartyPopper className="h-4 w-4" />
            {t('plan.live', { date: formatCivilDate(plan.goLive.cutoverDate, locale) })}
          </div>
        ) : null}
      </div>

      <div className="app-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {error ? <p role="alert" className="mb-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p> : null}
        <ol className="relative space-y-1">
          {journey.stages.map((stage, index) => (
            <StageRow key={stage.key} stage={stage} last={index === journey.stages.length - 1} journey={journey} />
          ))}
        </ol>

        {showChecks ? (
          <section className="mt-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-teal-600 dark:text-teal-400" />
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('checks.title')}</h3>
              <Button type="button" size="sm" variant="outline" className="ml-auto h-7 px-2 text-xs" onClick={() => void measure()} disabled={measuring}>
                {measuring ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {measuring ? t('checks.running') : checks ? t('checks.rerun') : t('checks.run')}
              </Button>
            </div>
            {checks ? (
              <>
                <ul className="mt-3 space-y-2">
                  {checks.filter((check) => check.state !== 'not_applicable').map((check) => <CheckRow key={check.key} check={check} />)}
                </ul>
                <p className={cn('mt-3 text-xs', blockers.length ? 'text-amber-700 dark:text-amber-300' : 'text-teal-700 dark:text-teal-300')}>
                  {plan.goLive ? t('checks.live') : blockers.length ? t('checks.blocked', { count: blockers.length }) : t('checks.ready')}
                </p>
              </>
            ) : (
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{t('checks.hint')}</p>
            )}
          </section>
        ) : null}
        <p className="mt-4 text-[11px] text-slate-400 dark:text-slate-500">{t('plan.measuredAt', { time: dateTime(journey.measuredAt, { timeStyle: 'short' }) })}</p>
      </div>
    </div>
  )
}

function StageRow({ stage, last, journey }: { stage: JourneyStage; last: boolean; journey: MigrationJourney }) {
  const t = useTranslations('sync.migrationAssistant')
  const connector = isConnectorPath(journey.plan.path)
  const titleKey = stage.key === 'source' || stage.key === 'load' ? `${stage.key}${connector ? 'Connector' : 'Files'}` : stage.key
  const detail = stageDetail(stage, journey, t)
  const running = (stage.key === 'rehearse' && journey.facts.runs.preflight?.status === 'running')
    || (stage.key === 'load' && journey.facts.runs.migration?.status === 'running')
    || (stage.key === 'mirror' && journey.facts.runs.mirror?.status === 'running')
  return (
    <li className="relative flex gap-3 pb-3">
      {!last ? <span aria-hidden="true" className={cn('absolute top-7 left-[13px] h-[calc(100%-1.25rem)] w-px', stage.state === 'complete' ? 'bg-teal-300 dark:bg-teal-800' : 'bg-slate-200 dark:bg-slate-800')} /> : null}
      <span className={cn(
        'relative z-10 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs',
        stage.state === 'complete' && 'border-teal-600 bg-teal-600 text-white',
        stage.state === 'current' && 'border-teal-500 bg-white text-teal-700 ring-4 ring-teal-500/15 dark:bg-slate-950 dark:text-teal-300',
        stage.state === 'upcoming' && 'border-slate-300 bg-white text-slate-400 dark:border-slate-700 dark:bg-slate-950',
      )}>
        {stage.state === 'complete' ? <Check className="h-4 w-4" /> : running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : stage.state === 'current' ? <span className="h-2 w-2 rounded-full bg-teal-500" /> : <Circle className="h-2 w-2 fill-current" />}
      </span>
      <div className={cn('min-w-0 flex-1 rounded-lg px-2 py-1', stage.state === 'current' && 'bg-white shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800')}>
        <div className="flex items-center gap-2">
          <p className={cn('text-sm font-medium', stage.state === 'upcoming' ? 'text-slate-500 dark:text-slate-400' : 'text-slate-900 dark:text-slate-100')}>{t(`stages.${titleKey}`)}</p>
          {stage.state === 'current' ? <span className="rounded-full bg-teal-100 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-teal-800 uppercase dark:bg-teal-900/60 dark:text-teal-200">{t('stageState.current')}</span> : null}
        </div>
        {detail ? <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{detail}</p> : null}
        {stage.state !== 'upcoming' && stage.href !== '/migrate' ? (
          <Link href={stage.href} className="mt-1 inline-flex items-center gap-0.5 text-xs font-medium text-teal-700 hover:underline dark:text-teal-300">
            {t('stageOpen')}<ArrowUpRight className="h-3 w-3" />
          </Link>
        ) : null}
      </div>
    </li>
  )
}

type Translate = ReturnType<typeof useTranslations<'sync.migrationAssistant'>>

function runLabel(t: Translate, status: string | null | undefined): string {
  return t(`runStatus.${status ?? 'none'}`)
}

function stageDetail(stage: JourneyStage, journey: MigrationJourney, t: Translate): string | null {
  const facts = stage.facts
  const { connection, runs, counts, imports, openingJournal } = journey.facts
  switch (stage.key) {
    case 'plan': return journey.plan.path ? null : t('details.planEmpty')
    case 'foundation': return journey.facts.foundationReady ? t('details.foundationReady', { accounts: counts.accounts }) : t('details.foundationWaiting')
    case 'source':
      if (isConnectorPath(journey.plan.path)) return connection ? t('details.connection', { name: connection.displayName, status: t(`connectionStatus.${connection.status}`) }) : t('details.noConnection')
      return imports.length ? t('details.imports', { count: imports.length }) : t('details.noImports')
    case 'rehearse': return runLabel(t, runs.preflight?.status)
    case 'load':
      if (isConnectorPath(journey.plan.path)) return runs.migration ? `${runLabel(t, runs.migration.status)} · ${t('details.postedEntries', { count: counts.postedEntries })}` : runLabel(t, null)
      return openingJournal ? t('details.openingJournal', { number: openingJournal.documentNumber ?? '', status: t(`journalStatus.${openingJournal.status === 'posted' ? 'posted' : 'draft'}`) }) : t('details.noOpeningJournal')
    case 'verify':
      if (isConnectorPath(journey.plan.path)) {
        return typeof facts.tbAccounts === 'number' && typeof facts.tbMatches === 'number'
          ? t('details.verification', { matches: facts.tbMatches, accounts: facts.tbAccounts, openMatches: Number(facts.openItemsMatches ?? 0), openChecked: Number(facts.openItemsChecked ?? 0) })
          : runLabel(t, typeof facts.status === 'string' ? facts.status : null)
      }
      return t('details.verifyFiles')
    case 'mirror': return connection?.mirrorEnabled
      ? t('details.mirrorOn', { schedule: t.has(`schedules.${connection.mirrorSchedule}`) ? t(`schedules.${connection.mirrorSchedule}`) : connection.mirrorSchedule })
      : t('details.mirrorOff')
    case 'cutover': return journey.plan.cutoverDate ? null : t('details.noCutover')
    case 'live': return null
  }
}

function CheckRow({ check }: { check: CutoverCheck }) {
  const t = useTranslations('sync.migrationAssistant')
  const icon = check.state === 'pass'
    ? <Check className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
    : check.state === 'fail'
      ? <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
      : <Clock className="h-3.5 w-3.5 text-slate-400" />
  return (
    <li className="flex items-start gap-2 text-xs">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <Link href={check.href} className="font-medium text-slate-800 hover:underline dark:text-slate-200">{t(`checks.items.${check.key}`)}</Link>
        <span className="ml-1.5 text-slate-400">{check.required ? t('checks.required') : t('checks.advisory')}</span>
        <p className="text-slate-500 dark:text-slate-400">{t(`checks.state.${check.state}`)}</p>
      </div>
    </li>
  )
}
