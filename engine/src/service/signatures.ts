/**
 * Customer sign-off of a visit through a possession-token link, the field
 * ticket pattern: only the token digest is stored, one link is open per
 * visit, a link is used once, and the signed image lands in the file
 * cabinet. The technician can open the link on their device to sign in
 * person, or the link is emailed to the customer.
 */
import { sql } from "drizzle-orm";
import {
  deriveEmailDeliveryKey,
  emailDeliveryBlockedParts,
  sendVia,
  serviceVisitSignatureEmail,
} from "@openbooks/emails";
import { db, withOrgTransaction } from "../platform/db.ts";
import {
  hashPossessionToken,
  mintPossessionToken,
  verifyPossessionToken,
} from "../platform/signing-tokens.ts";
import {
  insertEmailLog,
  markEmailFailed,
  markEmailSent,
  markEmailUncertain,
  resolveOrgEmailTransportDetailed,
} from "../delivery/email-config.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import {
  auditService,
  lockServiceFeature,
  optionalText,
  requireOne,
  requiredText,
  requireUuid,
  type ServiceActor,
} from "./common.ts";
import { ServiceError, serviceDatabaseRefusal } from "./errors.ts";
import { lockVisit, visitFieldAuthority } from "./visits.ts";

const SIGNATURE_DOMAIN = "service-visit-signature:v1";

export interface VisitSignatureLink {
  readonly requestId: string;
  /** The raw token, returned once; never stored. */
  readonly token: string;
  readonly expiresAt: string;
  readonly recipient: string | null;
}

/**
 * Issue a signing link for a visit on site or completed. An open link is
 * revoked first, so only the newest link signs.
 */
