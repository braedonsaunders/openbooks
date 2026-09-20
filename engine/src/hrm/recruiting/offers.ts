import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { businessToday } from "../../platform/business-date.ts";
import {
  requireHrmRecruitingManage,
  requireOwnRequisitionForHiringManager,
} from "../authorization.ts";
import { effectiveOfferStatus } from "./funnel.ts";
import { RecruitingError } from "./errors.ts";
import { optionalCivilDate, requireActorId, requireCivilDate, requireId, requireOrgId, requireReason, isUniqueViolation } from "./input.ts";
import { appendApplicationEvent, loadApplication } from "./applications.ts";

/**
 * Canonical recruiting offer service (HR-6, 0195): the proposed terms. At
 * most one live (draft/sent) offer per application — the partial unique
 * index serializes concurrent creators, and the 23505 backstop names the
 * remedy instead of surfacing a constraint. Expiry is computed on read and
 * materialised on the next write. Acceptance rides hire.ts (the one
 * transaction that files the hire change request); this service owns
 * create, send, decline, withdraw, and expiry materialisation.
 */

export const OFFER_STATUSES = ["draft", "sent", "accepted", "declined", "withdrawn", "expired"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export interface OfferDTO {
  readonly id: string;
  readonly applicationId: string;
  readonly positionId: string | null;
  readonly employerSubsidiaryId: string;
  readonly departmentId: string | null;
  readonly jobTitle: string;
  readonly employmentKind: string | null;
  readonly proposedStartOn: string;
  readonly compensationAmount: string;
  readonly compensationCurrency: string;
  readonly compensationBasis: "hourly" | "annual";
  readonly status: OfferStatus;
  /** The reader-reported status: a past-due sent offer reads expired. */
  readonly effectiveStatus: OfferStatus;
  readonly sentAt: string | null;
  readonly expiresOn: string | null;
  readonly respondedAt: string | null;
  readonly declineReason: string | null;
  readonly approvedChangeId: string | null;
}

export type OfferRow = {
  id: string;
  applicationId: string;
  positionId: string | null;
  employerSubsidiaryId: string;
  departmentId: string | null;
  jobTitle: string;
  employmentKind: string | null;
  proposedStartOn: string;
  compensationAmount: string;
  compensationCurrency: string;
  compensationBasis: string;
  status: string;
  sentAt: string | null;
  expiresOn: string | null;
  respondedAt: string | null;
  declineReason: string | null;
  approvedChangeId: string | null;
};

const OFFER_COLUMNS = sql`
  id, application_id as "applicationId", position_id as "positionId",
  employer_subsidiary_id as "employerSubsidiaryId",
  department_id as "departmentId", job_title as "jobTitle",
  employment_kind as "employmentKind",
  proposed_start_on as "proposedStartOn",
  compensation_amount as "compensationAmount",
  compensation_currency as "compensationCurrency",
  compensation_basis as "compensationBasis", status,
  sent_at as "sentAt", expires_on as "expiresOn",
  responded_at as "respondedAt", decline_reason as "declineReason",
  approved_change_id as "approvedChangeId"
`;

function toDTO(row: OfferRow, today: string): OfferDTO {
  if (!(OFFER_STATUSES as readonly string[]).includes(row.status)) {
    throw new RecruitingError("REFUSED", `offer ${row.id} carries unknown status ${row.status} — refusing a lifecycle the service cannot resolve`);
  }
  if (row.compensationBasis !== "hourly" && row.compensationBasis !== "annual") {
    throw new RecruitingError("REFUSED", `offer ${row.id} carries unknown compensation basis — refusing terms the service cannot resolve`);
  }
  return {
    ...row,
    status: row.status as OfferStatus,
    compensationBasis: row.compensationBasis,
    effectiveStatus: effectiveOfferStatus({ status: row.status, expiresOn: row.expiresOn, businessToday: today }),
  };
}

export async function loadOffer(exec: SqlExecutor, orgId: string, offerId: string): Promise<OfferRow | null> {
  return (await exec.execute<OfferRow>(sql`
    select ${OFFER_COLUMNS} from hrm_offers where org_id = ${orgId} and id = ${offerId}
  `)).rows[0] ?? null;
}

async function loadOfferForUpdate(exec: SqlExecutor, orgId: string, offerId: string): Promise<OfferRow> {
  const row = (await exec.execute<OfferRow>(sql`
    select ${OFFER_COLUMNS} from hrm_offers where org_id = ${orgId} and id = ${offerId} for update
  `)).rows[0];
  if (!row) {
    throw new RecruitingError("NOT_FOUND", "offer is not visible in this organization");
  }
  return row;
}

async function requireOfferManage(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  requisitionId: string,
): Promise<void> {
  try {
    await requireHrmRecruitingManage(exec, orgId, actorId, requisitionId);
  } catch {
    await requireOwnRequisitionForHiringManager(exec, orgId, actorId, requisitionId);
  }
}

const DECIMAL = /^\d+(\.\d{1,4})?$/;

export interface CreateOfferQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly applicationId: string;
  readonly positionId?: unknown;
  readonly employerSubsidiaryId: unknown;
  readonly departmentId?: unknown;
  readonly jobTitle: unknown;
  readonly employmentKind?: unknown;
  readonly proposedStartOn: unknown;
  readonly compensationAmount: unknown;
  readonly compensationCurrency: unknown;
  readonly compensationBasis: unknown;
  readonly expiresOn?: unknown;
}

