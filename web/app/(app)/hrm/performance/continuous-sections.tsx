import { UrlDrawer } from '@openbooks/ui'
import {
  CalibrationEntryEditor,
  FeedbackDialog,
  FeedbackSettingsForm,
  OneOnOneAgenda,
  SessionActions,
  SessionCreateForm,
  TalentDialog,
} from './continuous-islands'
import type { MeOneOnOnesData } from '../../../me/one-on-ones/view'
import type { ContinuousData } from './continuous-view'

/**
 * HR-17 continuous-performance server shells: the calibration entry row
 * editor, session actions, the session create dialog, the distribution
 * strip, the missing list, the 9-box talent dialog, the feedback
 * settings form, and the 1:1 agenda drawer. Every string arrives
 * loader-resolved as props — no org id, user id, or Authz crosses into
 * render.
 */

type Calibration = NonNullable<ContinuousData['calibration']>
type CalibrationDetail = NonNullable<Calibration['detail']>
type Talent = NonNullable<ContinuousData['talent']>

export function CalibrationEntryShell({ editor }: { editor: CalibrationDetail['entries'][number]['editor'] }) {
  return (
    <CalibrationEntryEditor
      entryId={editor.entryId}
      calibratedRating={editor.calibratedRating}
      potentialKey={editor.potentialKey}
      potentialOptions={editor.potentialOptions}
      justification={editor.justification}
      ratingLabel={editor.ratingLabel}
      potentialLabel={editor.potentialLabel}
      justificationLabel={editor.justificationLabel}
      saveLabel={editor.saveLabel}
      revertLabel={editor.revertLabel}
      revertReasonLabel={editor.revertReasonLabel}
      failed={editor.failed}
    />
  )
}

export function SessionActionsShell({ detail }: { detail: CalibrationDetail }) {
  return (
    <SessionActions
      sessionId={detail.id}
      status={detail.status}
      openLabel={detail.openLabel}
      closeLabel={detail.closeLabel}
      failed={detail.failed}
    />
  )
}

export function SessionDialogShell({ create }: { create: NonNullable<CalibrationDetail['create']> }) {
  return (
    <SessionCreateForm
      cycles={create.cycles}
      nameLabel={create.nameLabel}
      cycleLabel={create.cycleLabel}
      submitLabel={create.submitLabel}
      cancelLabel={create.cancelLabel}
      closeHref={create.closeHref}
      failed={create.failed}
    />
  )
}

export function CalibrationDistributionShell({
  title,
  distribution,
}: {
  title: string
  distribution: { key: string; count: number; width: number }[]
}) {
  if (distribution.length === 0) return null
  return (
    <section aria-label={title} className="space-y-1.5">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
      {distribution.map((bar) => (
        <div key={bar.key} className="flex items-center gap-2">
          <span className="w-24 shrink-0 truncate text-xs text-slate-600 dark:text-slate-300">{bar.key}</span>
          <div className="h-2 min-w-0 flex-1 rounded bg-slate-100 dark:bg-slate-800">
            <div className="h-2 rounded bg-slate-500 dark:bg-slate-400" style={{ width: `${bar.width}%` }} />
          </div>
          <span className="w-8 shrink-0 text-right text-xs tabular-nums text-slate-600 dark:text-slate-300">
            {bar.count}
          </span>
        </div>
      ))}
    </section>
  )
}

export function CalibrationMissingShell({
  title,
  missing,
}: {
  title: string
  missing: { review: string; reason: string }[]
}) {
  if (missing.length === 0) return null
  return (
    <section aria-label={title} className="space-y-1.5">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
      <ul className="space-y-1">
        {missing.map((m) => (
          <li key={m.review} className="text-sm text-slate-600 dark:text-slate-300">
            {m.review} · {m.reason}
          </li>
        ))}
      </ul>
    </section>
  )
}

