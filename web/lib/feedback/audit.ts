import 'server-only'

import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import type {
  FeedbackTurnResult,
  IssueDraft,
  IssuePublisher,
  PublishedIssue,
} from '@braedonsaunders/appkit-feedback'
import type { FeedbackSettingsView } from './config'

/**
 * Audit evidence for the in-app issue reporter.
 *
 * Two material events are recorded, and both go to `audit_log` rather than
 * anywhere new — the company log is the one immutable evidence trail here.
 *
 *   • an operator changed where reports go (a security-relevant destination
 *     and credential change);
 *   • a report was filed out of the deployment (tenant text left the
 *     installation, generalized, and became a public issue).
 */

/**
 * The stable `row_id` for the installation's settings singleton.
 *
 * `audit_log.row_id` is a uuid and `platform_settings.id` is the text
 * 'platform', so the singleton needs one fixed synthetic id — fixed rather
 * than per-write so the whole history of the destination is one query. The
 * value is deliberately recognizable: it ends in the migration that
 * introduced the table (0173).
 */
export const PLATFORM_SETTINGS_AUDIT_ROW_ID = '00000000-0000-7000-8000-000000000173'

/**
 * Record an operator's change to the destination.
 *
 * `audit_log` is organization-scoped by construction, and an installation
 * setting has no organization — so, exactly like the cross-organization
 * access mutations in the platform console, the record lands in the acting
 * operator's own organization carrying `source: 'platform_admin'`. The
 * before/after pair holds the destination and whether a credential exists;
 * it never holds a token, sealed or otherwise.
 */
export async function recordFeedbackSettingsAudit(input: {
  orgId: string
  actorId: string
  before: FeedbackSettingsView
  after: FeedbackSettingsView
  reason: string
}): Promise<void> {
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (
      ${input.orgId},
      'platform_settings',
      ${PLATFORM_SETTINGS_AUDIT_ROW_ID},
      'update',
      ${JSON.stringify({
        source: 'platform_admin',
        area: 'feedback',
        reason: input.reason,
        before: redact(input.before),
        after: redact(input.after),
      })}::jsonb,
      ${input.actorId}
    )`)
}

/** The destination as evidence may hold it: existence of a credential, never one. */
function redact(view: FeedbackSettingsView) {
  return {
    enabled: view.enabled,
    owner: view.owner,
    repo: view.repo,
    labels: view.labels,
    searchDuplicates: view.searchDuplicates,
    hasToken: view.hasToken,
  }
}

/**
 * Record that a report left the installation.
 *
 * `stripped` is the package's own list of what redaction removed before the
 * issue was published — keeping it is the evidence that generalization ran,
 * which is the claim the reporter makes to the person using it. The report
 * text itself is deliberately NOT copied here: the filed issue is the
 * record, and duplicating a person's words into the company log would give
 * the reader one more place to be quoted from.
 */
/**
 * Durable filing intent: written in the tenant transaction BEFORE the report
 * leaves the deployment, so a tenant report is never publicly filed without a
 * local event identifying the actor, the destination, and exactly what was
 * about to be published.
 *
 * `audit_log` is append-only, so the intent and its completion are two rows
 * sharing one `row_id` (the report id): the intent carries `status:
 * 'file-intent'`, the completion carries `status: 'filed'` with the issue id.
 * An intent with no filed sibling is pending reconciliation — never a silent
 * success.
 */
export type FeedbackFileIntent = {
  orgId: string
  actorId: string
  reportId: string
  owner: string
  repo: string
  payloadHash: string
  pathname: string
}

export async function recordFeedbackFileIntent(input: FeedbackFileIntent): Promise<void> {
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (
      ${input.orgId},
      'feedback_report',
      ${input.reportId},
      'insert',
      ${JSON.stringify({
        source: 'feedback_reporter',
        status: 'file-intent',
        destination: { owner: input.owner, repo: input.repo },
        payloadHash: input.payloadHash,
        pathname: input.pathname,
      })}::jsonb,
      ${input.actorId}
    )`)
}

/**
 * Bind an intent to the exact bytes about to leave. Labels are deliberately
 * excluded: the publisher appends the operator's default labels and may retry
 * with labels stripped, but title and body reach GitHub byte-identical — so a
 * title+body hash still matches the created issue at reconciliation time.
 */
export function feedbackPayloadHash(draft: Pick<IssueDraft, 'title' | 'body'> & { labels?: unknown }): string {
  return createHash('sha256')
    .update(JSON.stringify({ title: draft.title, body: draft.body }), 'utf8')
    .digest('hex')
}

/**
 * Named refusal for an intent that could not be written. The report must NOT
 * be published when this is thrown: there would be no durable local event for
 * a public filing. The message names the remedy (retry; nothing left the
 * deployment) because the reporter acts on it.
 */
export class FeedbackFilingRefusedError extends Error {
  override name = 'FeedbackFilingRefusedError'
}

export function feedbackFilingRefusedMessage(): string {
  return (
    'The report was not filed because the filing receipt could not be recorded. ' +
    'Try again in a moment — nothing left the deployment.'
  )
}

/**
 * Truthful user result for a report that IS public but whose completion row
 * failed to write. The issue link is included so the reporter is not harmed;
 * "do not re-file" is explicit so a retry does not create a duplicate.
 */
export function feedbackAuditPendingMessage(issue: Pick<PublishedIssue, 'number' | 'url'>): string {
  return (
    `Your report was filed as issue #${issue.number} (${issue.url}), but saving the ` +
    'audit evidence failed. Do not re-file — operators have been alerted and the ' +
    'filing receipt will be reconciled.'
  )
}