export async function issueVisitSignatureLink(
  actor: ServiceActor & { visitId: string; recipient?: string | null; expiresInDays?: number },
): Promise<VisitSignatureLink> {
  const recipient = optionalText(actor.recipient, "Recipient", 320);
  if (recipient && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient))
    throw new ServiceError("Enter a valid email for the signer.", { code: "service_invalid" });
  const days = actor.expiresInDays ?? 7;
  if (!Number.isSafeInteger(days) || days < 1 || days > 30)
    throw new ServiceError("A signing link lasts 1 to 30 days.", { code: "service_invalid" });
  return withOrgTransaction(actor.orgId, async () => {
    const visit = await lockVisit(actor.orgId, actor.visitId);
    await visitFieldAuthority(actor, visit);
    if (visit.status !== "on_site" && visit.status !== "completed") {
      throw new ServiceError("The customer signs off a visit on site or after it is completed.", {
        status: 409,
        code: "service_invalid_transition",
        remedy: "Mark the visit on site first.",
      });
    }
    const signed = (
      await db.execute(
        sql`select 1 from service_visit_signatures where org_id = ${actor.orgId} and visit_id = ${visit.id}`,
        "objects",
      )
    )[0];
    if (signed)
      throw new ServiceError("The customer already signed this visit.", {
        status: 409,
        code: "service_conflict",
      });
    await db.execute(sql`update service_visit_signature_requests set revoked_at = now()
      where org_id = ${actor.orgId} and visit_id = ${visit.id} and responded_at is null and revoked_at is null`);
    const requestId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + days * 86_400_000);
    const token = mintPossessionToken(SIGNATURE_DOMAIN, actor.orgId, requestId, expiresAt);
    requireOne(
      await db.execute(
        sql`insert into service_visit_signature_requests (id, org_id, visit_id, recipient, token_digest, expires_at, created_by)
      values (${requestId}, ${actor.orgId}, ${visit.id}, ${recipient}, ${hashPossessionToken(token)}, ${expiresAt}, ${actor.actorId}) returning id`,
        "objects",
      ),
      "The signing link",
    );
    await auditService({
      orgId: actor.orgId,
      table: "service_visit_signature_requests",
      rowId: requestId,
      action: "insert",
      actorId: actor.actorId,
      after: { visitId: visit.id, recipient, expiresAt: expiresAt.toISOString() },
    });
    return { requestId, token, expiresAt: expiresAt.toISOString(), recipient };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/** Withdraw the current open customer-signature link for a visit. */
export async function voidVisitSignatureLink(
  actor: ServiceActor & { visitId: string },
): Promise<{ voided: boolean; requestId: string | null; status: "voided" | "responded" | null }> {
  return withOrgTransaction(actor.orgId, async () => {
    const visit = await lockVisit(actor.orgId, actor.visitId);
    await visitFieldAuthority(actor, visit);
    const request = (
      await db.execute<{ id: string; respondedAt: Date | null; revokedAt: Date | null }>(
        sql`select id, responded_at as "respondedAt", revoked_at as "revokedAt"
          from service_visit_signature_requests
          where org_id = ${actor.orgId} and visit_id = ${visit.id}
          order by created_at desc, id desc limit 1 for update`,
        "objects",
      )
    )[0];
    if (!request) return { voided: false, requestId: null, status: null };
    if (request.respondedAt) {
      return { voided: false, requestId: request.id, status: "responded" };
    }
    if (request.revokedAt) {
      return { voided: false, requestId: request.id, status: "voided" };
    }
    requireOne(
      await db.execute(
        sql`update service_visit_signature_requests set revoked_at = now()
          where org_id = ${actor.orgId} and id = ${request.id}
            and responded_at is null and revoked_at is null returning id`,
        "objects",
      ),
      "The visit signature link",
    );
    await auditService({
      orgId: actor.orgId,
      table: "service_visit_signature_requests",
      rowId: request.id,
      action: "update",
      actorId: actor.actorId,
      before: { revokedAt: null },
      after: { revokedAt: "now" },
    });
    return { voided: true, requestId: request.id, status: "voided" };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/** Read the latest customer-signature link state for a visit. */
export async function getVisitSignatureStatus(actor: ServiceActor & { visitId: string }): Promise<{
  visitId: string;
  request: {
    requestId: string;
    status: "sent" | "expired" | "voided" | "responded";
    recipient: string | null;
    expiresAt: string;
  } | null;
}> {
  return withOrgTransaction(actor.orgId, async () => {
    const visit = await lockVisit(actor.orgId, actor.visitId);
    await visitFieldAuthority(actor, visit);
    const row = (
      await db.execute<{
        requestId: string;
        recipient: string | null;
        expiresAt: string;
        respondedAt: Date | null;
        revokedAt: Date | null;
      }>(
        sql`select id as "requestId", recipient,
            (expires_at at time zone 'UTC')::text as "expiresAt", responded_at as "respondedAt",
            revoked_at as "revokedAt"
          from service_visit_signature_requests
          where org_id = ${actor.orgId} and visit_id = ${visit.id}
          order by created_at desc, id desc limit 1`,
        "objects",
      )
    )[0];
    if (!row) return { visitId: visit.id, request: null };
    const status = row.respondedAt
      ? "responded"
      : row.revokedAt
        ? "voided"
        : Date.parse(row.expiresAt) <= Date.now()
          ? "expired"
          : "sent";
    return {
      visitId: visit.id,
      request: {
        requestId: row.requestId,
        status,
        recipient: row.recipient,
        expiresAt: row.expiresAt,
      },
    };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/** Email an issued signing link to its recipient through native email delivery. */
export async function emailVisitSignatureLink(
  actor: ServiceActor & { requestId: string; link: string },
): Promise<{ sent: boolean; detail: string | null }> {
  const prepared = await withOrgTransaction(actor.orgId, async () => {
    await lockServiceFeature(actor.orgId);
    const row = (
      await db.execute<{
        recipient: string | null;
        visitId: string;
        jobNumber: string;
        title: string;
        orgName: string;
        contactName: string | null;
        expiresAt: string;
      }>(
        sql`
      select sr.recipient, sr.visit_id as "visitId", coalesce(j.job_number, r.request_number) as "jobNumber", coalesce(j.title, r.title) as title, o.name as "orgName",
             c.name as "contactName", (sr.expires_at at time zone 'UTC')::date::text as "expiresAt"
        from service_visit_signature_requests sr
        join service_visits v on v.org_id = sr.org_id and v.id = sr.visit_id
        left join service_jobs j on j.org_id = v.org_id and j.id = v.job_id
        left join service_requests r on r.org_id = v.org_id and r.id = v.request_id
        left join contacts c on c.org_id = v.org_id and c.id = coalesce(j.contact_id, r.contact_id)
        join orgs o on o.id = sr.org_id
       where sr.org_id = ${actor.orgId} and sr.id = ${requireUuid(actor.requestId, "Signing link")} and sr.responded_at is null and sr.revoked_at is null`,
        "objects",
      )
    )[0];
    if (!row) throw new ScopeNotFoundError();
    if (!row.recipient)
      throw new ServiceError("The signing link has no recipient email.", {
        code: "service_invalid",
        remedy:
          "Open the link on this device to sign in person, or issue a link with the customer's email.",
      });
    const delivery = await resolveOrgEmailTransportDetailed(actor.orgId);
    if (delivery.state !== "ready") {
      const parts = emailDeliveryBlockedParts(delivery);
      throw new ServiceError(parts.summary, {
        code: "service_email_unavailable",
        remedy: parts.remedy,
      });
    }
    const email = serviceVisitSignatureEmail({
      orgName: row.orgName,
      recipientName: row.contactName,
      jobNumber: row.jobNumber,
      jobTitle: row.title,
      link: actor.link,
      expiresOn: row.expiresAt,
    });
    const logId = await insertEmailLog({
      orgId: actor.orgId,
      recipients: [row.recipient],
      subject: email.subject,
      status: "queued",
      categoryKey: "service",
      meta: { recordType: "service_visit", recordId: row.visitId, event: "signature_request" },
      actor: { kind: "user", userId: actor.actorId },
    });
    requireOne(
      await db.execute(
        sql`update service_visit_signature_requests set email_log_id = ${logId}
      where org_id = ${actor.orgId} and id = ${actor.requestId} and responded_at is null and revoked_at is null returning id`,
        "objects",
      ),
      "The signing link email",
    );
    return { to: row.recipient, email, logId, transport: delivery.transport };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
  try {
    const outcome = await sendVia(
      prepared.transport,
      {
        to: prepared.to,
        subject: prepared.email.subject,
        html: prepared.email.html,
        text: prepared.email.text,
      },
      {
        deliveryKey: deriveEmailDeliveryKey({
          orgId: actor.orgId,
          scope: `direct:${prepared.logId}`,
          to: prepared.to,
        }),
      },
    );
    if (outcome.kind === "sent") {
      await withOrgTransaction(actor.orgId, () =>
        markEmailSent(actor.orgId, prepared.logId, outcome.providerMessageId),
      );
      return { sent: true, detail: null };
    }
    await withOrgTransaction(actor.orgId, () =>
      markEmailUncertain(actor.orgId, prepared.logId, outcome.reason),
    );
    return { sent: false, detail: outcome.reason };
  } catch (error) {
    const detail =
      error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
    await withOrgTransaction(actor.orgId, () =>
      markEmailFailed(actor.orgId, prepared.logId, detail),
    );
    return { sent: false, detail };
  }
}

export interface VisitSignatureClaims {
  readonly orgId: string;
  readonly requestId: string;
}

/** Verify a signing link's signature and expiry; the row is re-validated on every use. */
export function verifyVisitSignatureToken(token: string): VisitSignatureClaims | null {
  const claims = verifyPossessionToken(SIGNATURE_DOMAIN, token);
  return claims ? { orgId: claims.orgId, requestId: claims.rowId } : null;
}

type OpenLink = {
  id: string;
  visitId: string;
  status: string;
  jobNumber: string;
  title: string;
  customerName: string;
  address: string | null;
  workNotes: string | null;
  orgName: string;
  expiresAt: string;
  signed: boolean;
};

async function lockOpenLink(claims: VisitSignatureClaims, token: string): Promise<OpenLink> {
  const row = (
    await db.execute<
      OpenLink & { respondedAt: string | null; revokedAt: string | null; expired: boolean }
    >(
      sql`
    select sr.id, sr.visit_id as "visitId", v.status, coalesce(j.job_number, r.request_number) as "jobNumber", coalesce(j.title, r.title) as title,
           p.display_name as "customerName", nullif(concat_ws(', ', a.line1, a.city, a.region, a.postal_code), '') as address, v.work_notes as "workNotes",
           o.name as "orgName", to_char(sr.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt",
           sr.responded_at as "respondedAt", sr.revoked_at as "revokedAt", sr.expires_at < now() as expired,
           exists (select 1 from service_visit_signatures s where s.org_id = sr.org_id and s.visit_id = sr.visit_id) as signed
      from service_visit_signature_requests sr
      join service_visits v on v.org_id = sr.org_id and v.id = sr.visit_id
      left join service_jobs j on j.org_id = v.org_id and j.id = v.job_id
      left join service_requests r on r.org_id = v.org_id and r.id = v.request_id
      join parties p on p.org_id = v.org_id and p.id = coalesce(j.customer_party_id, r.customer_party_id)
      left join addresses a on a.org_id = v.org_id and a.id = coalesce(j.service_address_id, r.service_address_id)
      join orgs o on o.id = sr.org_id
     where sr.org_id = ${claims.orgId} and sr.id = ${claims.requestId} and sr.token_digest = ${hashPossessionToken(token)}
     for update of sr`,
      "objects",
    )
  )[0];
  if (!row)
    throw new ServiceError("This signing link is invalid.", {
      status: 404,
      code: "service_link_invalid",
      remedy: "Ask for a new signing link.",
    });
  if (row.revokedAt)
    throw new ServiceError("This signing link was replaced by a newer one.", {
      status: 410,
      code: "service_link_revoked",
      remedy: "Use the newest link you received.",
    });
  if (row.respondedAt || row.signed)
    throw new ServiceError("This visit was already signed.", {
      status: 409,
      code: "service_link_used",
    });
  if (row.expired)
    throw new ServiceError("This signing link expired.", {
      status: 410,
      code: "service_link_expired",
      remedy: "Ask for a new signing link.",
    });
  if (row.status !== "on_site" && row.status !== "completed")
    throw new ServiceError("This visit can no longer be signed.", {
      status: 409,
      code: "service_link_used",
    });
  return row;
}

export interface PublicVisitSignature {
  readonly orgName: string;
  readonly jobNumber: string;
  readonly title: string;
  readonly customerName: string;
  readonly address: string | null;
  readonly workNotes: string | null;
  readonly expiresAt: string;
  readonly parts: readonly { readonly name: string; readonly quantity: string }[];
  readonly technicians: readonly string[];
}

/** What the signer reviews: the work done, the parts used and who did it. Prices stay private. */
export async function publicVisitSignatureView(token: string): Promise<PublicVisitSignature> {
  const claims = verifyVisitSignatureToken(token);
  if (!claims)
    throw new ServiceError("This signing link is invalid or expired.", {
      status: 404,
      code: "service_link_invalid",
      remedy: "Ask for a new signing link.",
    });
  return withOrgTransaction(claims.orgId, async () => {
    await lockServiceFeature(claims.orgId);
    const link = await lockOpenLink(claims, token);
    const parts = await db.execute<{ name: string; quantity: string }>(
      sql`select i.name, sp.quantity::text from service_visit_parts sp
      join items i on i.org_id = sp.org_id and i.id = sp.item_id where sp.org_id = ${claims.orgId} and sp.visit_id = ${link.visitId} order by sp.created_at`,
      "objects",
    );
    const technicians = (
      await db.execute<{ name: string }>(
        sql`select distinct p.display_name as name from schedule_entries e join parties p on p.org_id = e.org_id and p.id = e.worker_party_id
      where e.org_id = ${claims.orgId} and e.service_visit_id = ${link.visitId} and e.status = 'published' order by 1`,
        "objects",
      )
    ).map((row) => row.name);
    return {
      orgName: link.orgName,
      jobNumber: link.jobNumber,
      title: link.title,
      customerName: link.customerName,
      address: link.address,
      workNotes: link.workNotes,
      expiresAt: link.expiresAt,
      parts,
      technicians,
    };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/**
 * Record the signature inside the caller's tenant transaction, after the
 * signed image is stored in the file cabinet. The link is consumed once.
 */
export async function recordVisitSignature(input: {
  orgId: string;
  token: string;
  signerName: string;
  comment?: string | null;
  signatureFileId: string;
}): Promise<{ visitId: string; signatureId: string }> {
  const claims = verifyVisitSignatureToken(input.token);
  if (!claims || claims.orgId !== input.orgId)
    throw new ServiceError("This signing link is invalid or expired.", {
      status: 404,
      code: "service_link_invalid",
      remedy: "Ask for a new signing link.",
    });
  const signerName = requiredText(input.signerName, "Your name", 120);
  const comment = optionalText(input.comment, "Comment", 2000);
  await lockServiceFeature(input.orgId);
  const link = await lockOpenLink(claims, input.token);
  requireOne(
    await db.execute(
      sql`update service_visit_signature_requests set responded_at = now()
    where org_id = ${input.orgId} and id = ${link.id} and responded_at is null and revoked_at is null returning id`,
      "objects",
    ),
    "The signing link",
  );
  const signature = requireOne(
    await db.execute<{ id: string }>(
      sql`insert into service_visit_signatures (org_id, visit_id, request_id, signer_name, comment, signature_file_id)
    values (${input.orgId}, ${link.visitId}, ${link.id}, ${signerName}, ${comment}, ${requireUuid(input.signatureFileId, "Signature image")}) returning id`,
      "objects",
    ),
    "The signature",
  );
  await auditService({
    orgId: input.orgId,
    table: "service_visit_signatures",
    rowId: signature.id,
    action: "insert",
    actorId: null,
    after: { visitId: link.visitId, signerName, comment, signatureFileId: input.signatureFileId },
  });
  return { visitId: link.visitId, signatureId: signature.id };
}

/** The visit a signing link names, for attaching the signed image to it. */
export async function signatureLinkVisit(orgId: string, token: string): Promise<string> {
  const claims = verifyVisitSignatureToken(token);
  if (!claims || claims.orgId !== orgId)
    throw new ServiceError("This signing link is invalid or expired.", {
      status: 404,
      code: "service_link_invalid",
    });
  const link = await lockOpenLink(claims, token);
  return link.visitId;
}
