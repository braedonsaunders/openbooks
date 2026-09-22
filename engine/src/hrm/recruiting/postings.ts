import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { requireHrmRecruitingManage, requireHrmRecruitingManageOrg } from "../authorization.ts";
import { businessToday } from "../../platform/business-date.ts";
import { RecruitingError } from "./errors.ts";
import { isUniqueViolation, requireActorId, requireId, requireOrgId } from "./input.ts";
import { loadFeatureState, requireDepthFeature } from "./depth.ts";
import { featureEnabled } from "../../organization/feature-registry.ts";
import { createRecruitingToken, verifyRecruitingToken } from "./tokens.ts";

/**
 * Canonical job-board service (HR-18, 0229): publishing + disposition sync.
 *
 * - publishPosting / pausePosting / closePosting walk one posting's
 *   lifecycle per (requisition, board_key) and append a posting event in
 *   the same transaction as the state write. board_key is an
 *   org-declared connector key: the generic layer ships 'internal' (the
 *   career page) and 'feed' (the signed feed route); named boards are
 *   connectors behind sync connections.
 * - recordDispositionForApplication is called by the application
 *   transitions (stage moves, rejects, withdraws, hires): when the
 *   application came through a posting (source_posting_id) and hrmJobBoards
 *   is on, it appends a disposition_sent event carrying the board
 *   contract payload (stage, rejection reason code) and enqueues the
 *   connector job. Otherwise it is a strict no-op — HR-6 behavior is
 *   byte-identical with the feature off. The connector interface is
 *   declared here; the internal + feed boards implement it as no-ops that
 *   log (a named vendor connector is a sync-connections concern, not
 *   built here).
 * - applyViaPosting powers the public career page: one transaction that
 *   creates (or reuses by email) the candidate, attaches the application
 *   with source_posting_id, captures this_application consent, and appends
 *   an apply_received event. Abuse controls (honeypot + rate limit) live
 *   at the API layer; the service refuses applications to unpublished
 *   postings and closed requisitions by name.
 */

export const POSTING_STATUSES = ["draft", "published", "paused", "closed", "error"] as const;

export const INTERNAL_BOARD_KEY = "internal";
export const FEED_BOARD_KEY = "feed";

export interface PostingDTO {
  readonly id: string;
  readonly requisitionId: string;
  readonly boardKey: string;
  readonly externalRef: string | null;
  readonly status: string;
  readonly publishedAt: string | null;
  readonly closedAt: string | null;
  readonly errorMessage: string | null;
  readonly applyCount: number;
}

export interface DispositionPayload {
  readonly application_id: string;
  readonly requisition_id: string;
  readonly stage_key: string | null;
  readonly stage_name: string | null;
  readonly status: string;
  readonly rejection_reason_code: string | null;
  readonly recorded_at: string;
}

/**
 * The board-connector contract (org-declared, behind sync connections).
 * Named boards are connectors: they push publishes/pauses/closes and
 * receive disposition payloads. The generic layer's two boards implement
 * this as no-ops that log; vendor OAuth is never built here.
 */
export interface BoardConnector {
  readonly key: string;
  publishPosting(args: { orgId: string; postingId: string }): Promise<{ externalRef: string | null } | null>;
  closePosting(args: { orgId: string; postingId: string }): Promise<void>;
  sendDisposition(args: { orgId: string; postingId: string; payload: DispositionPayload }): Promise<void>;
}

function logConnector(boardKey: string, action: string, detail: string): void {
  console.log(`[hrm-boards] ${action} board=${boardKey} ${detail}`);
}

const internalConnector: BoardConnector = {
  key: INTERNAL_BOARD_KEY,
  async publishPosting(args) {
    logConnector(args.postingId, "publish", `org=${args.orgId} (internal career page reads published postings directly)`);
    return null;
  },
  async closePosting(args) {
    logConnector(args.postingId, "close", `org=${args.orgId} (internal career page stops listing it)`);
  },
  async sendDisposition(args) {
    logConnector(args.postingId, "disposition", `org=${args.orgId} status=${args.payload.status} (internal board needs no callback)`);
  },
};

