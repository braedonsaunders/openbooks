import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../../platform/db.ts";
import { featureEnabled } from "../../organization/feature-registry.ts";
import { RecruitingError } from "./errors.ts";

/**
 * Shared depth-layer helpers (HR-18, 0229).
 *
 * - requireDepthFeature: every new write/read entry point refuses BY NAME
 *   naming Company Settings → Features when its sub-feature is off. The
 *   API/page layer 404s as well; this is the service-level refusal so a
 *   caller that reaches past the page still gets the remedy, never silent
 *   behavior or a zero.
 * - notifyUsers: writes the notifications table with the SAME columns as
 *   the shared writeNotification path (engine/src/inbox/adapters/
 *   notification.ts) — org, user, kind, title, body, href, audit pair —
 *   so depth alerts surface in /notifications AND as inbox items with zero
 *   extra plumbing. It is inline SQL, not an import: inbox depends on hrm,
 *   so importing it here would grow the pinned dependency cycle the
 *   boundary check refuses. Column parity with writeNotification is the
 *   contract; a drift between the two is a bug in this file.
 * - enqueueRecruitingEmail: reaches the shared BullMQ producer lazily with
 *   an injectable enqueuer for tests (the scheduling/outbox.ts precedent),
 *   so scan-only and unit-test callers never load Redis.
 */

export const DEPTH_FEATURE_KEYS = [
  "hrmRecruiting",
  "hrmStructuredInterviews",
  "hrmInterviewScheduling",
  "hrmOfferSigning",
  "hrmJobBoards",
  "hrmCandidateRetention",
  "hrmTalentPool",
] as const;

export type DepthFeatureKey = (typeof DEPTH_FEATURE_KEYS)[number];

const FEATURE_LABEL: Record<DepthFeatureKey, string> = {
  hrmRecruiting: "Recruiting",
  hrmStructuredInterviews: "Structured interviews",
  hrmInterviewScheduling: "Interview scheduling",
  hrmOfferSigning: "Offer signing",
  hrmJobBoards: "Job boards",
  hrmCandidateRetention: "Candidate retention",
  hrmTalentPool: "Talent pool",
};

export async function loadFeatureState(
  exec: SqlExecutor,
  orgId: string,
): Promise<Record<string, boolean>> {
  const row = (await exec.execute<{ features: Record<string, boolean> | null }>(sql`
    select settings->'features' as features from orgs where id = ${orgId}
  `)).rows[0];
  return row?.features ?? {};
}

/** Refuse by name when the sub-feature (or its hrmRecruiting parent) is off. */
export async function requireDepthFeature(
  exec: SqlExecutor,
  orgId: string,
  key: DepthFeatureKey,
): Promise<void> {
  const state = await loadFeatureState(exec, orgId);
  if (!featureEnabled(state, key)) {
    throw new RecruitingError(
      "REFUSED",
      `${FEATURE_LABEL[key]} is off — turn it on in Company Settings → Features to use this surface; nothing was written`,
    );
  }
}

export interface DepthNotice {
  readonly userId: string;
  readonly kind: string;
  readonly title: string;
  readonly body?: string | null;
  readonly href?: string | null;
}

/**
 * Write notification rows through the shared table with the shared
 * columns. Zero written rows is a failure, never success.
 */
export async function notifyUsers(
  exec: SqlExecutor,
  args: { orgId: string; actorId: string | null; notices: readonly DepthNotice[] },
): Promise<void> {
  for (const notice of args.notices) {
    const id = (await exec.execute<{ id: string }>(sql`
      insert into notifications (org_id, user_id, kind, title, body, href, created_by, updated_by)
      values (${args.orgId}, ${notice.userId}, ${notice.kind}, ${notice.title},
              ${notice.body ?? null}, ${notice.href ?? null},
              ${args.actorId}, ${args.actorId})
      returning id
    `)).rows[0]?.id;
    if (!id) {
      throw new RecruitingError(
        "REFUSED",
        "the notice was not stored — no row was written; retry the action",
      );
    }
  }
}

/** Resolve user ids holding the given employee parties (panel → notices). */
export async function userIdsForParties(
  exec: SqlExecutor,
  orgId: string,
  partyIds: readonly string[],
): Promise<string[]> {
  if (partyIds.length === 0) return [];
  const rows = (await exec.execute<{ id: string }>(sql`
    select id from users where org_id = ${orgId} and party_id = any(${pgUuidArray(partyIds)}::uuid[])
  `)).rows;
  return rows.map((row) => row.id);
}

export interface RecruitingEmailData {
  readonly orgId: string;
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export type RecruitingEmailEnqueuer = (
  data: RecruitingEmailData,
  options: { jobId: string },
) => Promise<unknown>;

/** Reach the shared BullMQ email producer lazily so unit tests never load it. */
export async function enqueueRecruitingEmailJob(
  data: RecruitingEmailData,
  options: { jobId: string },
): Promise<unknown> {
  const { enqueueEmail } = await import("@openbooks/jobs");
  return enqueueEmail(
    {
      orgId: data.orgId,
      to: data.to,
      subject: data.subject,
      html: data.html,
      text: data.text,
    },
    options,
  );
}

/**
 * Bind a string list as ONE pg-array param. Drizzle expands raw JS arrays
 * into row constructors (never PostgreSQL arrays), so the house pattern
 * builds the `{a,b}` literal and casts at the placeholder (the
 * organization/subsidiaries.ts uuidArray precedent).
 */
export function pgUuidArray(ids: readonly string[]): string {
  for (const [index, id] of ids.entries()) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new RecruitingError("INVALID_INPUT", `array element ${index + 1} is not a valid UUID — pass ids, not names`);
    }
  }
  return `{${ids.join(",")}}`;
}

/** Text-array literal with pg quoting (tags may carry commas or quotes). */
export function pgTextArray(values: readonly string[]): string {
  return `{${values.map((value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
