import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, UrlDrawer } from '@openbooks/ui'
import { RecruitingCreateForm } from './RecruitingCreateForm'
import {
  ApplicationActionsIsland,
  ApplicationAttachIsland,
  InterviewScheduleIsland,
  InterviewActionsIsland,
  OfferActionsIsland,
  OfferCreateIsland,
  OfferSigningIsland,
  PoolRediscoverIsland,
  PoolMemberRemoveIsland,
  PostingActionsIsland,
  ScorecardFormIsland,
  SlotProposeIsland,
  type Option,
} from './actions'
import type { RecruitingPageData } from './view'
import type { InterviewDrawer, OfferDrawerExtra, PostingDrawerExtra, PoolDrawer, ConsentStatus } from './depth-view'

/**
 * Recruiting drawer sections (server components): the URL drawer shell
 * around the requisition body (pipeline stage chips, the applications
 * table, and action islands), the candidate body (applications plus
 * interviews), and the offer body (terms plus send/accept/decline). The
 * list itself renders through the shared `table` block and `filter-chips`
 * widget in ./view, so they live there and not here. Every string arrives
 * loader-resolved as props — no org id, user id, or Authz crosses into
 * render.
 */

export interface DrawerLabels {
  pipeline: string
  applications: string
  noApplications: string
  candidate: string
  stage: string
  applied: string
  lastEvent: string
  interviews: string
  offer: string
  timeToFill: string
  days: string
  attachTitle: string
  attachName: string
  attachEmail: string
  attachPhone: string
  attachSubmit: string
  attachFailed: string
  moveTitle: string
  moveSubmit: string
  moveFailed: string
  rejectTitle: string
  rejectReason: string
  rejectSubmit: string
  rejectFailed: string
  withdrawLabel: string
  withdrawFailed: string
  interviewTitle: string
  interviewKind: string
  interviewWhen: string
  interviewDuration: string
  interviewLocation: string
  interviewPanel: string
  interviewSubmit: string
  interviewFailed: string
  completeTitle: string
  completeOutcome: string
  completeFeedback: string
  completeSubmit: string
  completeFailed: string
  cancelLabel: string
  offerTitle: string
  offerJob: string
  offerStart: string
  offerAmount: string
  offerCurrency: string
  offerBasis: string
  offerExpires: string
  offerSubmit: string
  offerFailed: string
  offerSend: string
  offerAccept: string
  offerDecline: string
  offerWithdraw: string
  offerReason: string
  offerActionFailed: string
  description: string
}

export interface RequisitionDrawerData {
  id: string
  requisitionNumber: string
  title: string
  positionCode: string | null
  departmentName: string | null
  headcount: number
  filledCount: number
  hiringManagerName: string | null
  openedOn: string | null
  status: string
  targetStartOn: string | null
  compensation: string | null
  bandRange: string | null
  description: string | null
  stages: readonly { id: string; key: string; name: string; kind: string }[]
  funnel: readonly { stageKey: string; stageName: string; count: number }[]
  applications: readonly {
    id: string
    candidate: { id: string; displayName: string; email: string | null; phone: string | null; href: string }
    stageId: string
    stageKey: string
    stageName: string
    status: string
    appliedOn: string
    lastEventKind: string | null
    lastEventAt: string | null
    interviewsCount: number
    liveOfferStatus: string | null
  }[]
  timeToFillDays: number | null
  closeHref: string
  stageLabels: Record<string, string>
  statusLabels: Record<string, string>
  /** HR-21 "Draft from evidence" link for the description (job_description kind). */
  draft: { href: string; label: string } | null
  labels: DrawerLabels
  candidateOptions: Option[]
  employeeOptions: Option[]
  kindOptions: Option[]
  outcomeOptions: Option[]
  basisOptions: Option[]
}

export interface CandidateDrawerData {
  id: string
  displayName: string
  email: string | null
  phone: string | null
  source: string | null
  applications: readonly {
    requisitionId: string;
    requisitionNumber: string;
    requisitionTitle: string;
    applicationId: string;
    stageName: string;
    status: string;
    appliedOn: string;
  }[]
  interviews: readonly { id: string; applicationId: string; kind: string; scheduledAt: string; status: string; outcome: string | null }[]
  closeHref: string
  labels: { applications: string; interviews: string; email: string; phone: string; source: string }
  outcomeOptions: Option[]
  actionLabels: { outcome: string; feedback: string; submit: string; cancel: string; failed: string }
}