const feedConnector: BoardConnector = {
  key: FEED_BOARD_KEY,
  async publishPosting(args) {
    logConnector(args.postingId, "publish", `org=${args.orgId} (signed feed route serves published postings)`);
    return null;
  },
  async closePosting(args) {
    logConnector(args.postingId, "close", `org=${args.orgId} (feed drops it on next fetch)`);
  },
  async sendDisposition(args) {
    logConnector(args.postingId, "disposition", `org=${args.orgId} status=${args.payload.status} (feed consumers poll the feed)`);
  },
};

/** Connector registry: internal + feed ship; named boards register behind sync connections. */
export function boardConnectorFor(boardKey: string): BoardConnector | null {
  if (boardKey === INTERNAL_BOARD_KEY) return internalConnector;
  if (boardKey === FEED_BOARD_KEY) return feedConnector;
  return null;
}

type PostingRow = {
  id: string;
  requisitionId: string;
  boardKey: string;
  externalRef: string | null;
  status: string;
  publishedAt: string | null;
  closedAt: string | null;
  errorMessage: string | null;
};

const POSTING_COLUMNS = sql`
  id, requisition_id as "requisitionId", board_key as "boardKey",
  external_ref as "externalRef", status,
  published_at as "publishedAt", closed_at as "closedAt",
  error_message as "errorMessage"
`;

function requireBoardKey(boardKey: unknown): string {
  if (typeof boardKey !== "string" || boardKey.trim().length === 0) {
    throw new RecruitingError("INVALID_INPUT", "a posting needs a board key — name the board it publishes to (internal, feed, or a declared connector)");
  }
  return boardKey.trim();
}

async function applyCount(exec: SqlExecutor, orgId: string, postingId: string): Promise<number> {
  const row = (await exec.execute<{ count: string }>(sql`
    select count(*)::text as count from hrm_applications
     where org_id = ${orgId} and source_posting_id = ${postingId}
  `)).rows[0];
  return Number(row?.count ?? 0);
}

async function appendPostingEvent(
  exec: SqlExecutor,
  args: { orgId: string; postingId: string; kind: string; payload?: unknown },
): Promise<void> {
  const inserted = (await exec.execute<{ id: string }>(sql`
    insert into hrm_posting_events (org_id, posting_id, kind, payload)
    values (${args.orgId}, ${args.postingId}, ${args.kind}, ${args.payload === undefined ? null : JSON.stringify(args.payload)})
    returning id
  `)).rows[0];
  if (!inserted) {
    throw new RecruitingError("REFUSED", "the posting event was not recorded — no row was written; retry the request");
  }
}

export async function listPostings(query: {
  orgId: string;
  actorId: string;
  requisitionId?: string;
}): Promise<readonly PostingDTO[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  return withOrgTransaction(orgId, async () => {
    await requireHrmRecruitingManageOrg(db, orgId, actorId);
    await requireDepthFeature(db, orgId, "hrmJobBoards");
    const rows = (await db.execute<PostingRow>(sql`
      select ${POSTING_COLUMNS} from hrm_job_postings
       where org_id = ${orgId}
         -- Cast: an untyped null parameter makes PostgreSQL refuse the
         -- statement, so listing every posting threw while listing one
         -- requisition's postings worked.
         and (${query.requisitionId ?? null}::uuid is null or requisition_id = ${query.requisitionId ?? null}::uuid)
       order by board_key
    `)).rows;
    return Promise.all(
      rows.map(async (row) => ({ ...row, applyCount: await applyCount(db, orgId, row.id) })),
    );
  });
}

