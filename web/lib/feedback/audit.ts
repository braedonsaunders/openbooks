import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import type { FeedbackTurnResult } from '@braedonsaunders/appkit-feedback'
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
export async function recordFeedbackFiledAudit(input: {
  orgId: string
  actorId: string
  reportId: string
  result: Extract<FeedbackTurnResult, { kind: 'filed' }>
  pathname: string
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