/**
 * Draft the terms on an active application. Refused when another live
 * offer stands on the application — send, withdraw or expire that one
 * first instead of stacking terms.
 */
export async function createOffer(query: CreateOfferQuery): Promise<OfferDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const applicationId = requireId(query.applicationId, "applicationId");
  if (typeof query.employerSubsidiaryId !== "string" || query.employerSubsidiaryId.length === 0) {
    throw new RecruitingError("INVALID_INPUT", "employerSubsidiaryId must be a non-empty string — the offer belongs to a legal entity");
  }
  if (typeof query.jobTitle !== "string" || query.jobTitle.trim().length === 0) {
    throw new RecruitingError("INVALID_INPUT", "jobTitle must be non-blank");
  }
  const proposedStartOn = requireCivilDate(query.proposedStartOn, "proposedStartOn");
  if (typeof query.compensationAmount !== "string" || !DECIMAL.test(query.compensationAmount)) {
    throw new RecruitingError("INVALID_INPUT", "compensationAmount must be a decimal with up to 4 fraction digits");
  }
  if (typeof query.compensationCurrency !== "string" || !/^[A-Z]{3}$/.test(query.compensationCurrency)) {
    throw new RecruitingError("INVALID_INPUT", "compensationCurrency must be a 3-letter code");
  }
  if (query.compensationBasis !== "hourly" && query.compensationBasis !== "annual") {
    throw new RecruitingError("INVALID_INPUT", "compensationBasis must be hourly or annual — check the basis");
  }
  const expiresOn = optionalCivilDate(query.expiresOn, "expiresOn");
  const positionId = query.positionId === undefined || query.positionId === null ? null : requireId(query.positionId, "positionId");
  const departmentId = query.departmentId === undefined || query.departmentId === null ? null : requireId(query.departmentId, "departmentId");
  const employmentKind =
    query.employmentKind === undefined || query.employmentKind === null
      ? null
      : typeof query.employmentKind === "string" && query.employmentKind.trim().length > 0
        ? query.employmentKind.trim()
        : (() => {
            throw new RecruitingError("INVALID_INPUT", "employmentKind must be non-blank when sent");
          })();

  return withOrgTransaction(orgId, async () => {
    const application = await loadApplication(db, orgId, applicationId);
    if (!application) {
      throw new RecruitingError("NOT_FOUND", "application is not visible in this organization");
    }
    await requireOfferManage(db, orgId, actorId, application.requisitionId);
    if (application.status !== "active") {
      throw new RecruitingError(
        "BAD_STATE",
        `a ${application.status} application takes no new offers — only active candidacies carry terms`,
      );
    }
    const subsidiary = (await db.execute<{ one: number }>(sql`
      select 1 as one from subsidiaries where org_id = ${orgId} and id = ${query.employerSubsidiaryId as string} limit 1
    `)).rows.length > 0;
    if (!subsidiary) {
      throw new RecruitingError("NOT_FOUND", "employer subsidiary is not visible in this organization — check the reference");
    }
    let inserted: OfferRow | undefined;
    try {
      inserted = (await db.execute<OfferRow>(sql`
        insert into hrm_offers
          (org_id, application_id, position_id, employer_subsidiary_id, department_id,
           job_title, employment_kind, proposed_start_on,
           compensation_amount, compensation_currency, compensation_basis,
           status, expires_on, created_by, updated_by)
        values (${orgId}, ${applicationId}, ${positionId},
                ${query.employerSubsidiaryId as string}, ${departmentId},
                ${(query.jobTitle as string).trim()}, ${employmentKind}, ${proposedStartOn}::date,
                ${query.compensationAmount as string}, ${query.compensationCurrency as string},
                ${query.compensationBasis as string},
                'draft', ${expiresOn}::date, ${actorId}, ${actorId})
        returning ${OFFER_COLUMNS}
      `)).rows[0];
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RecruitingError(
          "REFUSED",
          "a live offer already stands on this application — send, withdraw or expire it before drafting new terms",
        );
      }
      throw error;
    }
    if (!inserted) {
      throw new RecruitingError("REFUSED", "the offer was not stored — no row was written; retry the request");
    }
    await appendApplicationEvent(db, {
      orgId,
      actorId,
      applicationId,
      kind: "offer_created",
      reason: `terms drafted: ${(query.jobTitle as string).trim()}`,
    });
    return toDTO(inserted, await businessToday(orgId));
  });
}

