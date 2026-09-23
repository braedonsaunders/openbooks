import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { actorHasPermission } from "../../organization/actor-permissions.ts";
import { businessToday } from "../../platform/business-date.ts";
import {
  loadApprovalPerson,
  loadManagedEmploymentIds,
  requireAggregatePerformanceManage,
  requireAggregatePerformanceRead,
} from "../authorization.ts";
import { HRM_FEATURE_KEY } from "../employment-read.ts";
import { HrmPerformanceError } from "./errors.ts";
import { HRM_PERFORMANCE_CONTINUOUS_KEY } from "./one-on-ones.ts";

/**
 * Governed HRM continuous feedback (0228, HR-17): praise, feedback,
 * requests, and retractions.
 *
 * Feedback rows are append-only evidence (the refuse-update trigger in
 * 0228): a retraction is a NEW row of kind retraction linking the
 * original, and reads hide both. Every conditional write asserts its
 * affected row count.
 *
 * Visibility matrix (enforced in every read below, never in the UI):
 * - public (praise only): everyone in the org.
 * - manager_and_subject: the subject, the subject's line manager, HR.
 * - manager_only: the subject's line manager and HR — never the subject.
 * - subject_only: the subject and HR — never the manager.
 * The author always reads their own rows. A subject reading
 * manager_only feedback gets NOT_FOUND uniformly, so the row's
 * existence cannot be probed.
 *
 * Requests (kind request) name the requested party; writing one also
 * writes a notice row through the shared notifications columns (the same
 * columns engine/src/inbox/adapters/notification.ts writes — the hrm
 * module cannot import the inbox module, so the insert is inline here
 * with identical columns) for every user behind that party, and register
 * the hrm_feedback_request inbox adapter over the request rows.
 *
 * Do not touch packages/payroll. Existing refusal classes are untouched.
 */

export const HRM_FEEDBACK_KEY = "hrmFeedback" as const;

export type PublicPraiseBy = "anyone" | "managers_and_hr";

export interface FeedbackSettings {
  readonly publicPraiseBy: PublicPraiseBy;
}

export const DEFAULT_FEEDBACK_SETTINGS: FeedbackSettings = { publicPraiseBy: "anyone" };

/**
 * Feedback settings (who may praise publicly): stored on the org row
 * beside the feature switches, edited on /hrm/performance by HR, and
 * enforced in writeFeedback below — never UI-only.
 */
export async function getFeedbackSettings(args: { orgId: string; actorId: string }): Promise<FeedbackSettings> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertFeedbackFeature(db, orgId);
    if (!(await hasPerformanceManage(db, orgId, actorId))) {
      throw new HrmPerformanceError(
        "FORBIDDEN",
        "feedback settings are HR-owned — ask an administrator to grant hrm.performance.manage in /admin/roles",
      );
    }
    const row = (await db.execute<{ settings: unknown }>(sql`
      select settings from orgs where id = ${orgId}
    `)).rows[0];
    const stored = ((row?.settings ?? {}) as { hrm_feedback?: unknown }).hrm_feedback;
    if (stored !== null && typeof stored === "object" && !Array.isArray(stored)) {
      const by = (stored as { public_praise_by?: unknown }).public_praise_by;
      if (by === "managers_and_hr") return { publicPraiseBy: "managers_and_hr" };
    }
    return DEFAULT_FEEDBACK_SETTINGS;
  });
}

export async function setFeedbackSettings(args: {
  orgId: string;
  actorId: string;
  publicPraiseBy: PublicPraiseBy;
}): Promise<FeedbackSettings> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  if (!["anyone", "managers_and_hr"].includes(args.publicPraiseBy)) {
    throw new HrmPerformanceError("INVALID_INPUT", "public praise may be opened to anyone or limited to managers_and_hr");
  }
  return withOrgTransaction(orgId, async () => {
    await assertFeedbackFeature(db, orgId);
    if (!(await hasPerformanceManage(db, orgId, actorId))) {
      throw new HrmPerformanceError(
        "FORBIDDEN",
        "feedback settings are HR-owned — ask an administrator to grant hrm.performance.manage in /admin/roles",
      );
    }
    const updated = (await db.execute<{ id: string }>(sql`
      update orgs
         set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({ hrm_feedback: { public_praise_by: args.publicPraiseBy } })}::jsonb
       where id = ${orgId}
      returning id
    `)).rows;
    if (updated.length !== 1) {
      throw new HrmPerformanceError("NOT_FOUND", "organization was not found — settings cannot be stored without it");
    }
    return { publicPraiseBy: args.publicPraiseBy };
  });
}