export async function publishPosting(query: {
  orgId: string;
  actorId: string;
  requisitionId: string;
  boardKey: unknown;
}): Promise<PostingDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const requisitionId = requireId(query.requisitionId, "requisitionId");
  const boardKey = requireBoardKey(query.boardKey);
  return withOrgTransaction(orgId, async () => {
    await requireHrmRecruitingManage(db, orgId, actorId, requisitionId);
    await requireDepthFeature(db, orgId, "hrmJobBoards");
    const requisition = (await db.execute<{ status: string }>(sql`
      select status from hrm_requisitions where org_id = ${orgId} and id = ${requisitionId}
    `)).rows[0];
    if (!requisition) {
      throw new RecruitingError("NOT_FOUND", "requisition is not visible in this organization");
    }
    if (requisition.status !== "open") {
      throw new RecruitingError(
        "REFUSED",
        `a ${requisition.status} requisition cannot be published — open it before putting it on a board`,
      );
    }
    const connector = boardConnectorFor(boardKey);
    if (boardKey !== INTERNAL_BOARD_KEY && boardKey !== FEED_BOARD_KEY && !connector) {
      throw new RecruitingError(
        "REFUSED",
        `board ${boardKey} is not a declared connector — declare it behind sync connections before publishing to it`,
      );
    }
    let row: PostingRow | undefined;
    try {
      row = (await db.execute<PostingRow>(sql`
        insert into hrm_job_postings (org_id, requisition_id, board_key, status, published_at, created_by, updated_by)
        values (${orgId}, ${requisitionId}, ${boardKey}, 'published', now(), ${actorId}, ${actorId})
        on conflict (org_id, requisition_id, board_key)
        do update set status = 'published', published_at = coalesce(hrm_job_postings.published_at, now()),
                      closed_at = null, error_message = null,
                      updated_by = excluded.updated_by, updated_at = now()
        returning ${POSTING_COLUMNS}
      `)).rows[0];
      // on conflict is the republish path, not a dropped write: publishing
      // an already-posted board refreshes it in place, and the event below
      // records the republish.
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RecruitingError(
          "REFUSED",
          "this requisition is already posted to that board — pause or close the existing posting instead of duplicating it",
        );
      }
      throw error;
    }
    if (!row) throw new RecruitingError("REFUSED", "the posting was not stored — no row was written; retry the request");
    // The connector push runs after the state write, in the same
    // transaction: a connector throw rolls the publish back, so a posting
    // never reads published while the board never got it.
    const pushed = await connector?.publishPosting({ orgId, postingId: row.id });
    if (pushed?.externalRef) {
      const updated = (await db.execute<PostingRow>(sql`
        update hrm_job_postings set external_ref = ${pushed.externalRef}, updated_by = ${actorId}, updated_at = now()
         where org_id = ${orgId} and id = ${row.id}
        returning ${POSTING_COLUMNS}
      `)).rows[0];
      if (updated) row = updated;
    }
    await appendPostingEvent(db, { orgId, postingId: row.id, kind: "published", payload: { board_key: boardKey } });
    return { ...row, applyCount: await applyCount(db, orgId, row.id) };
  });
}

async function transitionPosting(
  orgId: string,
  actorId: string,
  postingId: string,
  to: "paused" | "closed",
): Promise<PostingDTO> {
  return withOrgTransaction(orgId, async () => {
    const current = (await db.execute<PostingRow & { requisitionId: string }>(sql`
      select ${POSTING_COLUMNS} from hrm_job_postings where org_id = ${orgId} and id = ${postingId}
    `)).rows[0];
    if (!current) {
      throw new RecruitingError("NOT_FOUND", "posting is not visible in this organization — it may belong to another org");
    }
    await requireHrmRecruitingManage(db, orgId, actorId, current.requisitionId);
    await requireDepthFeature(db, orgId, "hrmJobBoards");
    if (current.status === "closed") {
      throw new RecruitingError("REFUSED", "this posting is already closed — closed postings stay closed; publish a fresh posting for a new run");
    }
    const updated = (await db.execute<PostingRow>(sql`
      update hrm_job_postings
         set status = ${to},
             closed_at = case when ${to} = 'closed' then now() else closed_at end,
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${postingId} and status <> 'closed'
      returning ${POSTING_COLUMNS}
    `)).rows[0];
    if (!updated) {
      throw new RecruitingError("REFUSED", "the posting closed concurrently — reload it instead of transitioning a closed row");
    }
    await boardConnectorFor(current.boardKey)?.closePosting({ orgId, postingId });
    await appendPostingEvent(db, { orgId, postingId, kind: to, payload: { board_key: current.boardKey } });
    return { ...updated, applyCount: await applyCount(db, orgId, postingId) };
  });
}

export async function pausePosting(query: { orgId: string; actorId: string; postingId: string }): Promise<PostingDTO> {
  return transitionPosting(requireOrgId(query.orgId), requireActorId(query.actorId), requireId(query.postingId, "postingId"), "paused");
}

export async function closePosting(query: { orgId: string; actorId: string; postingId: string }): Promise<PostingDTO> {
  return transitionPosting(requireOrgId(query.orgId), requireActorId(query.actorId), requireId(query.postingId, "postingId"), "closed");
}