/**
 * Materialise a past-due sent offer as expired in its OWN committed
 * transaction, then report whether it fired. Write paths call this BEFORE
 * opening their main transaction: the expiry is a fact about time passing
 * (independent evidence with its own event), while the refused action
 * itself must write nothing — atomicity outranks recording, so the two
 * commits stay separate. Inside the main transaction the caller re-checks
 * status and refuses the expired action by name.
 */
export async function expireOfferIfPastDue(args: {
  orgId: string;
  actorId: string;
  offerId: string;
}): Promise<boolean> {
  const orgId = requireOrgId(args.orgId);
  const actorId = requireActorId(args.actorId);
  const offerId = requireId(args.offerId, "offerId");
  const today = await businessToday(orgId);
  return withOrgTransaction(orgId, async () => {
    const current = await loadOfferForUpdate(db, orgId, offerId);
    return materialiseOfferExpiry(db, { orgId, actorId, offer: current, businessToday: today });
  });
}

export async function materialiseOfferExpiry(
  exec: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    offer: Pick<OfferRow, "id" | "applicationId" | "status" | "expiresOn">;
    businessToday: string;
  },
): Promise<boolean> {
  const { offer } = args;
  if (offer.status !== "sent" || offer.expiresOn === null || offer.expiresOn >= args.businessToday) {
    return false;
  }
  const updated = (await exec.execute<OfferRow>(sql`
    update hrm_offers
       set status = 'expired', updated_by = ${args.actorId}, updated_at = now()
     where org_id = ${args.orgId} and id = ${offer.id} and status = 'sent'
    returning ${OFFER_COLUMNS}
  `)).rows[0];
  if (!updated) return false;
  await appendApplicationEvent(exec, {
    orgId: args.orgId,
    actorId: args.actorId,
    applicationId: offer.applicationId,
    kind: "note",
    reason: `offer expired on ${offer.expiresOn} — materialised on read`,
  });
  return true;
}

export interface SendOfferQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly offerId: string;
}

/** Send a draft (sent_at stamped; the response window opens). */
export async function sendOffer(query: SendOfferQuery): Promise<OfferDTO> {  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const offerId = requireId(query.offerId, "offerId");
  return withOrgTransaction(orgId, async () => {
    const current = await loadOfferForUpdate(db, orgId, offerId);
    const application = await loadApplication(db, orgId, current.applicationId);
    if (!application) {
      throw new RecruitingError("NOT_FOUND", "application is not visible in this organization");
    }
    await requireOfferManage(db, orgId, actorId, application.requisitionId);
    if (current.status !== "draft") {
      throw new RecruitingError("BAD_STATE", `a ${current.status} offer cannot be sent — only drafts send`);
    }
    const updated = (await db.execute<OfferRow>(sql`
      update hrm_offers
         set status = 'sent', sent_at = now(), updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${offerId} and status = 'draft'
      returning ${OFFER_COLUMNS}
    `)).rows[0];
    if (!updated) {
      throw new RecruitingError("STALE_REVISION", "the offer changed while sending — reload it and try again");
    }
    await appendApplicationEvent(db, { orgId, actorId, applicationId: current.applicationId, kind: "offer_sent" });
    return toDTO(updated, await businessToday(orgId));
  });
}

