import Link from 'next/link'
import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, UrlDrawer } from '@openbooks/ui'
import {
  CompensationSettingsForm,
  CycleCreateForm,
  CycleMoveButtons,
  EquityGenerateForm,
  LineDecideButtons,
  LineProposeForm,
  PayInfoRequestButton,
  PlanCreateForm,
  PlanLineApproveButton,
} from './islands'
import type {
  CompCycleDialogState,
  CompDialogRefusal,
  CompEquityDialogState,
  CompLineRow,
  CompPlanDialogState,
} from '../../../../lib/hrm/compensation'

/**
 * Compensation sections (server components): the band placement bar
 * (min/target/max with the rate marker), the budget pacing bar, the
 * cycle line drawer (proposal form, decide buttons, event history), the
 * create dialogs, and the settings form. The lists render through the
 * shared `table` block and `filter-chips` widget in ./view, so they live
 * there and not here. Every string arrives loader-resolved as props —
 * no org id, user id, or Authz crosses into render.
 */

export function PlacementBar({
  min,
  target,
  max,
  rate,
  label,
}: {
  min: string | null
  target: string | null
  max: string | null
  rate: string | null
  label: string
}) {
  if (min === null || target === null || max === null || rate === null) {
    return <span className="text-sm text-slate-500 dark:text-slate-400">{label}</span>
  }
  const lo = Number(min)
  const hi = Number(max)
  const at = Number(rate)
  const span = hi - lo > 0 ? hi - lo : 1
  const pct = Math.min(100, Math.max(0, ((at - lo) / span) * 100))
  const targetPct = Math.min(100, Math.max(0, ((Number(target) - lo) / span) * 100))
  return (
    <span className="flex min-w-28 flex-col gap-1" role="img" aria-label={label}>
      <span className="relative h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-700">
        <span className="absolute top-[-3px] h-3 w-0.5 bg-slate-400 dark:bg-slate-500" style={{ left: `${targetPct}%` }} />
        <span className="absolute top-[-2px] h-2.5 w-2.5 rounded-full bg-blue-600" style={{ left: `calc(${pct}% - 5px)` }} />
      </span>
      <span className="text-xs text-slate-500 dark:text-slate-400">{label}</span>
    </span>
  )
}

export function PacingBar({ pct, note }: { pct: number | null; note: string }) {
  if (pct === null) return <span className="text-sm text-slate-500 dark:text-slate-400">{note}</span>
  const width = Math.min(100, Math.max(0, pct))
  return (
    <span className="flex min-w-40 flex-col gap-1" role="img" aria-label={note}>
      <span className="relative h-2 w-full rounded-full bg-slate-200 dark:bg-slate-700">
        <span
          className={`absolute left-0 top-0 h-2 rounded-full ${pct > 100 ? 'bg-red-500' : 'bg-blue-600'}`}
          style={{ width: `${width}%` }}
        />
      </span>
      <span className="text-xs text-slate-500 dark:text-slate-400">{note}</span>
    </span>
  )
}

export interface CompDrawerLabels {
  proposeTitle: string
  decideTitle: string
  historyTitle: string
  pctLabel: string
  rateLabel: string
  reasonLabel: string
  pctInvalid: string
  decideReasonLabel: string
  failed: string
  submit: string
  cancel: string
  approve: string
  reject: string
  reopen: string
}

export interface LineDrawerData {
  open: boolean
  closeHref: string
  title: string
  line: CompLineRow | null
  history: { kind: string; actor: string | null; reason: string | null; at: string }[]
  labels: CompDrawerLabels
  cycleId: string
  canDecide: boolean
  /** Transition-table gates from the loader (F3-38): the forms render
   *  only while the round/line state allows the action. */
  canPropose: boolean
  canDecideLine: boolean
  historyColumns: { event: string; reason: string; at: string }
  emptyHistory: string
}