/**
 * Disposition sync (called by application transitions, same transaction).
 * Appends a disposition_sent event with the board-contract payload and
 * enqueues the connector job when the application is posting-sourced and
 * hrmJobBoards is on. Strict no-op otherwise — HR-6 paths with the
 * feature off (or direct applications) write nothing extra.
 */
export async function recordDispositionForApplication(
  exec: SqlExecutor,
  args: {
    orgId: string;
    applicationId: string;
    enqueueConnector?: (job: { orgId: string; postingId: string; payload: DispositionPayload }) => Promise<unknown>;
  },
): Promise<void> {
  const app = (await exec.execute<{
    requisitionId: string;
    sourcePostingId: string | null;
    stageId: string;
    status: string;
    rejectedReason: string | null;
  }>(sql`
    select requisition_id as "requisitionId", source_posting_id as "sourcePostingId",
           stage_id as "stageId", status, rejected_reason as "rejectedReason"
      from hrm_applications where org_id = ${args.orgId} and id = ${args.applicationId}
  `)).rows[0];
  if (!app?.sourcePostingId) return;
  const state = (await exec.execute<{ features: Record<string, boolean> | null }>(sql`
    select settings->'features' as features from orgs where id = ${args.orgId}
  `)).rows[0]?.features;
  const { featureEnabled } = await import("../../organization/feature-registry.ts");
  if (!featureEnabled(state ?? {}, "hrmJobBoards")) return;
  const posting = (await exec.execute<{ boardKey: string }>(sql`
    select board_key as "boardKey" from hrm_job_postings
     where org_id = ${args.orgId} and id = ${app.sourcePostingId}
  `)).rows[0];
  if (!posting) return;
  const stage = (await exec.execute<{ key: string | null; name: string | null }>(sql`
    select key, name from hrm_pipeline_stages where org_id = ${args.orgId} and id = ${app.stageId}
  `)).rows[0];
  const payload: DispositionPayload = {
    application_id: args.applicationId,
    requisition_id: app.requisitionId,
    stage_key: stage?.key ?? null,
    stage_name: stage?.name ?? null,
    status: app.status,
    rejection_reason_code: app.rejectedReason,
    recorded_at: new Date().toISOString(),
  };
  await appendPostingEvent(exec, {
    orgId: args.orgId,
    postingId: app.sourcePostingId,
    kind: "disposition_sent",
    payload: { board_key: posting.boardKey, ...payload },
  });
  const connector = boardConnectorFor(posting.boardKey);
  if (args.enqueueConnector) {
    await args.enqueueConnector({ orgId: args.orgId, postingId: app.sourcePostingId, payload });
  } else {
    // Internal + feed boards implement the contract as no-ops that log;
    // a named board without a registered connector keeps its event as the
    // record and names the missing connector in the log.
    await connector?.sendDisposition({ orgId: args.orgId, postingId: app.sourcePostingId, payload });
  }
}

/** Public feed token for an org (sessionless, signed, yearly). */
export function createFeedToken(orgId: string): string {
  return createRecruitingToken({ purpose: "feed", rowId: requireOrgId(orgId) });
}

/** Verify a feed token and resolve the org (bypass lookup, token is the grant). */
export async function resolveFeedOrg(feedToken: string): Promise<string> {
  const claims = verifyRecruitingToken(feedToken, "feed");
  if (!claims) {
    throw new RecruitingError("REFUSED", "this feed token is invalid or expired — reissue it from the posting surface");
  }
  const row = await withBypassContext(async () => {
    const found = (await db.execute<{ orgId: string }>(sql`
      select id as "orgId" from orgs where id = ${claims.rowId}
    `)).rows[0];
    return found ?? null;
  });
  if (!row) throw new RecruitingError("NOT_FOUND", "this feed's organization no longer exists");
  return row.orgId;
}

/** Feed entries: published postings with open requisitions (public, aggregate only — no PII). */
export async function listFeedPostings(orgId: string): Promise<
  readonly { postingId: string; requisitionNumber: string; title: string; publishedAt: string | null }[]
> {
  const rows = (await db.execute<{
    postingId: string;
    requisitionNumber: string;
    title: string;
    publishedAt: string | null;
  }>(sql`
    select p.id as "postingId", r.requisition_number as "requisitionNumber",
           r.title, p.published_at as "publishedAt"
      from hrm_job_postings p
      join hrm_requisitions r on r.org_id = p.org_id and r.id = p.requisition_id
     where p.org_id = ${orgId} and p.status = 'published' and r.status = 'open'
     order by p.published_at desc
  `)).rows;
  return rows;
}