/**
 * Publish through an intent: the intent row lands first, and only then does
 * the wrapped publisher file the issue.
 *
 * Two loss shapes the package forces on us: the scripted client swallows every
 * publisher throw into a generic "unavailable", and the AI tool path keeps the
 * message but drops the type. So the refusal is ALSO stashed on
 * `ctx.refusal` — the route reads it after `send` resolves and raises the
 * named 503 itself, instead of trusting the package to carry it.
 */
export function createIntentFirstPublisher(
  inner: IssuePublisher,
  ctx: {
    orgId: string
    actorId: string
    reportId: string
    owner: string
    repo: string
    pathname: string
    refusal: { error: FeedbackFilingRefusedError | null }
  },
  deps?: { recordIntent?: (intent: FeedbackFileIntent) => Promise<void> },
): IssuePublisher {
  const recordIntent = deps?.recordIntent ?? recordFeedbackFileIntent
  const wrapped: IssuePublisher = {
    create: async (draft) => {
      const payloadHash = feedbackPayloadHash(draft)
      try {
        await recordIntent({
          orgId: ctx.orgId,
          actorId: ctx.actorId,
          reportId: ctx.reportId,
          owner: ctx.owner,
          repo: ctx.repo,
          payloadHash,
          pathname: ctx.pathname,
        })
      } catch (error) {
        // Loud here as well as in the route: this is the moment a public
        // filing was prevented, and the cause belongs in the deployment log.
        console.error('[feedback/turn] refusing to publish without a filing intent', error)
        const refused = new FeedbackFilingRefusedError(feedbackFilingRefusedMessage(), {
          cause: error,
        })
        ctx.refusal.error = refused
        throw refused
      }
      return inner.create(draft)
    },
  }
  if (inner.searchOpen) {
    const searchOpen = inner.searchOpen.bind(inner)
    wrapped.searchOpen = searchOpen
  }
  return wrapped
}

/** One issue as the reconciler sees it (title/body byte-identical to the draft). */
export type FeedbackIssueSnapshot = {
  number: number
  url: string
  title: string
  body: string
}

type PendingFeedbackIntent = {
  reportId: string
  actorId: string | null
  pathname: string
  payloadHash: string
}

async function pendingFeedbackIntents(orgId: string): Promise<PendingFeedbackIntent[]> {
  const rows = await db.execute<{
    reportId: string
    actorId: string | null
    pathname: string
    payloadHash: string
  }>(sql`
    select
      intent.row_id as "reportId",
      intent.actor_id as "actorId",
      coalesce(intent.changes ->> 'pathname', '/') as "pathname",
      intent.changes ->> 'payloadHash' as "payloadHash"
    from audit_log as intent
    where intent.org_id = ${orgId}
      and intent.table_name = 'feedback_report'
      and intent.changes ->> 'status' = 'file-intent'
      and not exists (
        select 1
        from audit_log as done
        where done.org_id = intent.org_id
          and done.table_name = 'feedback_report'
          and done.row_id = intent.row_id
          and done.changes ->> 'status' = 'filed'
      )
  `)
  return rows.rows.filter((row) => typeof row.payloadHash === 'string' && row.payloadHash)
}

/**
 * Complete filings whose completion row never landed. Each pending intent is
 * matched against recently filed issues by payload hash; a match records the
 * issue id against the intent (marked reconciled), a miss stays pending for
 * the next run. Never invents an issue id: only an observed destination issue
 * closes an intent.
 */
export async function reconcileFeedbackFiledAudits(input: {
  orgId: string
  listIssues: () => Promise<FeedbackIssueSnapshot[]>
}): Promise<{ reconciled: string[]; stillPending: string[] }> {
  const pending = await pendingFeedbackIntents(input.orgId)
  if (pending.length === 0) return { reconciled: [], stillPending: [] }
  const issues = await input.listIssues()
  const byHash = new Map<string, FeedbackIssueSnapshot>()
  for (const issue of issues) {
    const hash = feedbackPayloadHash({ title: issue.title, body: issue.body })
    if (!byHash.has(hash)) byHash.set(hash, issue)
  }
  const reconciled: string[] = []
  const stillPending: string[] = []
  for (const intent of pending) {
    const issue = byHash.get(intent.payloadHash)
    if (!issue) {
      stillPending.push(intent.reportId)
      continue
    }
    await recordFeedbackFiledAudit({
      orgId: input.orgId,
      actorId: intent.actorId,
      reportId: intent.reportId,
      result: {
        kind: 'filed',
        issue: { id: String(issue.number), number: issue.number, url: issue.url, title: issue.title },
        stripped: [],
      },
      pathname: intent.pathname,
      reconciled: true,
    })
    reconciled.push(intent.reportId)
  }
  return { reconciled, stillPending }
}

export async function recordFeedbackFiledAudit(input: {
  orgId: string
  actorId: string | null
  reportId: string
  result: Extract<FeedbackTurnResult, { kind: 'filed' }>
  pathname: string
  /** Set when this row is written by reconciliation rather than the turn itself. */
  reconciled?: boolean
}): Promise<void> {
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (
      ${input.orgId},
      'feedback_report',
      ${input.reportId},
      'insert',
      ${JSON.stringify({
        source: 'feedback_reporter',
        status: 'filed',
        ...(input.reconciled ? { reconciled: true } : {}),
        issue: {
          number: input.result.issue.number,
          url: input.result.issue.url,
          title: input.result.issue.title,
        },
        pathname: input.pathname,
        stripped: input.result.stripped,
      })}::jsonb,
      ${input.actorId}
    )`)
}