async function readFeedbackSettings(db: SqlExecutor, orgId: string): Promise<FeedbackSettings> {
  const row = (await db.execute<{ settings: unknown }>(sql`
    select settings from orgs where id = ${orgId}
  `)).rows[0];
  const stored = ((row?.settings ?? {}) as { hrm_feedback?: unknown }).hrm_feedback;
  if (stored !== null && typeof stored === "object" && !Array.isArray(stored)) {
    const by = (stored as { public_praise_by?: unknown }).public_praise_by;
    if (by === "managers_and_hr") return { publicPraiseBy: "managers_and_hr" };
  }
  return DEFAULT_FEEDBACK_SETTINGS;
}

export type FeedbackKind = "praise" | "feedback" | "request" | "retraction";
export type FeedbackVisibility = "public" | "manager_and_subject" | "manager_only" | "subject_only";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function requireId(field: string, value: unknown): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new HrmPerformanceError("INVALID_INPUT", `${field} must be a uuid`);
  }
  return value;
}

/**
 * The one probe for the feedback surface: every feature key the service
 * asserts, in one place. Readers (like the inbox leg) call this BEFORE
 * touching the service and list nothing when any key is off; the
 * assertion below funnels through it too, so the probe and the refusal
 * can never drift apart when a key is added or removed.
 */
export async function feedbackFeatureEnabled(db: SqlExecutor, orgId: string): Promise<boolean> {
  if (!(await lockAndCheckOrgFeature(db, orgId, HRM_FEATURE_KEY))) return false;
  if (!(await lockAndCheckOrgFeature(db, orgId, HRM_PERFORMANCE_CONTINUOUS_KEY))) return false;
  return lockAndCheckOrgFeature(db, orgId, HRM_FEEDBACK_KEY);
}

async function assertFeedbackFeature(db: SqlExecutor, orgId: string): Promise<void> {
  if (await feedbackFeatureEnabled(db, orgId)) return;
  // Name the missing switch so the operator knows what to flip. The probe
  // above is the authority on which keys matter; these messages only label
  // the first one found off.
  if (!(await lockAndCheckOrgFeature(db, orgId, HRM_FEATURE_KEY))) {
    throw new HrmPerformanceError(
      "FEATURE_OFF",
      "hrm feature is disabled: enable it on Company Settings → Features before writing feedback",
    );
  }
  if (!(await lockAndCheckOrgFeature(db, orgId, HRM_PERFORMANCE_CONTINUOUS_KEY))) {
    throw new HrmPerformanceError(
      "FEATURE_OFF",
      "hrmPerformance feature is disabled: enable it on Company Settings → Features before writing feedback",
    );
  }
  throw new HrmPerformanceError(
    "FEATURE_OFF",
    "hrmFeedback feature is disabled: enable it on Company Settings → Features before writing feedback",
  );
}

/**
 * The actor's HR read scope for feedback visibility: the allowed employer
 * set (null = unrestricted), or undefined when the actor holds no HR read
 * grant at all. A legal-entity-restricted HR reads only the feedback whose
 * subject sits inside their scope — never the whole org.
 */