export interface ApplyViaPostingQuery {
  readonly orgId: string;
  readonly postingId: string;
  readonly displayName: unknown;
  readonly email?: unknown;
  readonly phone?: unknown;
  readonly consentFutureRoles?: boolean;
  readonly actorId?: string;
}

/**
 * Public application through a posting. One transaction: candidate
 * (reused by email when the org already knows them), application with
 * source_posting_id, this_application consent, apply_received event.
 */
/**
 * The one thing an anonymous applicant is ever told when the application
 * does not land. Every reason -- the posting is closed, the requisition
 * is filled, the board feature is off, this candidate already applied --
 * collapses into this sentence on purpose. A refusal that distinguishes
 * "already applied" from "closed" turns a guessable email address into a
 * query against the applicant-tracking system.
 */
const NOT_ACCEPTING =
  "this posting is no longer accepting applications — browse the current openings instead of applying here";

export async function applyViaPosting(
  query: ApplyViaPostingQuery,
): Promise<{ applicationId: string; candidateId: string; duplicate: boolean }> {
  const orgId = requireOrgId(query.orgId);
  const postingId = requireId(query.postingId, "postingId");
  if (typeof query.displayName !== "string" || query.displayName.trim().length === 0) {
    throw new RecruitingError("INVALID_INPUT", "an application needs a name — say who is applying");
  }
  const email =
    query.email == null || String(query.email).trim().length === 0 ? null : String(query.email).trim();
  const phone =
    query.phone == null || String(query.phone).trim().length === 0 ? null : String(query.phone).trim();
  return withOrgTransaction(orgId, async () => {
    // The career PAGE 404s when the job board is off; this write is a
    // separate door and used to stay open behind it. An operator who
    // switches the board off is entitled to believe nobody can apply.
    // The refusal is the generic one: an anonymous caller learns nothing
    // about which features this organization runs.
    const features = await loadFeatureState(db, orgId);
    if (!featureEnabled(features, "hrmRecruiting") || !featureEnabled(features, "hrmJobBoards")) {
      throw new RecruitingError("REFUSED", NOT_ACCEPTING);
    }
    const posting = (await db.execute<{ requisitionId: string; status: string }>(sql`
      select p.requisition_id as "requisitionId", p.status,
             r.status as "requisitionStatus", r.pipeline_template_id as "pipelineTemplateId"
        from hrm_job_postings p
        join hrm_requisitions r on r.org_id = p.org_id and r.id = p.requisition_id
       where p.org_id = ${orgId} and p.id = ${postingId}
    `)).rows[0] as
      | { requisitionId: string; status: string; requisitionStatus: string; pipelineTemplateId: string | null }
      | undefined;
    if (!posting || posting.status !== "published" || posting.requisitionStatus !== "open") {
      throw new RecruitingError("REFUSED", NOT_ACCEPTING);
    }
    if (!posting.pipelineTemplateId) {
      throw new RecruitingError("REFUSED", "this opening names no pipeline — the hiring team must configure the funnel before taking applications");
    }
    const firstStage = (await db.execute<{ id: string }>(sql`
      select id from hrm_pipeline_stages
       where org_id = ${orgId} and template_id = ${posting.pipelineTemplateId}
       order by position limit 1
    `)).rows[0];
    if (!firstStage) {
      throw new RecruitingError("REFUSED", "this opening's funnel has no stages — the hiring team must configure the funnel before taking applications");
    }
    let candidateId: string | null = null;
    if (email) {
      candidateId = (await db.execute<{ id: string }>(sql`
        select id from hrm_candidates where org_id = ${orgId} and lower(email) = lower(${email}) limit 1
      `)).rows[0]?.id ?? null;
    }
    if (!candidateId) {
      const inserted = (await db.execute<{ id: string }>(sql`
        insert into hrm_candidates (org_id, display_name, email, phone, source, source_detail, consent_recorded_at)
        values (${orgId}, ${query.displayName}, ${email}, ${phone}, 'job_board', ${postingId}, now())
        returning id
      `)).rows[0];
      if (!inserted) throw new RecruitingError("REFUSED", "the application was not recorded — no row was written; retry the request");
      candidateId = inserted.id;
    }
    const existing = (await db.execute<{ id: string }>(sql`
      select id from hrm_applications
       where org_id = ${orgId} and requisition_id = ${posting.requisitionId} and candidate_id = ${candidateId}
    `)).rows[0];
    if (existing) {
      // One candidacy per opening still holds -- nothing is written. The
      // applicant is NOT told they already applied, because that answer
      // to an anonymous caller is a membership oracle: try an email, and
      // a distinguishable refusal confirms that person is in the pipeline.
      // The hiring team still sees it: the attempt lands in the posting's
      // append-only ledger, which only staff can read.
      await appendPostingEvent(db, {
        orgId,
        postingId,
        kind: "apply_duplicate",
        payload: { application_id: existing.id },
      });
      return { applicationId: existing.id, candidateId, duplicate: true };
    }
    // The application lands on the org's business day, never the UTC day
    // (which is tomorrow in the evening for the Americas).
    const today = await businessToday(orgId);
    const application = (await db.execute<{ id: string }>(sql`
      insert into hrm_applications
        (org_id, requisition_id, candidate_id, stage_id, status, applied_on, source_posting_id)
      values (${orgId}, ${posting.requisitionId}, ${candidateId}, ${firstStage.id}, 'active', ${today}, ${postingId})
      returning id
    `)).rows[0];
    if (!application) throw new RecruitingError("REFUSED", "the application was not recorded — no row was written; retry the request");
    const { appendApplicationEvent } = await import("./applications.ts");
    await appendApplicationEvent(db, {
      orgId,
      // A public applicant is a candidate, never a user: attributing the
      // event to the candidate id violates the users FK, so staff-less
      // applies record a null actor and the reason names the posting.
      actorId: query.actorId ?? null,
      applicationId: application.id,
      kind: "applied",
      toStageId: firstStage.id,
      reason: `public apply through posting ${postingId}`,
    });
    await db.execute(sql`
      insert into hrm_candidate_consents (org_id, candidate_id, purpose, source)
      values (${orgId}, ${candidateId}, 'this_application', 'form')
      on conflict (org_id, candidate_id, purpose)
      do update set granted_at = excluded.granted_at, withdrawn_at = null, updated_at = now()
    `);
    if (query.consentFutureRoles === true) {
      await db.execute(sql`
        insert into hrm_candidate_consents (org_id, candidate_id, purpose, source)
        values (${orgId}, ${candidateId}, 'future_roles', 'form')
        on conflict (org_id, candidate_id, purpose)
        do update set granted_at = excluded.granted_at, withdrawn_at = null, updated_at = now()
      `);
    }
    await appendPostingEvent(db, { orgId, postingId, kind: "apply_received", payload: { application_id: application.id } });
    return { applicationId: application.id, candidateId, duplicate: false };
  });
}