export function CompLineDrawer({ drawer }: { drawer: LineDrawerData }) {
  if (!drawer.open || !drawer.line) return null
  const line = drawer.line
  return (
    <UrlDrawer open closeHref={drawer.closeHref} title={drawer.title}>
      <div className="flex flex-col gap-6">
        {drawer.canPropose ? (
          <div>
            <h3 className="mb-2 text-sm font-semibold">{drawer.labels.proposeTitle}</h3>
            <LineProposeForm
              cycleId={drawer.cycleId}
              lineId={line.id}
              labels={{ failed: drawer.labels.failed, submit: drawer.labels.submit, cancel: drawer.labels.cancel }}
              pctLabel={drawer.labels.pctLabel}
              rateLabel={drawer.labels.rateLabel}
              reasonLabel={drawer.labels.reasonLabel}
              pctInvalidLabel={drawer.labels.pctInvalid}
              closeHref={drawer.closeHref}
            />
          </div>
        ) : null}
        {drawer.canDecide && drawer.canDecideLine ? (
          <div>
            <h3 className="mb-2 text-sm font-semibold">{drawer.labels.decideTitle}</h3>
            <LineDecideButtons
              cycleId={drawer.cycleId}
              lineId={line.id}
              labels={{ failed: drawer.labels.failed, submit: drawer.labels.submit, cancel: drawer.labels.cancel }}
              reasonLabel={drawer.labels.decideReasonLabel}
              approveLabel={drawer.labels.approve}
              rejectLabel={drawer.labels.reject}
              reopenLabel={drawer.labels.reopen}
            />
          </div>
        ) : null}
        <div>
          <h3 className="mb-2 text-sm font-semibold">{drawer.labels.historyTitle}</h3>
          {drawer.history.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">{drawer.emptyHistory}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{drawer.historyColumns.event}</TableHead>
                  <TableHead>{drawer.historyColumns.reason}</TableHead>
                  <TableHead>{drawer.historyColumns.at}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drawer.history.map((h, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <Badge variant="secondary">{h.kind}</Badge>
                    </TableCell>
                    <TableCell>{h.reason ?? '—'}</TableCell>
                    <TableCell>{h.at.slice(0, 16).replace('T', ' ')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </UrlDrawer>
  )
}

/**
 * The create-dialog payloads live in the loader (web/lib/hrm/compensation),
 * next to the permission and feature gates that arm them — these aliases
 * keep the historic names the widget adapters resolve.
 */
export type CompDialogData = CompCycleDialogState
export type PlanDialogData = CompPlanDialogState
export type EquityDialogData = CompEquityDialogState

/**
 * A computed prerequisite refusal inside an open create dialog: the dialog
 * stays open on its named title with the remedy beside it — never an empty
 * drawer, never a silent close. Setup managers get the real switch (the
 * Features switchboard link); everyone else gets the person to ask.
 */
export function DialogRefusal({
  refusal,
  remedyHref,
  remedyLabel,
}: {
  refusal: CompDialogRefusal
  remedyHref: string | null
  remedyLabel: string | null
}) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold">{refusal.title}</h3>
      <p className="text-sm text-slate-500 dark:text-slate-400">{refusal.message}</p>
      {remedyHref && remedyLabel ? (
        <div>
          <Button asChild>
            <Link href={remedyHref}>{remedyLabel}</Link>
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export function CompCycleDialog({ dialog }: { dialog: CompDialogData }) {
  if (!dialog.open) return null
  return (
    <UrlDrawer open closeHref={dialog.closeHref} title={dialog.title}>
      {dialog.refusal ? (
        <DialogRefusal refusal={dialog.refusal} remedyHref={dialog.remedyHref} remedyLabel={dialog.remedyLabel} />
      ) : (
        <CycleCreateForm
          labels={{ failed: dialog.failed, submit: dialog.submit, cancel: dialog.cancel }}
          closeHref={dialog.closeHref}
          kinds={dialog.kinds}
          kindLabel={dialog.kindLabel}
          nameLabel={dialog.nameLabel}
          effectiveLabel={dialog.effectiveLabel}
          currencyLabel={dialog.currencyLabel}
        />
      )}
    </UrlDrawer>
  )
}

export function CompPlanDialog({ dialog }: { dialog: PlanDialogData }) {
  if (!dialog.open) return null
  return (
    <UrlDrawer open closeHref={dialog.closeHref} title={dialog.title}>
      {dialog.refusal ? (
        <DialogRefusal refusal={dialog.refusal} remedyHref={dialog.remedyHref} remedyLabel={dialog.remedyLabel} />
      ) : (
        <PlanCreateForm
          labels={{ failed: dialog.failed, submit: dialog.submit, cancel: dialog.cancel }}
          closeHref={dialog.closeHref}
          nameLabel={dialog.nameLabel}
          fromLabel={dialog.fromLabel}
          toLabel={dialog.toLabel}
        />
      )}
    </UrlDrawer>
  )
}

export function CompEquityDialog({ dialog }: { dialog: EquityDialogData }) {
  if (!dialog.open) return null
  return (
    <UrlDrawer open closeHref={dialog.closeHref} title={dialog.title}>
      {dialog.refusal ? (
        <DialogRefusal refusal={dialog.refusal} remedyHref={dialog.remedyHref} remedyLabel={dialog.remedyLabel} />
      ) : (
        <EquityGenerateForm
          labels={{ failed: dialog.failed, submit: dialog.submit, cancel: dialog.cancel }}
          closeHref={dialog.closeHref}
          asOfLabel={dialog.asOfLabel}
          groupALabel={dialog.groupALabel}
          groupBLabel={dialog.groupBLabel}
        />
      )}
    </UrlDrawer>
  )
}

export {
  CompensationSettingsForm,
  CycleMoveButtons,
  PayInfoRequestButton,
  PlanLineApproveButton,
}

/** Placement summary line on the Me surface: loader-resolved strings, no chart. */
export function PlacementSummary({ placement, compaRatio, bandRange }: { placement: string; compaRatio: string | null; bandRange: string | null }) {
  return (
    <p className="text-sm">
      {placement}
      {compaRatio ? <span className="text-slate-500 dark:text-slate-400"> · {compaRatio}</span> : null}
      {bandRange ? <span className="text-slate-500 dark:text-slate-400"> · {bandRange}</span> : null}
    </p>
  )
}

/** Pay-information request action with the open request's status. */
export function PayInfoRequest({
  employmentId,
  requestLabel,
  requestStatus,
  failed,
  submit,
  cancel,
}: {
  employmentId: string
  requestLabel: string
  requestStatus: string | null
  failed: string
  submit: string
  cancel: string
}) {
  return (
    <div className="flex flex-col gap-2">
      <PayInfoRequestButton employmentId={employmentId} labels={{ failed, submit, cancel }} requestLabel={requestLabel} />
      {requestStatus ? <p className="text-sm text-slate-500 dark:text-slate-400">{requestStatus}</p> : null}
    </div>
  )
}
