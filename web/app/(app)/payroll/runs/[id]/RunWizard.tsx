'use client'

import { type WizardStep, STALE_REASON_FALLBACK, type Readiness, type Staleness, type Funding, type StubChange, type RunHeader, type StubRow, type RosterRow, type RemittanceRow, type GlLeg, type AdjustmentRow, type ComponentOption, runTypeLabel } from './run-wizard-model'
import { PeriodStep } from './steps/PeriodStep'
import { ReadinessStep } from './steps/ReadinessStep'
import { ReviewStep } from './steps/ReviewStep'
import { GlStep } from './steps/GlStep'
import { FinishStep } from './steps/FinishStep'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { AlertTriangle, Calculator, Check, ChevronRight, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { Badge, Button, cn } from '@openbooks/ui'
import type { YearEndFilingSection } from '@openbooks/engine/src/payroll/yearend.ts'
import type { PayRunCalculationError, PayRunRefusalAcknowledgement } from '@openbooks/engine/src/payroll/run-calculation-evidence.ts'
import type { PayRunApprovalState } from '@openbooks/engine/src/payroll/approval.ts'
import { refreshApprovalState } from '../../../../../components/approval-actions'
import { readApiErrorMessage } from '../../../../../lib/api-error'
import { useMoney } from '../../../../../components/money-provider'
import { RunStatusBadge, runDisplayStatus } from '../../_ui/run-status'
import { confirmDialog } from '../../../../../lib/confirm'
import { type RegisterBucket } from '../../../../../lib/payroll-register-buckets'

/**
 * The pay-run wizard: four steps rendered as freely-navigable chips (no forced
 * linear march) — Period & employees → Review stubs → GL preview & commit →
 * Post & finish. Completion derives from run_status + the document's posted
 * state; the GL step shows the exact journal BEFORE anything posts.
 */
export function RunWizard(props: {
  run: RunHeader
  stubs: StubRow[]
  roster: RosterRow[]
  adjustments: AdjustmentRow[]
  adjustableComponents: ComponentOption[]
  /** employee_party_id → net pay on the employee's previous committed stub. */
  previousNet: Record<string, string>
  /** Credit legs by account from the committed document lines (negative). */
  remittance: RemittanceRow[]
  bankAccounts: { id: string; label: string }[]
  /** The seeded 'payroll-register' report definition (full report engine). */
  registerReportId: string | null
  /** Pack-declared withholding buckets for the review grid and stub header. */
  registerBuckets: RegisterBucket[]
  /** Pack-language region column header ("Province" / "State" / "Region"). */
  regionLabel: string
  /** Statutory engine names by stub country for the trace heading. */
  traceEngines: Record<string, string>
  /** Pack-declared trace-factor labels by stub country for the trace rows. */
  factorLabels: Record<string, Record<string, string>>
  /** Engine-computed pre-flight: what blocks the run, what to look at. */
  readiness: Readiness
  /** Whether the stubs still reflect the inputs they were built from. */
  staleness: Staleness
  /** Cash required for the payday, against each bank account's balance. */
  funding: Funding
  /** Per-employee change since the previous committed stub. */
  changes: StubChange[]
  /**
   * Pack-declared separation filings (the ROE) for this run's employees —
   * populated by the server for termination runs, empty otherwise. The
   * Finish step renders one issue card per employee.
   */
  separationSections: YearEndFilingSection[]
  canRun: boolean
  initialStep: WizardStep
  /**
   * The latest calculate's per-employee outcomes, persisted server-side at
   * calculate time. The exception list renders from THIS, not only from the
   * calculate response's memory — so the first calculate's refusals survive a
   * refresh that used to wipe them.
   */
  calculationErrors: PayRunCalculationError[]
  /** Recorded decision to commit despite refusals, if one was taken. */
  refusalAcknowledgement: PayRunRefusalAcknowledgement | null
  /** Whether the recorded acknowledgement binds to the current refusal set. */
  refusalsAcknowledged: boolean
  /**
   * Flows approval state, resolved server-side by the loader through the
   * native engine — the same state the commit boundary refuses on. The
   * expenses precedent: a boolean handed to the client, composed with
   * status; never a second switch, flag, or permission-only check.
   */
  approval: PayRunApprovalState
  /** HR-21: open block-severity anomaly flags overlapping this run's
   *  period. The commit button stays off while nonzero; the commit route
   *  refuses regardless. Zero while hrmPayrollAnomalies is off. */
  anomalyBlocks: number
  /**
   * Active, non-elimination entities visible to the caller — the target
   * list for the Attribute entity action on a subsidiary-less run.
   */
  entityOptions: { id: string; label: string }[]
  /** Attribution is org-wide: false for scoped callers the route would 404. */
  canAttributeEntity: boolean
}) {
  const t = useTranslations('payroll')
  const router = useRouter()
  const { money } = useMoney()
  const run = props.run
  const currency = run.currency
  const fmt = useCallback(
    (value: string | number | null | undefined) => money(value ?? '0', { currency }),
    [money, currency],
  )

  const [step, setStep] = useState<WizardStep>(props.initialStep)
  const [busy, setBusy] = useState(false)
  // Re-entry guard for adjustment edits: setBusy is state (async), so a
  // double-click lands twice before the buttons disable. The ref closes that
  // gap; try/finally in adjust() always releases it, so a failed request
  // never wedges the wizard.
  const adjustInflight = useRef(false)
  // The loader is the authority on the persisted refusal record: these start
  // from the run row (so the FIRST calculate's exceptions survive a refresh)
  // and are re-synced whenever a refresh delivers a newer row.
  const [calcErrors, setCalcErrors] = useState<PayRunCalculationError[]>(props.calculationErrors)
  const [acknowledgement, setAcknowledgement] = useState<PayRunRefusalAcknowledgement | null>(
    props.refusalAcknowledgement,
  )
  const [refusalsAcked, setRefusalsAcked] = useState(props.refusalsAcknowledged)
  /**
   * Every mutation below (calculate, acknowledge, scope and adjustment edits)
   * returns the run's authoritative refusal state in its own response, so
   * local state is set from responses — never synced from props in an effect.
   */
  function applyRefusalState(j: {
    errors?: unknown
    refusalAcknowledgement?: PayRunRefusalAcknowledgement | null
    refusalsAcknowledged?: boolean
  }) {
    if (Array.isArray(j.errors)) setCalcErrors(j.errors as PayRunCalculationError[])
    if (j.refusalAcknowledgement !== undefined) setAcknowledgement(j.refusalAcknowledgement)
    if (j.refusalsAcknowledged !== undefined) setRefusalsAcked(j.refusalsAcknowledged)
  }
  /** In-scope refusals: entries that are not warnings on real stubs and not out-of-scope. */
  const refusals = calcErrors.filter(
    (entry) => entry.kind !== 'warning' && entry.kind !== 'out-of-scope',
  )
  const [dry, setDry] = useState<{
    employees: number
    gross: string
    net: string
    employerCost: string
    errors: { employee: string; message: string }[]
  } | null>(null)
  const [gl, setGl] = useState<{
    state: 'idle' | 'loading' | 'ready' | 'setup-error'
    legs: GlLeg[]
    debitTotal: string
    error: string
  }>({ state: 'idle', legs: [], debitTotal: '0', error: '' })

  const posted = run.document_status === 'posted'
  const voided = run.document_status === 'void' || run.document_status === 'voided'
  const docDraft = run.document_status === 'draft'
  const calculated = run.run_status !== 'draft'
  const committed = run.run_status === 'committed'

  const blocked = props.readiness.blockers > 0
  const canCalculate = props.canRun && docDraft && run.run_status !== 'committed' && !blocked
  // After the flow releases the run its document reads 'approved', not
  // 'draft' — but the boundary says released, so money may move and the
  // commit affordance must say so too, or the submit button above would
  // strand the operator one step later (approved yet uncommittable). This
  // is a UI enablement only: the API boundary is unchanged and still
  // refuses anything unreleased.
  const commitDocOpen = docDraft || (run.document_status === 'approved' && props.approval.released)
  // Submit for approval — the remedy the commit refusal names. Offered only
  // while an approval policy covers pay runs and this run has never been
  // submitted: "no flow configured" is a configuration question the Flows
  // engine answers (props.approval.policyExists), never a permission or a
  // flag, exactly as the expenses drawer composes isDraft && canSubmit.
  // Calculated, non-stale figures only: submission parks the document (no
  // recalculation while pending, and no recall path exists for pay runs),
  // so submitting an uncalculated or stale run would strand it with empty
  // or superseded evidence and no way back but a rejection. The boundary
  // agrees — submit-approval re-checks calculation freshness with
  // assertPayRunNotStale immediately before evidence assembly (and
  // assemblePayRunEvidence refuses an uncalculated run) — so this mirrors
  // the engine's accept set rather than inviting a 422.
  const canSubmitApproval =
    props.canRun && docDraft && calculated && !props.staleness.stale && !committed
    && props.approval.policyExists && !props.approval.submitted
  // Stale stubs must never be committed: recalculate first, always. And a run
  // with unacknowledged in-scope refusals must never commit silently: the
  // commit button stays off until the operator acknowledges exactly this
  // refusal set (the engine enforces the same gate, so a scripted call can
  // never slip past a stale tab either).
  const canCommit =
    props.canRun && commitDocOpen && run.run_status === 'calculated' && !props.staleness.stale
    && (refusals.length === 0 || refusalsAcked) && props.anomalyBlocks === 0
  const canPost =
    props.canRun && committed && (run.document_status === 'draft' || run.document_status === 'approved')
  // Discarding is the escape hatch for a run frozen to the wrong entity: it
  // is offered while the run has no accounting consequence. The engine holds
  // the exact boundary (committed, posted, paid, linked all refuse there), so
  // this flag is only the common case — a draft that has never committed.
  const discardable = props.canRun && docDraft && !committed

  /** Step completion, derived — never client-side bookkeeping. */
  const complete: Record<WizardStep, boolean> = {
    period: calculated,
    readiness: !blocked,
    review: calculated,
    gl: committed || posted,
    finish: posted,
  }

  // Fetch chain: every state update sits in a promise continuation (the fetch
  // response), never synchronously in the effect body. The idle→loading
  // transition lives with the triggers (below, and the step retry) instead of
  // a mount effect.
  const loadGlPreview = useCallback(() => {
    return fetch(`/api/payroll/runs/${run.document_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'preview-gl' }),
    })
      .then(async (res) => {
        // The status is checked before the body is parsed: a non-JSON error
        // body must surface the failure, never a SyntaxError from res.json().
        if (!res.ok) {
          setGl({ state: 'setup-error', legs: [], debitTotal: '0', error: await readApiErrorMessage(res, 'failed') })
          return
        }
        const j = await res.json()
        setGl({ state: 'ready', legs: j.legs ?? [], debitTotal: j.debitTotal ?? '0', error: '' })
      })
      .catch((e: unknown) => {
        setGl({ state: 'setup-error', legs: [], debitTotal: '0', error: (e as Error).message })
      })
  }, [run.document_id])

  // The GL step self-loads whenever it becomes visible with calculated stubs,
  // entering the loading state during render (same committed values, no extra
  // render) so the fetch below triggers off it.
  if (step === 'gl' && calculated && gl.state === 'idle') {
    setGl({ ...gl, state: 'loading' })
  }
  useEffect(() => {
    if (step === 'gl' && calculated && gl.state === 'loading') void loadGlPreview()
  }, [step, calculated, gl.state, loadGlPreview])

  async function act(action: 'calculate' | 'commit') {
    setBusy(true)
    try {
      const res = await fetch(`/api/payroll/runs/${run.document_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      // The status is checked before the body is parsed: a non-JSON error body
      // must surface the failure, never a SyntaxError from res.json().
      if (!res.ok) throw new Error(await readApiErrorMessage(res, 'failed'))
      const j = await res.json()
      if (action === 'calculate') {
        const freshErrors: PayRunCalculationError[] = Array.isArray(j.errors) ? j.errors : []
        applyRefusalState(j)
        setGl({ state: 'idle', legs: [], debitTotal: '0', error: '' })
        setStep('review')
        // Zero stubs with refusals is not a success ("Calculated £0.00 / 0
        // employees" read as one): say plainly that nobody could be paid.
        const freshRefusals = freshErrors.filter(
          (entry) => entry.kind !== 'warning' && entry.kind !== 'out-of-scope',
        )
        if ((j.employees ?? 0) === 0 && freshRefusals.length > 0) {
          toast.warning(t('run.calculateRefusedAll', { count: freshRefusals.length }))
        } else {
          toast.success(t(`run.${action}Done`))
        }
      } else {
        setStep('finish')
        toast.success(t(`run.${action}Done`))
      }
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Submit the run into its Flows approval with the evidence package
   * attached (payroll journal + register + GL preview, assembled
   * server-side). The native engine owns the routing; this is the remedy
   * the commit refusal names, posted to the same boundary the refusal
   * comes from. An ungated tenant reports gated:false with the document
   * untouched — commit stays available, there is nothing to wait for. (The
   * button only renders when a policy exists, so that branch is the race
   * where the policy was disabled mid-click.)
   */
  async function submitApproval() {
    setBusy(true)
    try {
      const res = await fetch(`/api/payroll/runs/${run.document_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'submit-approval' }),
      })
      // The status is checked before the body is parsed (see act above).
      if (!res.ok) throw new Error(await readApiErrorMessage(res, 'failed'))
      const j = await res.json()
      if (j.gated === false) toast.success(t('run.approvalNotRequired'))
      else toast.success(t('run.approvalSubmitted'))
      refreshApprovalState()
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Record the deliberate decision to commit while in-scope employees are
   * refused. The server acknowledges its CURRENT stored refusal set — the
   * client never names the set — so what is recorded is exactly what the
   * exception list showed.
   */
  async function acknowledgeRefusals() {
    setBusy(true)
    try {
      const res = await fetch(`/api/payroll/runs/${run.document_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'acknowledge-refusals' }),
      })
      // The status is checked before the body is parsed (see act above).
      if (!res.ok) throw new Error(await readApiErrorMessage(res, 'failed'))
      const j = await res.json()
      if (j.acknowledgement) {
        setAcknowledgement(j.acknowledgement)
        setRefusalsAcked(true)
      }
      toast.success(t('wizard.gl.ackRecorded', { count: refusals.length }))
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Test calculation: the engine does the whole run and rolls it back, so the
   * operator can see the totals and every exception without touching the run.
   */
  async function dryRun() {
    setBusy(true)
    try {
      const res = await fetch(`/api/payroll/runs/${run.document_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dry-run' }),
      })
      // The status is checked before the body is parsed (see act above).
      if (!res.ok) throw new Error(await readApiErrorMessage(res, 'failed'))
      const j = await res.json()
      setDry({
        employees: j.employees ?? 0,
        gross: j.gross ?? '0',
        net: j.net ?? '0',
        employerCost: j.employerCost ?? '0',
        errors: Array.isArray(j.errors) ? j.errors : [],
      })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /** Apply an input adjustment, then recalculate so the stubs stay truthful. */
  /** Persist the run's employee scope, then recalculate if stubs exist. */
  async function setScope(includedPartyIds: string[], rosterPartyIds: string[]) {
    setBusy(true)
    try {
      const res = await fetch(`/api/payroll/runs/${run.document_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-scope', employeePartyIds: includedPartyIds, rosterPartyIds }),
      })
      // The status is checked before the body is parsed (see act above).
      if (!res.ok) throw new Error(await readApiErrorMessage(res, 'failed'))
      if (calculated) {
        const recalc = await fetch(`/api/payroll/runs/${run.document_id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'calculate' }),
        })
        if (!recalc.ok) throw new Error(await readApiErrorMessage(recalc, 'failed'))
        const rj = await recalc.json()
        applyRefusalState(rj)
        setGl({ state: 'idle', legs: [], debitTotal: '0', error: '' })
      }
      toast.success(t('wizard.period.scopeSaved', { count: includedPartyIds.length }))
      router.refresh()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Returns true when the edit AND its recalculation both landed. A failure
   * keeps the drawer's idempotency key: the retry replays instead of writing
   * a second adjustment — so callers must only clear/close on true.
   */
  async function adjust(body: Record<string, unknown>): Promise<boolean> {
    if (adjustInflight.current) return false
    adjustInflight.current = true
    setBusy(true)
    try {
      // The drawers mint one idempotency key per form session; it travels as
      // the Idempotency-Key header (the document-create contract), never as
      // a stored adjustment field.
      const { idempotencyKey, ...action } = body
      const res = await fetch(`/api/payroll/runs/${run.document_id}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(typeof idempotencyKey === 'string' && idempotencyKey !== ''
            ? { 'Idempotency-Key': idempotencyKey }
            : {}),
        },
        body: JSON.stringify(action),
      })
      // The status is checked before the body is parsed (see act above).
      if (!res.ok) throw new Error(await readApiErrorMessage(res, 'failed'))
      const recalc = await fetch(`/api/payroll/runs/${run.document_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'calculate' }),
      })
      if (!recalc.ok) throw new Error(await readApiErrorMessage(recalc, 'failed'))
      const rj = await recalc.json()
      applyRefusalState(rj)
      setGl({ state: 'idle', legs: [], debitTotal: '0', error: '' })
      toast.success(t('wizard.adjust.applied'))
      router.refresh()
      return true
    } catch (e) {
      toast.error((e as Error).message)
      return false
    } finally {
      adjustInflight.current = false
      setBusy(false)
    }
  }

  async function emailStubs() {
    setBusy(true)
    try {
      const res = await fetch(`/api/payroll/runs/${run.document_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'email-stubs' }),
      })
      // The status is checked before the body is parsed (see act above).
      if (!res.ok) throw new Error(await readApiErrorMessage(res, 'failed'))
      const j = await res.json()
      const skipped = [...(j.noEmail ?? []), ...(j.failed ?? []).map((f: { name: string }) => f.name)]
      if (skipped.length > 0) {
        toast.warning(t('wizard.finish.stubsEmailedPartial', { sent: j.sent, skipped: skipped.join(', ') }))
      } else {
        toast.success(t('wizard.finish.stubsEmailed', { sent: j.sent }))
      }
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function recordPayment(bankAccountId: string) {
    setBusy(true)
    try {
      const res = await fetch(`/api/payroll/runs/${run.document_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'record-payment', bankAccountId }),
      })
      // The status is checked before the body is parsed (see act above).
      if (!res.ok) throw new Error(await readApiErrorMessage(res, 'failed'))
      toast.success(t('wizard.finish.paymentRecorded'))
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function attributeEntity(subsidiaryId: string) {
    setBusy(true)
    try {
      const res = await fetch(`/api/payroll/runs/${run.document_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'attribute-entity', subsidiaryId }),
      })
      // The status is checked before the body is parsed (see act above).
      if (!res.ok) throw new Error(await readApiErrorMessage(res, 'failed'))
      toast.success(t('wizard.finish.entityAttributed'))
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function post() {
    setBusy(true)
    try {
      const res = await fetch('/api/documents/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'post', documentId: run.document_id }),
      })
      // The status is checked before the body is parsed (see act above).
      if (!res.ok) throw new Error(await readApiErrorMessage(res, 'failed'))
      toast.success(t('run.postDone'))
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function discardDraft() {
    const confirmed = await confirmDialog({
      title: t('run.discardTitle'),
      message: t('run.discardBody'),
      confirmLabel: t('run.discardDraft'),
      tone: 'danger',
    })
    if (!confirmed) return
    setBusy(true)
    try {
      const res = await fetch(`/api/payroll/runs/${run.document_id}`, { method: 'DELETE' })
      // The status is checked before the body is parsed (see act above).
      if (!res.ok) throw new Error(await readApiErrorMessage(res, 'failed'))
      toast.success(t('run.discardDone'))
      router.push('/payroll/runs')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const steps: { key: WizardStep; label: string }[] = [
    { key: 'period', label: t('wizard.steps.period') },
    { key: 'readiness', label: t('wizard.steps.readiness') },
    { key: 'review', label: t('wizard.steps.review') },
    { key: 'gl', label: t('wizard.steps.gl') },
    { key: 'finish', label: t('wizard.steps.finish') },
  ]

  return (
    <div className="space-y-4">
      {/* Run vitals strip */}
      <div className="flex flex-wrap items-center gap-4 text-sm text-slate-600 dark:text-slate-300">
        <RunStatusBadge status={runDisplayStatus(run)} />
        {run.run_type !== 'regular' && (
          <Badge variant="secondary">{runTypeLabel(t, run.run_type)}</Badge>
        )}
        <span>
          {t('columns.payDate')}: <span className="font-medium tabular-nums">{run.pay_date}</span>
        </span>
        <span>
          {t('columns.gross')}: <span className="font-medium tabular-nums">{fmt(run.gross_total)}</span>
        </span>
        <span>
          {t('columns.net')}: <span className="font-medium tabular-nums">{fmt(run.net_total)}</span>
        </span>
        <span>
          {t('run.employerCost')}: <span className="font-medium tabular-nums">{fmt(run.employer_cost_total)}</span>
        </span>
        <span>
          {t('columns.employees')}: <span className="font-medium tabular-nums">{run.employee_count}</span>
        </span>
        {discardable && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void discardDraft()}>
            <Trash2 size={14} aria-hidden /> {t('run.discardDraft')}
          </Button>
        )}
      </div>

      {voided && (
        <div className="flex items-center gap-3 rounded-xl border border-red-200/80 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-300">
          <AlertTriangle size={16} aria-hidden />
          {t('wizard.voided')}
        </div>
      )}

      {/* Stale stubs: an input moved after the last calculation. Commit is
          disabled until the run is recalculated — the figures on screen are
          not the figures the inputs now produce. */}
      {props.staleness.stale && !committed && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200/80 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300">
          <span className="flex items-center gap-2">
            <RefreshCw size={16} aria-hidden />
            {t('wizard.stale.title', {
              reasons: props.staleness.reasons
                .map((r) => (t.has(`wizard.stale.reason.${r}` as never)
                  ? t(`wizard.stale.reason.${r}` as never)
                  : (STALE_REASON_FALLBACK[r] ?? r)))
                .join(', '),
            })}
          </span>
          {canCalculate && (
            <Button size="sm" disabled={busy} onClick={() => act('calculate')}>
              {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Calculator size={14} aria-hidden />}
              {t('wizard.period.recalculate')}
            </Button>
          )}
        </div>
      )}

      {/* Step chips — every step stays clickable (unlike a forced-linear wizard). */}
      <ol className="flex flex-wrap items-center gap-2" aria-label={t('wizard.stepsAria')}>
        {steps.map((item, index) => {
          const isCurrent = step === item.key
          const isDone = complete[item.key]
          return (
            <li key={item.key} className="flex items-center gap-2">
              {index > 0 && <ChevronRight size={14} aria-hidden className="text-slate-300 dark:text-slate-700" />}
              <button
                type="button"
                onClick={() => setStep(item.key)}
                aria-current={isCurrent ? 'step' : undefined}
                className={cn(
                  'inline-flex items-center gap-2 rounded-full border py-1.5 pr-3.5 pl-1.5 text-sm font-medium transition-colors',
                  isCurrent
                    ? 'border-teal-600 bg-teal-600 text-white shadow-sm dark:border-teal-500 dark:bg-teal-600'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-teal-300 hover:text-teal-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-teal-700 dark:hover:text-teal-300',
                )}
              >
                <span
                  className={cn(
                    'grid h-6 w-6 place-items-center rounded-full text-xs font-semibold',
                    isCurrent
                      ? 'bg-white/20 text-white'
                      : isDone
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                        : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
                  )}
                >
                  {isDone && !isCurrent ? <Check size={13} aria-hidden /> : index + 1}
                </span>
                {item.label}
              </button>
            </li>
          )
        })}
      </ol>

      {step === 'period' && (
        <PeriodStep
          run={run}
          roster={props.roster}
          stubs={props.stubs}
          adjustments={props.adjustments}
          canEditScope={props.canRun && docDraft && run.run_status !== 'committed'}
          calculated={calculated}
          busy={busy}
          onContinue={() => setStep('readiness')}
          onSetScope={setScope}
          fmt={fmt}
        />
      )}
      {step === 'readiness' && (
        <ReadinessStep
          runId={run.document_id}
          roster={props.roster}
          readiness={props.readiness}
          canCalculate={canCalculate}
          calculated={calculated}
          busy={busy}
          dry={dry}
          onDryRun={dryRun}
          onCalculate={() => act('calculate')}
          onAnswered={dryRun}
          fmt={fmt}
        />
      )}
      {step === 'review' && (
        <ReviewStep
          runId={run.document_id}
          roster={props.roster}
          stubs={props.stubs}
          adjustments={props.adjustments}
          components={props.adjustableComponents}
          canAdjust={props.canRun && docDraft && run.run_status !== 'committed'}
          busy={busy}
          onAdjust={adjust}
          onAnswered={() => act('calculate')}
          previousNet={props.previousNet}
          changes={props.changes}
          calcErrors={calcErrors}
          calculated={calculated}
          registerReportId={props.registerReportId}
          registerBuckets={props.registerBuckets}
          regionLabel={props.regionLabel}
          traceEngines={props.traceEngines}
          factorLabels={props.factorLabels}
          anomalyBlocks={props.anomalyBlocks}
          fmt={fmt}
        />
      )}
      {step === 'gl' && (
        <GlStep
          gl={gl}
          documentId={run.document_id}
          calculated={calculated}
          committed={committed || posted}
          canCommit={canCommit}
          canSubmitApproval={canSubmitApproval}
          approval={props.approval}
          canAcknowledge={props.canRun && commitDocOpen && run.run_status === 'calculated'}
          stale={props.staleness.stale}
          funding={props.funding}
          busy={busy}
          refusals={refusals}
          acknowledgement={acknowledgement}
          refusalsAcked={refusalsAcked}
          anomalyBlocks={props.anomalyBlocks}
          onAcknowledge={() => void acknowledgeRefusals()}
          onSubmitApproval={() => void submitApproval()}
          onRetry={() => {
            setGl((g) => ({ ...g, state: 'loading' }))
            void loadGlPreview()
          }}
          onCommit={() => act('commit')}
          fmt={fmt}
        />
      )}
      {step === 'finish' && (
        <FinishStep
          run={run}
          separationSections={props.separationSections}
          remittance={props.remittance}
          posted={posted}
          committed={committed}
          canPost={canPost}
          busy={busy}
          onPost={post}
          onEmailStubs={emailStubs}
          onRecordPayment={recordPayment}
          onAttributeEntity={attributeEntity}
          registerReportId={props.registerReportId}
          bankAccounts={props.bankAccounts}
          entityOptions={props.entityOptions}
          canAttributeEntity={props.canAttributeEntity}
          funding={props.funding}
          canRun={props.canRun}
          acknowledgement={acknowledgement}
          fmt={fmt}
        />
      )}
    </div>
  )
}

// Split from this file (ARCH-FILE-SPLIT): the same exports from the same path.
export type { WizardStep, ReadinessItem, Readiness, Staleness, Funding, StubChange, RunHeader, StubRow, RosterRow, RemittanceRow, AdjustmentRow, ComponentOption } from './run-wizard-model'
export { BulkEditDrawer } from './BulkEditDrawer'
export { StubDrawer } from './StubDrawer'
export { fetchChequePdf } from './steps/FinishStep'