/**
 * Disposition log for one posting (loader-resolved): the append-only
 * event ledger, newest last. Aggregate rows — payloads carry stage and
 * reason codes, never candidate PII.
 */
export async function listPostingEvents(query: {
  orgId: string;
  actorId: string;
  postingId: string;
}): Promise<readonly { id: string; kind: string; recordedAt: string }[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const postingId = requireId(query.postingId, "postingId");
  return withOrgTransaction(orgId, async () => {
    const posting = (await db.execute<{ requisitionId: string }>(sql`
      select requisition_id as "requisitionId" from hrm_job_postings
       where org_id = ${orgId} and id = ${postingId}
    `)).rows[0];
    if (!posting) {
      throw new RecruitingError("NOT_FOUND", "posting is not visible in this organization — it may belong to another org");
    }
    const { requireHrmRecruitingManage, requireHrmRecruitingRead } = await import("../authorization.ts");
    try {
      await requireHrmRecruitingManage(db, orgId, actorId, posting.requisitionId);
    } catch {
      await requireHrmRecruitingRead(db, orgId, actorId, posting.requisitionId);
    }
    await requireDepthFeature(db, orgId, "hrmJobBoards");
    const rows = (await db.execute<{ id: string; kind: string; recordedAt: string }>(sql`
      select id, kind, recorded_at as "recordedAt" from hrm_posting_events
       where org_id = ${orgId} and posting_id = ${postingId}
       order by recorded_at
       limit 200
    `)).rows;
    return rows;
  });
}