export function TalentDialogShell({ dialog }: { dialog: Talent['dialog'] }) {
  return (
    <TalentDialog
      employments={dialog.employments}
      positions={dialog.positions}
      perfOptions={dialog.perfOptions}
      potOptions={dialog.potOptions}
      perfLabel={dialog.perfLabel}
      potLabel={dialog.potLabel}
      impactLabel={dialog.impactLabel}
      riskLabel={dialog.riskLabel}
      lossOptions={dialog.lossOptions}
      promotionLabel={dialog.promotionLabel}
      notesLabel={dialog.notesLabel}
      submitLabel={dialog.submitLabel}
      cancelLabel={dialog.cancelLabel}
      closeHref={dialog.closeHref}
      failed={dialog.failed}
      openLabel={dialog.openLabel}
      modeLabel={dialog.modeLabel}
      modeTalentLabel={dialog.modeTalentLabel}
      modeSuccessionLabel={dialog.modeSuccessionLabel}
      employeeLabel={dialog.employeeLabel}
      positionLabel={dialog.positionLabel}
    />
  )
}

export function FeedbackSettingsShell({
  settings,
}: {
  settings: NonNullable<ContinuousData['feedbackSettings']>
}) {
  return (
    <section aria-label={settings.title} className="space-y-2">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{settings.title}</h2>
      <FeedbackSettingsForm
        current={settings.current}
        anyoneLabel={settings.anyoneLabel}
        managersLabel={settings.managersLabel}
        saveLabel={settings.saveLabel}
        failed={settings.failed}
      />
    </section>
  )
}

export function FeedbackDialogShell({
  subjectEmploymentId,
  requestedFromPartyId,
  subjectLabel,
  requestId,
  kinds,
  kindLabel,
  visibilities,
  visibilityLabel,
  bodyLabel,
  bodyPlaceholder,
  submitLabel,
  cancelLabel,
  closeHref,
  failed,
  openLabel,
}: {
  subjectEmploymentId: string
  requestedFromPartyId?: string | null
  subjectLabel: string
  requestId: string | null
  kinds: { value: string; label: string }[]
  kindLabel: string
  visibilities: { value: string; label: string }[]
  visibilityLabel: string
  bodyLabel: string
  bodyPlaceholder: string
  submitLabel: string
  cancelLabel: string
  closeHref: string
  failed: string
  openLabel: string
}) {
  if (!subjectEmploymentId && !requestId) return null
  return (
    <FeedbackDialog
      subjectEmploymentId={subjectEmploymentId}
      requestedFromPartyId={requestedFromPartyId}
      subjectLabel={subjectLabel}
      requestId={requestId}
      kinds={kinds}
      kindLabel={kindLabel}
      visibilities={visibilities}
      visibilityLabel={visibilityLabel}
      bodyLabel={bodyLabel}
      bodyPlaceholder={bodyPlaceholder}
      submitLabel={submitLabel}
      cancelLabel={cancelLabel}
      closeHref={closeHref}
      failed={failed}
      openLabel={openLabel}
    />
  )
}

export function NoteShell({ note }: { note: string | null }) {
  if (!note) return null
  return <p className="text-xs text-slate-500 dark:text-slate-400">{note}</p>
}

/** The 1:1 agenda flyout: a URL drawer around the agenda island that closes by navigation. */
export function OneOnOneDrawer({
  detail,
}: {
  detail: MeOneOnOnesData['detail']
}) {
  if (!detail) return null
  return (
    <UrlDrawer
      open
      closeHref={detail.closeHref}
      title={detail.title}
      description={`${detail.with} · ${detail.when}`}
    >
      <OneOnOneAgenda
        oneOnOneId={detail.id}
        status={detail.status}
        items={detail.items}
        canWrite={detail.canWrite}
        newKinds={detail.newKinds}
        newKindLabel={detail.newKindLabel}
        bodyLabel={detail.bodyLabel}
        bodyPlaceholder={detail.bodyPlaceholder}
        privateLabel={detail.privateLabel}
        sharedLabel={detail.sharedLabel}
        addLabel={detail.addLabel}
        holdLabel={detail.holdLabel}
        skipLabel={detail.skipLabel}
        skipReasonLabel={detail.skipReasonLabel}
        cancelLabel={detail.cancelLabel}
        carryNote={detail.carryNote}
        failed={detail.failed}
      />
    </UrlDrawer>
  )
}