async function performanceReadScope(
  db: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<Set<string> | null | undefined> {
  try {
    return await requireAggregatePerformanceRead(db, orgId, actorId);
  } catch {
    return undefined;
  }
}

async function hasPerformanceManage(db: SqlExecutor, orgId: string, actorId: string): Promise<boolean> {
  try {
    await requireAggregatePerformanceManage(db, orgId, actorId);
    return true;
  } catch {
    return false;
  }
}

export interface FeedbackDTO {
  readonly id: string;
  readonly subjectEmploymentId: string;
  readonly subjectName: string;
  readonly authorPartyId: string;
  readonly kind: Exclude<FeedbackKind, "retraction">;
  readonly visibility: FeedbackVisibility;
  readonly body: string;
  readonly context: Record<string, unknown>;
  readonly requestedFromPartyId: string | null;
  readonly recordedAt: string;
}

type StoredFeedback = {
  id: string;
  subject_employment_id: string;
  subject_party_id: string | null;
  subject_employer_subsidiary_id: string | null;
  subject_name: string;
  author_party_id: string;
  kind: FeedbackKind;
  visibility: FeedbackVisibility;
  body: string;
  context: unknown;
  requested_from_party_id: string | null;
  retracts_feedback_id: string | null;
  recorded_at: string;
};

async function subjectParty(db: SqlExecutor, orgId: string, employmentId: string): Promise<string | null> {
  const rows = (await db.execute<{ worker_party_id: string | null }>(sql`
    select worker_party_id from worker_employments where org_id = ${orgId} and id = ${employmentId}
  `)).rows;
  return rows[0]?.worker_party_id ?? null;
}

async function isManagerOf(
  db: SqlExecutor,
  orgId: string,
  actorId: string,
  subjectEmploymentId: string,
): Promise<boolean> {
  if (!(await actorHasPermission(db, orgId, actorId, "hrm.self.read"))) return false;
  const today = await businessToday(orgId);
  const team = await loadManagedEmploymentIds(db, orgId, actorId, today);
  return team.includes(subjectEmploymentId);
}

/**
 * The praise visibility matrix as a pure predicate over trusted inputs:
 * author party, subject party, the actor's party, whether the actor
 * manages the subject, and the HR grant. Pure so the matrix is unit
 * testable without a database — the service feeds it trusted DB-loaded
 * values, never caller input.
 */
export function feedbackVisibleTo(args: {
  visibility: FeedbackVisibility;
  authorPartyId: string;
  subjectPartyId: string | null;
  actorPartyId: string | null;
  actorManagesSubject: boolean;
  actorHasHrGrant: boolean;
}): boolean {
  if (args.actorHasHrGrant) return true;
  if (args.actorPartyId !== null && args.actorPartyId === args.authorPartyId) return true;
  const isSubject = args.actorPartyId !== null && args.subjectPartyId !== null && args.actorPartyId === args.subjectPartyId;
  switch (args.visibility) {
    case "public":
      return true;
    case "manager_and_subject":
      return isSubject || args.actorManagesSubject;
    case "manager_only":
      return args.actorManagesSubject;
    case "subject_only":
      return isSubject;
  }
}

async function toDTO(
  db: SqlExecutor,
  orgId: string,
  actorId: string,
  row: StoredFeedback,
): Promise<FeedbackDTO | null> {
  const scope = await performanceReadScope(db, orgId, actorId);
  // The HR grant widens visibility only inside the actor's legal-entity
  // scope: unrestricted HR reads everything, a restricted HR reads the
  // subjects they cover, and anyone else reads through authorship or the
  // subject/manager matrix below.
  const hr =
    scope !== undefined &&
    (scope === null ||
      (row.subject_employer_subsidiary_id !== null && scope.has(row.subject_employer_subsidiary_id)));
  const person = await loadApprovalPerson(db, orgId, actorId);
  const manages = await isManagerOf(db, orgId, actorId, row.subject_employment_id);
  if (
    !feedbackVisibleTo({
      visibility: row.visibility,
      authorPartyId: row.author_party_id,
      subjectPartyId: row.subject_party_id,
      actorPartyId: person.partyId,
      actorManagesSubject: manages,
      actorHasHrGrant: hr,
    })
  ) {
    return null;
  }
  if (row.kind === "retraction") return null;
  return {
    id: row.id,
    subjectEmploymentId: row.subject_employment_id,
    subjectName: row.subject_name,
    authorPartyId: row.author_party_id,
    kind: row.kind,
    visibility: row.visibility,
    body: row.body,
    context: (row.context ?? {}) as Record<string, unknown>,
    requestedFromPartyId: row.requested_from_party_id,
    recordedAt: row.recorded_at,
  };
}

async function retractedIds(db: SqlExecutor, orgId: string): Promise<Set<string>> {
  const rows = (await db.execute<{ id: string }>(sql`
    select retracts_feedback_id as id from hrm_feedback
     where org_id = ${orgId} and kind = 'retraction' and retracts_feedback_id is not null
  `)).rows;
  return new Set(rows.map((row) => row.id));
}

export async function writeFeedback(args: {
  orgId: string;
  actorId: string;
  subjectEmploymentId: string;
  kind: Exclude<FeedbackKind, "retraction">;
  visibility: FeedbackVisibility;
  body: string;
  context?: Record<string, unknown> | null;
  requestedFromPartyId?: string | null;
}): Promise<FeedbackDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const subjectEmploymentId = requireId("subjectEmploymentId", args.subjectEmploymentId);
  if (!["praise", "feedback", "request"].includes(args.kind)) {
    throw new HrmPerformanceError("INVALID_INPUT", "feedback kind must be praise, feedback, or request");
  }
  if (!["public", "manager_and_subject", "manager_only", "subject_only"].includes(args.visibility)) {
    throw new HrmPerformanceError("INVALID_INPUT", "visibility must be public, manager_and_subject, manager_only, or subject_only");
  }
  if (args.kind === "praise" && args.visibility !== "public" && args.visibility !== "manager_and_subject" && args.visibility !== "subject_only") {
    throw new HrmPerformanceError("INVALID_INPUT", "praise is celebratory — it cannot be manager_only; write it as feedback instead");
  }
  if (args.visibility === "public" && args.kind !== "praise") {
    throw new HrmPerformanceError(
      "INVALID_INPUT",
      "only praise may be public — constructive feedback stays between the manager, the subject, or both",
    );
  }
  if (typeof args.body !== "string" || args.body.trim().length === 0) {
    throw new HrmPerformanceError("INVALID_INPUT", "feedback needs a body — say what happened, specifically");
  }
  if (args.kind === "request" && !args.requestedFromPartyId) {
    throw new HrmPerformanceError("INVALID_INPUT", "a feedback request must name the party it is requested from");
  }
  return withOrgTransaction(orgId, async () => {
    await assertFeedbackFeature(db, orgId);
    const person = await loadApprovalPerson(db, orgId, actorId);
    if (!person.partyId) {
      throw new HrmPerformanceError("FORBIDDEN", "your user has no person identity in this organization — ask an administrator to link it before writing feedback");
    }
    // Any employee with self read (or HR) may write; the subject must exist.
    if (!(await hasPerformanceManage(db, orgId, actorId))) {
      if (!(await actorHasPermission(db, orgId, actorId, "hrm.self.read"))) {
        throw new HrmPerformanceError(
          "FORBIDDEN",
          "writing feedback needs hrm.self.read — ask an administrator to grant it in /admin/roles",
        );
      }
    }
    const party = await subjectParty(db, orgId, subjectEmploymentId);
    if (!party) {
      throw new HrmPerformanceError(
        "NOT_FOUND",
        "subject employment was not found in this organization — pick the person from the directory",
      );
    }
    // Feedback settings are enforced at the service boundary: while
    // public praise is limited to managers and HR, anyone else's public
    // praise is refused by name (never silently downgraded).
    if (args.kind === "praise" && args.visibility === "public") {
      const settings = await readFeedbackSettings(db, orgId);
      if (settings.publicPraiseBy === "managers_and_hr" && !(await hasPerformanceManage(db, orgId, actorId))) {
        const manages = await isManagerOf(db, orgId, actorId, subjectEmploymentId);
        if (!manages) {
          throw new HrmPerformanceError(
            "FORBIDDEN",
            "public praise is limited to managers and HR in feedback settings — share it as manager_and_subject instead",
          );
        }
      }
    }
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into hrm_feedback (org_id, subject_employment_id, author_party_id, kind, visibility, body, context, requested_from_party_id, created_by)
      values (${orgId}, ${subjectEmploymentId}, ${person.partyId}, ${args.kind}, ${args.visibility},
              ${args.body.trim()}, ${JSON.stringify(args.context ?? {})}::jsonb,
              ${args.kind === "request" ? args.requestedFromPartyId : null}, ${actorId})
      returning id
    `)).rows[0];
    if (!inserted) throw new HrmPerformanceError("REFUSED", "the feedback was not stored — no row was written; retry the action");
    if (args.kind === "request" && args.requestedFromPartyId) {
      // A request creates a notice for the requested party through the
      // shared notifications columns (same columns writeNotification
      // writes — inline here because the hrm module cannot import the
      // inbox module). The request row itself is the durable artifact;
      // users resolve from the live users table, never caller input.
      const users = (await db.execute<{ id: string }>(sql`
        select id from users where org_id = ${orgId} and party_id = ${args.requestedFromPartyId}
      `)).rows;
      for (const user of users) {
        await db.execute(sql`
          insert into notifications (org_id, user_id, kind, title, body, href, created_by, updated_by)
          values (${orgId}, ${user.id}, 'hrm_feedback_request',
                  'Feedback requested',
                  ${`A colleague asked for your feedback — respond from your 1:1s and feedback surface.`},
                  '/me/one-on-ones', ${actorId}, ${actorId})
        `);
      }
    }
    const rows = (await db.execute<StoredFeedback>(sql`
      select f.id, f.subject_employment_id, e.worker_party_id as subject_party_id,
             e.employer_subsidiary_id as subject_employer_subsidiary_id,
             coalesce(p.display_name, '—') as subject_name,
             f.author_party_id, f.kind, f.visibility, f.body, f.context,
             f.requested_from_party_id,
             f.retracts_feedback_id::text as retracts_feedback_id, f.recorded_at::text as recorded_at
        from hrm_feedback f
        join worker_employments e on e.org_id = f.org_id and e.id = f.subject_employment_id
        left join parties p on p.org_id = f.org_id and p.id = e.worker_party_id
       where f.org_id = ${orgId} and f.id = ${inserted.id}
    `)).rows;
    const dto = rows[0] ? await toDTO(db, orgId, actorId, rows[0]) : null;
    if (!dto) throw new HrmPerformanceError("REFUSED", "the feedback was not stored — no row can be read back; retry the action");
    return dto;
  });
}

export async function retractFeedback(args: { orgId: string; actorId: string; id: string }): Promise<void> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const id = requireId("id", args.id);
  await withOrgTransaction(orgId, async () => {
    await assertFeedbackFeature(db, orgId);
    const rows = (await db.execute<StoredFeedback>(sql`
      select f.id, f.subject_employment_id, e.worker_party_id as subject_party_id,
             e.employer_subsidiary_id as subject_employer_subsidiary_id,
             coalesce(p.display_name, '—') as subject_name,
             f.author_party_id, f.kind, f.visibility, f.body, f.context,
             f.requested_from_party_id,
             f.retracts_feedback_id::text as retracts_feedback_id, f.recorded_at::text as recorded_at
        from hrm_feedback f
        join worker_employments e on e.org_id = f.org_id and e.id = f.subject_employment_id
        left join parties p on p.org_id = f.org_id and p.id = e.worker_party_id
       where f.org_id = ${orgId} and f.id = ${id}
    `)).rows;
    const original = rows[0];
    if (!original || original.kind === "retraction") {
      throw new HrmPerformanceError("NOT_FOUND", "feedback was not found — it may belong to another organization or already be retracted");
    }
    const person = await loadApprovalPerson(db, orgId, actorId);
    const hr = await hasPerformanceManage(db, orgId, actorId);
    if (!hr && person.partyId !== original.author_party_id) {
      throw new HrmPerformanceError(
        "FORBIDDEN",
        "only the author or HR may retract feedback — ask the author to retract it",
      );
    }
    const already = (await db.execute<{ id: string }>(sql`
      select id from hrm_feedback where org_id = ${orgId} and kind = 'retraction' and retracts_feedback_id = ${id}
    `)).rows;
    if (already.length > 0) {
      throw new HrmPerformanceError("BAD_STATE", "this feedback is already retracted — history keeps the single retraction");
    }
    // A retraction is a new row linking the original; the read hides
    // both. The row is never updated or deleted (0228 trigger).
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into hrm_feedback (org_id, subject_employment_id, author_party_id, kind, visibility, body, context, retracts_feedback_id, created_by)
      values (${orgId}, ${original.subject_employment_id}, ${person.partyId ?? original.author_party_id},
              'retraction', 'subject_only', 'retracted', '{}'::jsonb, ${id}, ${actorId})
      returning id
    `)).rows[0];
    if (!inserted) throw new HrmPerformanceError("REFUSED", "the retraction was not stored — no row was written; retry the action");
  });
}

