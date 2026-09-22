import { UrlDrawer } from '@openbooks/ui'
import { CycleActions } from './CycleActions'
import { CycleCreateForm } from './CycleCreateForm'
import { GoalForm } from './GoalForm'
import { ReviewActions } from './ReviewActions'
import { ReviewAnswerForm } from './ReviewAnswerForm'
import { ExitRecordForm } from './ExitRecordForm'
import type { PerformancePageData } from './view'

type PageData = PerformancePageData

/**
 * Performance drawer sections (server components): the cycle flyout with
 * its reviews table and calibration island, the review flyout with the
 * snapshot answer form and the goals section, the cycle create dialog, and
 * the Retention panel. Every string arrives loader-resolved as props — no
 * org id, user id, or Authz crosses into render.
 */

export function CycleDrawerBody({ detail }: { detail: NonNullable<PerformancePageData['detail']> }) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {detail.cycleName} · {detail.templateName}
        </h3>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{detail.period}</p>
      </div>
      <div>
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{detail.reviewsTitle}</h4>
        {detail.reviews.length === 0 ? (
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{detail.reviewsEmpty}</p>
        ) : (
          <ul className="mt-1 space-y-1.5">
            {detail.reviews.map((review) => (
              <li key={review.id} className="text-sm text-slate-600 dark:text-slate-300">
                <a className="font-medium underline" href={review.href}>
                  {review.kindLabel}
                </a>{' '}
                · {review.statusLabel}
                {review.rating ? ` · ${review.rating}` : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <CycleActions cycleId={detail.cycleId} calibration={detail.calibration} />
    </div>
  )
}

/** The cycle flyout shell: a URL drawer around CycleDrawerBody that closes by navigation. */
export function CycleDrawer({
  detail,
  missingDetail,
}: {
  detail: PerformancePageData['detail']
  missingDetail: string | null
}) {
  if (!detail && !missingDetail) return null
  return (
    <UrlDrawer
      open
      closeHref={detail?.closeHref ?? '/hrm/performance'}
      title={detail?.cycleName ?? ''}
      description={detail ? `${detail.templateName} · ${detail.period}` : undefined}
    >
      {detail ? (
        <CycleDrawerBody detail={detail} />
      ) : (
        <p className="text-sm text-slate-500 dark:text-slate-400">{missingDetail}</p>
      )}
    </UrlDrawer>
  )
}

export function ReviewDrawerBody({ review }: { review: NonNullable<PerformancePageData['review']> }) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {review.kindLabel} · {review.statusLabel}
        </h3>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {review.overallLabel}: {review.overallRating ?? '—'}
          {review.calibratedRating ? ` · ${review.calibratedLabel}: ${review.calibratedRating}` : null}
        </p>
        {review.calibrationReason ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">{review.calibrationReason}</p>
        ) : null}
      </div>
      {review.canAnswer ? (
        <ReviewAnswerForm
          reviewId={review.id}
          cycleId={review.cycleId}
          answers={review.answers}
          submitLabel={review.submitLabel}
          ratingLabel={review.answerRatingLabel}
          textLabel={review.answerTextLabel}
          requiredLabel={review.requiredLabel}
          failed={review.failed}
          draft={review.draft}
        />
      ) : (
        <div>
          {review.answers.map((answer) => (
            <div key={answer.id} className="mt-3">
              <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {answer.sectionTitle}
                {answer.questionPrompt ? ` — ${answer.questionPrompt}` : null}
              </h4>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                {answer.rating ?? ''}
                {answer.rating && answer.text ? ' · ' : null}
                {answer.text ?? ''}
              </p>
            </div>
          ))}
        </div>
      )}
      <div>
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{review.goalsTitle}</h4>
        {review.goals.length === 0 ? (
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{review.goalsEmpty}</p>
        ) : (
          <ul className="mt-1 space-y-1.5">
            {review.goals.map((goal) => (
              <li key={goal.id} className="text-sm text-slate-600 dark:text-slate-300">
                <span className="font-medium">{goal.title}</span> · {goal.status} · {goal.progress}%
              </li>
            ))}
          </ul>
        )}
      </div>
      <ReviewActions
        reviewId={review.id}
        cycleId={review.cycleId}
        canShare={review.canShare}
        canAcknowledge={review.canAcknowledge}
        canCalibrate={review.canCalibrate}
        canReopen={review.canReopen}
        shareLabel={review.shareLabel}
        acknowledgeLabel={review.acknowledgeLabel}
        calibrateLabel={review.calibrateLabel}
        calibrateRatingLabel={review.calibrateRatingLabel}
        reasonLabel={review.reasonLabel}
        reopenLabel={review.reopenLabel}
        failed={review.failed}
      />
    </div>
  )
}

/** The review flyout shell: a URL drawer around ReviewDrawerBody that closes by navigation. */
export function ReviewDrawer({
  review,
  missingReview,
}: {
  review: PerformancePageData['review']
  missingReview: string | null
}) {
  if (!review && !missingReview) return null
  return (
    <UrlDrawer
      open
      closeHref={review?.closeHref ?? '/hrm/performance'}
      title={review?.kindLabel ?? ''}
    >
      {review ? (
        <ReviewDrawerBody review={review} />
      ) : (
        <p className="text-sm text-slate-500 dark:text-slate-400">{missingReview}</p>
      )}
    </UrlDrawer>
  )
}

/** The cycle create dialog, opened from the page header through `?cycle=new`. */
export function CycleDialog({ create }: { create: PerformancePageData['create'] }) {
  if (!create) return null
  return (
    <UrlDrawer open closeHref={create.closeHref} title="">
      <CycleCreateForm {...create} />
    </UrlDrawer>
  )
}

/** The Retention panel: trailing-twelve-months turnover, regrettable leavers, gaps. */
// RetentionPanel used to live here: a bespoke <section> of bold headings and
// comma-joined figures, rendered with no card around it under the cycles
// table. Retention is its own tab now and renders through the house blocks
// — three stat tiles and a table — in ./view.

export function GoalSection({ employmentId, cycleId }: { employmentId: string; cycleId: string }) {
  return <GoalForm employmentId={employmentId} cycleId={cycleId} />
}

/** The exit drawer (?exit=<employmentId>): HR managers record and correct
 *  through the form; retention readers see the record read-only. */
export function ExitDrawer({
  exit,
  missingExit,
}: {
  exit: PageData['exit']
  missingExit: string | null
}) {
  if (!exit && !missingExit) return null
  return (
    <UrlDrawer open closeHref={exit?.closeHref ?? '/hrm/performance'} title={exit?.title ?? ''}>
      {exit ? (
        exit.canRecord ? (
          <ExitRecordForm employmentId={exit.employmentId} existing={exit.existing} />
        ) : exit.existing ? (
          <div className="space-y-2">
            <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
              {exit.existing.reasonKind}
              {' · '}
              {exit.existing.isVoluntary ? exit.voluntaryLabel : exit.involuntaryLabel}
              {exit.existing.destination ? ` · ${exit.existing.destination}` : null}
            </p>
            {exit.existing.notes ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">{exit.existing.notes}</p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">{missingExit}</p>
        )
      ) : (
        <p className="text-sm text-slate-500 dark:text-slate-400">{missingExit}</p>
      )}
    </UrlDrawer>
  )
}