export interface OfferDrawerData {
  id: string
  applicationId: string
  requisitionId: string
  jobTitle: string
  proposedStartOn: string
  compensationAmount: string
  compensationCurrency: string
  compensationBasis: string
  status: string
  effectiveStatus: string
  sentAt: string | null
  expiresOn: string | null
  respondedAt: string | null
  declineReason: string | null
  closeHref: string
  /** HR-21 "Draft from evidence" link for the letter clauses (offer_letter_clauses kind). */
  draft: { href: string; label: string } | null
  labels: { send: string; accept: string; decline: string; withdraw: string; reason: string; failed: string }
}

/** The requisition flyout body: facts, pipeline chips, applications, islands. */
export function RequisitionDrawerBody({ detail }: { detail: RequisitionDrawerData }) {
  const { labels } = detail
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {detail.requisitionNumber} · {detail.title}
        </h3>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {detail.filledCount}/{detail.headcount}
          {detail.positionCode ? ` · ${detail.positionCode}` : null}
          {detail.departmentName ? ` · ${detail.departmentName}` : null}
          {detail.hiringManagerName ? ` · ${detail.hiringManagerName}` : null}
        </p>
        {detail.compensation ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">{detail.compensation}</p>
        ) : null}
        {detail.bandRange ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">{detail.bandRange}</p>
        ) : null}
        {detail.timeToFillDays !== null ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {labels.timeToFill}: {detail.timeToFillDays} {labels.days}
          </p>
        ) : null}
      </div>
      {detail.description || detail.draft ? (
        <div>
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{labels.description}</h4>
          {detail.description ? (
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300">{detail.description}</p>
          ) : null}
          {detail.draft ? (
            <a href={detail.draft.href} className="mt-1 inline-block text-sm font-medium text-teal-700 dark:text-teal-300">
              {detail.draft.label}
            </a>
          ) : null}
        </div>
      ) : null}
      <div>
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{labels.pipeline}</h4>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {detail.funnel.map((entry) => (
            <Badge key={entry.stageKey} variant="secondary">
              {entry.stageName} · {entry.count}
            </Badge>
          ))}
        </div>
      </div>
      <div>
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{labels.applications}</h4>
        {detail.applications.length === 0 ? (
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{labels.noApplications}</p>
        ) : (
          <div className="mt-2 space-y-4">
            {detail.applications.map((application) => (
              <div key={application.id} className="rounded-md border border-slate-200 p-3 dark:border-slate-800">
                <div className="flex flex-wrap items-center gap-2">
                  <a href={application.candidate.href} className="text-sm font-medium text-teal-700 dark:text-teal-300">
                    {application.candidate.displayName}
                  </a>
                  <Badge variant="outline">{application.stageName}</Badge>
                  <Badge variant="secondary">{application.status}</Badge>
                  {application.liveOfferStatus ? <Badge variant="warning">{application.liveOfferStatus}</Badge> : null}
                </div>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {labels.applied}: {application.appliedOn}
                  {application.lastEventKind ? ` · ${labels.lastEvent}: ${application.lastEventKind}` : null}
                  {` · ${labels.interviews}: ${application.interviewsCount}`}
                </p>
                <div className="mt-3 space-y-3">
                  <ApplicationActionsIsland
                    applicationId={application.id}
                    stages={detail.stages.map((stage) => ({ value: stage.id, label: stage.name }))}
                    labels={{
                      move: labels.moveSubmit,
                      reject: labels.rejectSubmit,
                      reason: labels.rejectReason,
                      withdraw: labels.withdrawLabel,
                      failed: labels.moveFailed,
                    }}
                  />
                  <details>
                    <summary className="cursor-pointer text-xs font-medium text-slate-700 dark:text-slate-300">
                      {labels.interviewTitle}
                    </summary>
                    <div className="mt-2">
                      <InterviewScheduleIsland
                        applicationId={application.id}
                        kinds={detail.kindOptions}
                        employees={detail.employeeOptions}
                        labels={{
                          kind: labels.interviewKind,
                          when: labels.interviewWhen,
                          duration: labels.interviewDuration,
                          location: labels.interviewLocation,
                          panel: labels.interviewPanel,
                          submit: labels.interviewSubmit,
                          failed: labels.interviewFailed,
                        }}
                      />
                    </div>
                  </details>
                  <details>
                    <summary className="cursor-pointer text-xs font-medium text-slate-700 dark:text-slate-300">
                      {labels.offerTitle}
                    </summary>
                    <div className="mt-2">
                      <OfferCreateIsland
                        applicationId={application.id}
                        bases={detail.basisOptions}
                        labels={{
                          job: labels.offerJob,
                          start: labels.offerStart,
                          amount: labels.offerAmount,
                          currency: labels.offerCurrency,
                          basis: labels.offerBasis,
                          expires: labels.offerExpires,
                          submit: labels.offerSubmit,
                          failed: labels.offerFailed,
                        }}
                      />
                    </div>
                  </details>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="mt-4">
          <h5 className="text-xs font-semibold text-slate-900 dark:text-slate-100">{labels.attachTitle}</h5>
          <div className="mt-2">
            <ApplicationAttachIsland
              requisitionId={detail.id}
              labels={{
                name: labels.attachName,
                email: labels.attachEmail,
                phone: labels.attachPhone,
                submit: labels.attachSubmit,
                failed: labels.attachFailed,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

/** The candidate flyout body: contact facts (as redacted), applications, interviews. */
export function CandidateDrawerBody({ detail }: { detail: CandidateDrawerData }) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{detail.displayName}</h3>
        {detail.email ? <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{detail.labels.email}: {detail.email}</p> : null}
        {detail.phone ? <p className="text-xs text-slate-500 dark:text-slate-400">{detail.labels.phone}: {detail.phone}</p> : null}
        {detail.source ? <p className="text-xs text-slate-500 dark:text-slate-400">{detail.labels.source}: {detail.source}</p> : null}
      </div>
      <div>
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{detail.labels.applications}</h4>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{detail.labels.applications}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.applications.map((application) => (
              <TableRow key={application.applicationId}>
                <TableCell>
                  <span className="text-sm font-medium">
                    {application.requisitionNumber} · {application.requisitionTitle}
                  </span>
                  <span className="ml-2">
                    <Badge variant="outline">{application.stageName}</Badge>
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div>
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{detail.labels.interviews}</h4>
        <div className="mt-2 space-y-3">
          {detail.interviews.map((interview) => (
            <div key={interview.id} className="rounded-md border border-slate-200 p-3 dark:border-slate-800">
              <p className="text-sm text-slate-600 dark:text-slate-300">
                {interview.kind} · {interview.scheduledAt} · {interview.status}
                {interview.outcome ? ` · ${interview.outcome}` : null}
              </p>
              {interview.status === 'scheduled' ? (
                <div className="mt-2">
                  <InterviewActionsIsland
                    interviewId={interview.id}
                    outcomes={detail.outcomeOptions}
                    labels={detail.actionLabels}
                  />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** The offer flyout body: terms plus the lifecycle actions. */
export function OfferDrawerBody({ detail }: { detail: OfferDrawerData }) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{detail.jobTitle}</h3>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {detail.compensationAmount} {detail.compensationCurrency} {detail.compensationBasis} · {detail.proposedStartOn}
        </p>
        <div className="mt-2 flex gap-1.5">
          <Badge variant="outline">{detail.status}</Badge>
          {detail.effectiveStatus !== detail.status ? <Badge variant="warning">{detail.effectiveStatus}</Badge> : null}
        </div>
        {detail.declineReason ? (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{detail.declineReason}</p>
        ) : null}
        {detail.draft ? (
          <a href={detail.draft.href} className="mt-2 inline-block text-sm font-medium text-teal-700 dark:text-teal-300">
            {detail.draft.label}
          </a>
        ) : null}
      </div>
      {detail.status === 'draft' || detail.status === 'sent' ? (
        <OfferActionsIsland offerId={detail.id} labels={detail.labels} />
      ) : null}
    </div>
  )
}

/**
 * HR-18 interview flyout: the kit (name, instructions, questions), the
 * slot rows, the viewer's own scorecard form, and the blind summary after
 * submit. Scorecard contents arrive loader-resolved through the blind
 * read — private notes never cross into another interviewer's render.
 */
export function InterviewDrawerBody({ detail }: { detail: InterviewDrawer }) {
  const { labels } = detail
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {detail.candidate} · {detail.requisition}
        </h3>
      </div>
      {detail.kit ? (
        <div>
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {labels.kit}: {detail.kit.name}
          </h4>
          {detail.kit.instructions ? (
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{detail.kit.instructions}</p>
          ) : null}
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
            {detail.kit.questions.map((question, index) => (
              <li key={index}>
                {question.question}
                {question.attribute ? <span className="text-xs text-slate-400"> · {question.attribute}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div>
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{labels.slots}</h4>
        <div className="mt-2 space-y-1.5">
          {detail.slots.map((slot) => (
            <p key={slot.id} className="text-sm text-slate-600 dark:text-slate-300">
              {slot.startsAt} — {slot.endsAt} <Badge variant="outline">{slot.kind}</Badge>
            </p>
          ))}
        </div>
        <div className="mt-3">
          <SlotProposeIsland
            interviewId={detail.id}
            pools={detail.pools}
            labels={{ submit: labels.submit ?? 'Propose slots', failed: labels.failed ?? 'Save failed.', proposeFromPool: detail.labels.proposeFromPool ?? 'Propose from pool' }}
          />
        </div>
      </div>
      <div>
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{labels.myScorecard}</h4>
        {detail.mine?.submittedAt ? (
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {labels.overall}: {detail.mine.overall} · {detail.mine.submittedAt.slice(0, 16).replace('T', ' ')}
          </p>
        ) : (
          <div className="mt-2">
            <ScorecardFormIsland
              interviewId={detail.id}
              labels={{ overall: labels.overall ?? 'Overall', submit: labels.submit ?? 'Submit', failed: labels.failed ?? 'Save failed.' }}
            />
          </div>
        )}
      </div>
      <div>
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{labels.others}</h4>
        {detail.blinded ? (
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{labels.blinded}</p>
        ) : (
          <div className="mt-2 space-y-1.5">
            {detail.others.map((other, index) => (
              <p key={index} className="text-sm text-slate-600 dark:text-slate-300">
                {other.interviewer ?? '—'} · {other.overall ?? '—'}
              </p>
            ))}
          </div>
        )}
      </div>
      {detail.summary ? (
        <div>
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{labels.summary}</h4>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {detail.summary.submittedCount}/{detail.summary.totalCount}
            {detail.summary.missing.length > 0 ? ` · ${labels.missing}: ${detail.summary.missing.join(', ')}` : null}
          </p>
        </div>
      ) : null}
    </div>
  )
}

/** HR-18 offer signature block: state chip, version history, send/void. */
export function OfferDepthBody({ offerId, extra }: { offerId: string; extra: OfferDrawerExtra }) {
  return (
    <div className="mt-6 border-t border-slate-200 pt-4 dark:border-slate-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{extra.labels.signature}</span>
        <Badge variant={extra.signatureVariant}>{extra.signature}</Badge>
      </div>
      <h4 className="mt-3 text-sm font-semibold text-slate-900 dark:text-slate-100">{extra.labels.versions}</h4>
      <ul className="mt-1 space-y-1 text-sm text-slate-600 dark:text-slate-300">
        {extra.versions.map((version) => (
          <li key={version.version}>
            v{version.version} · {version.createdAt.slice(0, 16).replace('T', ' ')}
          </li>
        ))}
      </ul>
      <div className="mt-3">
        <OfferSigningIsland
          offerId={offerId}
          labels={{ sendLink: extra.labels.sendLink ?? 'Send signing link', void: extra.labels.void ?? 'Void', failed: extra.labels.failed ?? 'Save failed.' }}
        />
      </div>
    </div>
  )
}

/** HR-18 posting flyout: board state, publish controls, disposition log. */
export function PostingDrawerBody({
  posting,
  extra,
}: {
  posting: { id: string; boardKey: string; status: string; requisitionId: string };
  extra: PostingDrawerExtra;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{posting.boardKey}</h3>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{posting.status}</p>
      </div>
      <PostingActionsIsland
        postingId={posting.id}
        status={posting.status}
        labels={{ publish: extra.labels.publish ?? 'Publish', pause: extra.labels.pause ?? 'Pause', close: extra.labels.close ?? 'Close', failed: extra.labels.failed ?? 'Save failed.' }}
      />
      <div>
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{extra.labels.events}</h4>
        <ul className="mt-2 space-y-1 text-sm text-slate-600 dark:text-slate-300">
          {extra.events.map((event, index) => (
            <li key={index}>
              {event.kind} · {event.recordedAt}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** HR-18 pool flyout: members plus match-to-opening. */
export function PoolDrawerBody({ detail }: { detail: PoolDrawer }) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{detail.name}</h3>
      </div>
      <div>
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{detail.labels.members}</h4>
        <div className="mt-2 space-y-2">
          {detail.members.map((member) => (
            <div key={member.candidateId} className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 p-2.5 dark:border-slate-800">
              <span className="text-sm font-medium">{member.displayName}</span>
              {member.tags.map((tag) => (
                <Badge key={tag} variant="outline">{tag}</Badge>
              ))}
              <PoolMemberRemoveIsland poolId={detail.id} candidateId={member.candidateId} labels={{ remove: detail.labels.remove ?? 'Remove', failed: detail.labels.failed ?? 'Save failed.' }} />
            </div>
          ))}
        </div>
      </div>
      <div>
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{detail.labels.match}</h4>
        <div className="mt-2">
          <PoolRediscoverIsland poolId={detail.id} labels={{ tags: detail.labels.tags ?? 'Tags (comma separated)', failed: detail.labels.failed ?? 'Save failed.' }} />
        </div>
      </div>
    </div>
  )
}

/** HR-18 consent block for the candidate flyout: grants, expiries, retention date. */
export function ConsentBody({ consents }: { consents: ConsentStatus }) {
  return (
    <div className="mt-6 border-t border-slate-200 pt-4 dark:border-slate-800">
      <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{consents.labels.title}</h4>
      {consents.earliestExpiry ? (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {consents.labels.retentionDate}: {consents.earliestExpiry}
        </p>
      ) : null}
      <ul className="mt-2 space-y-1 text-sm text-slate-600 dark:text-slate-300">
        {consents.consents.map((consent, index) => (
          <li key={index}>
            {consent.purpose} · {consent.grantedAt}
            {consent.expiresAt ? ` → ${consent.expiresAt}` : null}
            {consent.withdrawnAt ? ` · withdrawn ${consent.withdrawnAt}` : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The recruiting flyout shell: a URL drawer around one of the bodies (or
 * the create form), closing by navigation. Null payload renders
 * nothing — the spec's `when` gate already omits it, so this is the second
 * half of the same guard.
 */
export function RecruitingDrawer({
  drawer,
}: {
  drawer: RecruitingPageData['drawer']
}) {
  if (!drawer) return null
  return (
    <UrlDrawer open closeHref={drawer.closeHref} title={drawer.title} description={drawer.description ?? undefined}>
      {drawer.create ? (
        <RecruitingCreateForm {...drawer.create} />
      ) : drawer.requisition ? (
        <RequisitionDrawerBody detail={drawer.requisition} />
      ) : drawer.candidate ? (
        <>
          <CandidateDrawerBody detail={drawer.candidate} />
          {drawer.consents ? <ConsentBody consents={drawer.consents} /> : null}
        </>
      ) : drawer.offer ? (
        <>
          <OfferDrawerBody detail={drawer.offer} />
          {drawer.offerExtra ? <OfferDepthBody offerId={drawer.offer.id} extra={drawer.offerExtra} /> : null}
        </>
      ) : drawer.interview ? (
        <InterviewDrawerBody detail={drawer.interview} />
      ) : drawer.postingExtra ? (
        <PostingDrawerBody posting={drawer.postingExtra.posting} extra={drawer.postingExtra} />
      ) : drawer.pool ? (
        <PoolDrawerBody detail={drawer.pool} />
      ) : drawer.missingDetail ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{drawer.missingDetail}</p>
      ) : null}
    </UrlDrawer>
  )
}