export async function listFeedback(args: {
  orgId: string;
  actorId: string;
  subjectEmploymentId?: string;
}): Promise<readonly FeedbackDTO[]> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertFeedbackFeature(db, orgId);
    const subjectFilter = args.subjectEmploymentId ? sql` and f.subject_employment_id = ${args.subjectEmploymentId}` : sql``;
    const rows = (await db.execute<StoredFeedback>(sql`
      select f.id, f.subject_employment_id, e.worker_party_id as subject_party_id,
             e.employer_subsidiary_id as subject_employer_subsidiary_id,
             coalesce(p.display_name, '—') as subject_name,
             f.author_party_id, f.kind, f.visibility, f.body, f.context,
             f.requested_from_party_id,
             f.retracts_feedback_id::text as retracts_feedback_id, f.recorded_at::text as recorded_at
        from hrm_feedback f
        join worker_employments e on e.org_id = f.org_id and e.id = f.subject_employment_id
        left join parties p on p.org_id = f.org_id and p.id = e.worker_party_id
       where f.org_id = ${orgId}${subjectFilter}
       order by f.recorded_at desc
    `)).rows;
    const hidden = await retractedIds(db, orgId);
    const out: FeedbackDTO[] = [];
    for (const row of rows) {
      if (hidden.has(row.id)) continue;
      const dto = await toDTO(db, orgId, actorId, row);
      if (dto) out.push(dto);
    }
    return out;
  });
}