export interface DeclineOfferQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly offerId: string;
  readonly reason: unknown;
}

/** Decline a sent offer with a reason (the funnel end for this candidacy). */
export async function declineOffer(query: DeclineOfferQuery): Promise<OfferDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const offerId = requireId(query.offerId, "offerId");
  const reason = requireReason(query.reason);
  if (await expireOfferIfPastDue({ orgId, actorId, offerId })) {
    throw new RecruitingError(
      "BAD_STATE",
      "the offer expired before it was declined — the expiry stands as recorded; draft new terms instead",
    );
  }
  return withOrgTransaction(orgId, async () => {
    const current = await loadOfferForUpdate(db, orgId, offerId);
    const application = await loadApplication(db, orgId, current.applicationId);
    if (!application) {
      throw new RecruitingError("NOT_FOUND", "application is not visible in this organization");
    }
    await requireOfferManage(db, orgId, actorId, application.requisitionId);
    if (current.status === "expired") {
      throw new RecruitingError(
        "BAD_STATE",
        "the offer expired before it was declined — the expiry stands as recorded; draft new terms instead",
      );
    }
    if (current.status !== "sent") {
      throw new RecruitingError("BAD_STATE", `a ${current.status} offer cannot be declined — only sent offers decline`);
    }
    const updated = (await db.execute<OfferRow>(sql`
      update hrm_offers
         set status = 'declined', responded_at = now(), decline_reason = ${reason},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${offerId} and status = 'sent'
      returning ${OFFER_COLUMNS}
    `)).rows[0];
    if (!updated) {
      throw new RecruitingError("STALE_REVISION", "the offer changed while declining — reload it and try again");
    }
    await appendApplicationEvent(db, {
      orgId,
      actorId,
      applicationId: current.applicationId,
      kind: "offer_declined",
      reason,
    });
    return toDTO(updated, await businessToday(orgId));
  });
}

export interface WithdrawOfferQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly offerId: string;
  readonly reason: unknown;
}

/** Withdraw a draft or sent offer with a reason (frees the live-offer slot). */
export async function withdrawOffer(query: WithdrawOfferQuery): Promise<OfferDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const offerId = requireId(query.offerId, "offerId");
  const reason = requireReason(query.reason);
  if (await expireOfferIfPastDue({ orgId, actorId, offerId })) {
    throw new RecruitingError(
      "BAD_STATE",
      "the offer expired before it was withdrawn — the expiry stands as recorded; draft new terms instead",
    );
  }
  return withOrgTransaction(orgId, async () => {
    const current = await loadOfferForUpdate(db, orgId, offerId);
    const application = await loadApplication(db, orgId, current.applicationId);
    if (!application) {
      throw new RecruitingError("NOT_FOUND", "application is not visible in this organization");
    }
    await requireOfferManage(db, orgId, actorId, application.requisitionId);
    if (current.status === "expired") {
      throw new RecruitingError(
        "BAD_STATE",
        "the offer expired before it was withdrawn — the expiry stands as recorded; draft new terms instead",
      );
    }
    if (current.status !== "draft" && current.status !== "sent") {
      throw new RecruitingError("BAD_STATE", `a ${current.status} offer cannot be withdrawn — only drafts and sent offers withdraw`);
    }
    const updated = (await db.execute<OfferRow>(sql`
      update hrm_offers
         set status = 'withdrawn', updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${offerId} and status in ('draft', 'sent')
      returning ${OFFER_COLUMNS}
    `)).rows[0];
    if (!updated) {
      throw new RecruitingError("STALE_REVISION", "the offer changed while withdrawing — reload it and try again");
    }
    await appendApplicationEvent(db, {
      orgId,
      actorId,
      applicationId: current.applicationId,
      kind: "offer_withdrawn",
      reason,
    });
    return toDTO(updated, await businessToday(orgId));
  });
}