/**
 * Open feedback requests addressed to the actor's party: the inbox
 * adapter kind hrm_feedback_request reads through this (never raw SQL),
 * so the inbox never widens visibility.
 */
export async function listOpenRequestsForParty(args: {
  orgId: string;
  actorId: string;
}): Promise<readonly FeedbackDTO[]> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertFeedbackFeature(db, orgId);
    const person = await loadApprovalPerson(db, orgId, actorId);
    if (!person.partyId) return [];
    const rows = (await db.execute<StoredFeedback>(sql`
      select f.id, f.subject_employment_id, e.worker_party_id as subject_party_id,
             e.employer_subsidiary_id as subject_employer_subsidiary_id,
             coalesce(p.display_name, '—') as subject_name,
             f.author_party_id, f.kind, f.visibility, f.body, f.context,
             f.requested_from_party_id,
             f.retracts_feedback_id::text as retracts_feedback_id, f.recorded_at::text as recorded_at
        from hrm_feedback f
        join worker_employments e on e.org_id = f.org_id and e.id = f.subject_employment_id
        left join parties p on p.org_id = f.org_id and p.id = e.worker_party_id
       where f.org_id = ${orgId} and f.kind = 'request' and f.requested_from_party_id = ${person.partyId}
       order by f.recorded_at desc
    `)).rows;
    const hidden = await retractedIds(db, orgId);
    const out: FeedbackDTO[] = [];
    for (const row of rows) {
      if (hidden.has(row.id)) continue;
      out.push({
        id: row.id,
        subjectEmploymentId: row.subject_employment_id,
        subjectName: row.subject_name,
        authorPartyId: row.author_party_id,
        kind: "request",
        visibility: row.visibility,
        body: row.body,
        context: (row.context ?? {}) as Record<string, unknown>,
        requestedFromPartyId: row.requested_from_party_id,
            recordedAt: row.recorded_at,
      });
    }
    return out;
  });
}

export async function fulfillRequest(args: {
  orgId: string;
  actorId: string;
  requestId: string;
  visibility: FeedbackVisibility;
  body: string;
}): Promise<FeedbackDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const requestId = requireId("requestId", args.requestId);
  if (typeof args.body !== "string" || args.body.trim().length === 0) {
    throw new HrmPerformanceError("INVALID_INPUT", "fulfilling a request needs a body — write the feedback you were asked for");
  }
  if (!["manager_and_subject", "manager_only", "subject_only"].includes(args.visibility)) {
    throw new HrmPerformanceError("INVALID_INPUT", "a fulfilment answers a request — visibility must be manager_and_subject, manager_only, or subject_only");
  }
  return withOrgTransaction(orgId, async () => {
    await assertFeedbackFeature(db, orgId);
    // Append-only rows cannot be updated (0228 trigger refuses it), so
    // fulfilment links forward: the new feedback row's context carries
    // fulfills_request_id, written in the SAME transaction as the check
    // that the request is still open. The request row is never touched —
    // but it IS locked: the FOR UPDATE serializes concurrent fulfilments
    // so a retried request resolves to the one fulfilment, never two.
    const req = (await db.execute<StoredFeedback>(sql`
      select f.id, f.subject_employment_id, e.worker_party_id as subject_party_id,
             e.employer_subsidiary_id as subject_employer_subsidiary_id,
             coalesce(p.display_name, '—') as subject_name,
             f.author_party_id, f.kind, f.visibility, f.body, f.context,
             f.requested_from_party_id,
             f.retracts_feedback_id::text as retracts_feedback_id, f.recorded_at::text as recorded_at
        from hrm_feedback f
        join worker_employments e on e.org_id = f.org_id and e.id = f.subject_employment_id
        left join parties p on p.org_id = f.org_id and p.id = e.worker_party_id
       where f.org_id = ${orgId} and f.id = ${requestId} and f.kind = 'request'
       for update of f
    `)).rows[0];
    if (!req) throw new HrmPerformanceError("NOT_FOUND", "feedback request was not found — it may already be retracted");
    const hidden = await retractedIds(db, orgId);
    if (hidden.has(requestId)) {
      throw new HrmPerformanceError("BAD_STATE", "this request was retracted — there is nothing left to fulfil");
    }
    const person = await loadApprovalPerson(db, orgId, actorId);
    if (req.requested_from_party_id !== person.partyId && !(await hasPerformanceManage(db, orgId, actorId))) {
      throw new HrmPerformanceError("FORBIDDEN", "only the requested party or HR may fulfil a feedback request");
    }
    // A retried fulfilment returns the first answer instead of writing a
    // second: the fulfils_request_id link is the idempotency key, read
    // under the same request lock so two racers cannot both miss it. But
    // the replay is exact or it is refused: a second call with a different
    // author, body, or visibility is a divergent answer, and silently
    // dropping it while reporting success would lose the caller's words.
    const prior = (await db.execute<{
      id: string;
      authorPartyId: string | null;
      authorName: string;
      visibility: string;
      body: string;
      recordedAt: string;
    }>(sql`
      select f.id, f.author_party_id as "authorPartyId",
             coalesce(p.display_name, f.author_party_id::text) as "authorName",
             f.visibility, f.body, f.recorded_at::text as "recordedAt"
        from hrm_feedback f
        left join parties p on p.org_id = f.org_id and p.id = f.author_party_id
       where f.org_id = ${orgId} and f.kind = 'feedback'
         and f.context->>'fulfills_request_id' = ${requestId}
       limit 1
    `)).rows[0];
    const body = args.body.trim();
    if (prior) {
      const exactReplay =
        prior.authorPartyId === person.partyId && prior.body === body && prior.visibility === args.visibility;
      if (!exactReplay) {
        throw new HrmPerformanceError(
          "REFUSED",
          `feedback request ${requestId} was already fulfilled by ${prior.authorName} at ${prior.recordedAt} — a changed answer is not stored; write a new feedback entry instead of fulfilling the same request again`,
        );
      }
    }
    const fulfilmentId =
      prior?.id ??
      (await db.execute<{ id: string }>(sql`
        insert into hrm_feedback (org_id, subject_employment_id, author_party_id, kind, visibility, body, context, created_by)
        values (${orgId}, ${req.subject_employment_id}, ${person.partyId}, 'feedback', ${args.visibility},
                ${body}, ${JSON.stringify({ fulfills_request_id: requestId })}::jsonb, ${actorId})
        returning id
      `)).rows[0]?.id;
    if (!fulfilmentId) throw new HrmPerformanceError("REFUSED", "the fulfilment was not stored — no row was written; retry the action");
    const rows = (await db.execute<StoredFeedback>(sql`
      select f.id, f.subject_employment_id, e.worker_party_id as subject_party_id,
             e.employer_subsidiary_id as subject_employer_subsidiary_id,
             coalesce(p.display_name, '—') as subject_name,
             f.author_party_id, f.kind, f.visibility, f.body, f.context,
             f.requested_from_party_id,
             f.retracts_feedback_id::text as retracts_feedback_id, f.recorded_at::text as recorded_at
        from hrm_feedback f
        join worker_employments e on e.org_id = f.org_id and e.id = f.subject_employment_id
        left join parties p on p.org_id = f.org_id and p.id = e.worker_party_id
       where f.org_id = ${orgId} and f.id = ${fulfilmentId}
    `)).rows;
    const dto = rows[0] ? await toDTO(db, orgId, actorId, rows[0]) : null;
    if (!dto) throw new HrmPerformanceError("REFUSED", "the fulfilment was not stored — no row can be read back; retry the action");
    return dto;
  });
}
