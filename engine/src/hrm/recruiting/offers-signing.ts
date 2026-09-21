import { createHash, createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { renderTemplate } from "@openbooks/pdf";
import { db, withBypassContext, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { requireHrmRecruitingManage } from "../authorization.ts";
import { RecruitingError } from "./errors.ts";
import { requireActorId, requireId, requireOrgId } from "./input.ts";
import { loadOffer } from "./offers.ts";
import { loadApplication } from "./applications.ts";
import {
  enqueueRecruitingEmailJob,
  escapeHtml,
  requireDepthFeature,
  type RecruitingEmailEnqueuer,
} from "./depth.ts";
import {
  OFFER_TOKEN_TTL_MS,
  createRecruitingToken,
  hashRecruitingToken,
  verifyRecruitingToken,
} from "./tokens.ts";

/**
 * Canonical offer-signing service (HR-18, 0229): template offers with
 * in-product e-sign.
 *
 * - renderOfferVersion renders the template with the offer's data and the
 *   selected clauses through the shared mustache renderer (packages/pdf
 *   renderTemplate — the same primitive invoice templates use) and appends
 *   a version row. Every regeneration is a version, never an overwrite:
 *   the version number is max+1 in the same transaction, and the
 *   append-only trigger backstops the race.
 * - The rendered PDF itself is produced by the CALLER (the API route owns
 *   packages/pdf document rendering and the File Cabinet write) and passed
 *   in as renderedFileId; the service pins the file to the version row and
 *   the offer. Engine never imports the file writer — that edge belongs to
 *   the web process, not the hrm module.
 * - sendOfferLink / recordOfferViewed / signOffer / declineOfferSigning /
 *   voidOffer walk the signature_status lifecycle (unsigned→sent→viewed→
 *   signed, or declined/voided) BESIDE the commercial status 0195 owns.
 *   Signing evidence is an HMAC record (signer name, timestamp, IP hash,
 *   document hash) under the recruiting-token domain — the same File
 *   Cabinet HMAC construction the field-ticket signing surface uses.
 * - Token routes are sessionless: the token binds ONE offer, and every
 *   consumer re-checks liveness (unsigned/sent/viewed, unexpired).
 * - hire.ts calls requireSignedOfferForHire: with hrmOfferSigning on, an
 *   accepted-but-unsigned offer refuses the hire BY NAME; with the feature
 *   off, hire behaves exactly as today.
 */

export const OFFER_SIGNATURE_DOMAIN = "hrm-offer-signature:v1";

export interface OfferClause {
  readonly key: string;
  readonly label: string;
  readonly body: string;
  readonly defaultOn: boolean;
}

export interface OfferTemplateDTO {
  readonly id: string;
  readonly name: string;
  readonly bodyTemplate: string;
  readonly clauses: readonly OfferClause[];
  readonly approvalRequired: boolean;
  readonly isActive: boolean;
}

export type OfferVersionDTO = {
  readonly id: string;
  readonly offerId: string;
  readonly version: number;
  readonly renderedFileId: string | null;
  readonly createdAt: string;
}

type TemplateRow = {
  id: string;
  name: string;
  bodyTemplate: string;
  clauses: unknown;
  approvalRequired: boolean;
  isActive: boolean;
};

/**
 * Parse a template's clause list (exported for the Setup write path, so a
 * template that cannot render cannot be saved — one implementation, two
 * callers).
 */
export function parseClauses(raw: unknown, templateName: string): OfferClause[] {
  if (!Array.isArray(raw)) {
    throw new RecruitingError(
      "REFUSED",
      `offer template ${templateName} carries clauses that are not a list — fix the template in Setup instead of rendering it`,
    );
  }
  return raw.map((clause, index) => {
    const key = (clause as { key?: unknown }).key;
    const body = (clause as { body?: unknown }).body;
    if (typeof key !== "string" || key.length === 0 || typeof body !== "string" || body.length === 0) {
      throw new RecruitingError(
        "REFUSED",
        `offer template ${templateName} clause ${index} needs a key and a body — fix the template in Setup instead of rendering it`,
      );
    }
    return {
      key,
      label: typeof (clause as { label?: unknown }).label === "string" ? (clause as { label: string }).label : key,
      body,
      defaultOn: (clause as { default_on?: unknown }).default_on === true,
    };
  });
}

function toTemplateDTO(row: TemplateRow): OfferTemplateDTO {
  return {
    id: row.id,
    name: row.name,
    bodyTemplate: row.bodyTemplate,
    clauses: parseClauses(row.clauses, row.name),
    approvalRequired: row.approvalRequired,
    isActive: row.isActive,
  };
}

export async function loadOfferTemplate(
  exec: SqlExecutor,
  orgId: string,
  templateId: string,
): Promise<OfferTemplateDTO | null> {
  const row = (await exec.execute<TemplateRow>(sql`
    select id, name, body_template as "bodyTemplate", clauses,
           approval_required as "approvalRequired", is_active as "isActive"
      from hrm_offer_templates where org_id = ${orgId} and id = ${templateId}
  `)).rows[0];
  return row ? toTemplateDTO(row) : null;
}

export async function listOfferTemplates(query: {
  orgId: string;
  actorId: string;
  includeInactive?: boolean;
}): Promise<readonly OfferTemplateDTO[]> {
  const orgId = requireOrgId(query.orgId);
  void requireActorId(query.actorId);
  return withOrgTransaction(orgId, async () => {
    await requireDepthFeature(db, orgId, "hrmOfferSigning");
    const rows = (await db.execute<TemplateRow>(sql`
      select id, name, body_template as "bodyTemplate", clauses,
             approval_required as "approvalRequired", is_active as "isActive"
        from hrm_offer_templates
       where org_id = ${orgId} and (${query.includeInactive === true} or is_active)
       order by name
    `)).rows;
    return rows.map(toTemplateDTO);
  });
}

export async function createOfferTemplate(query: {
  orgId: string;
  actorId: string;
  name: unknown;
  bodyTemplate: unknown;
  clauses?: unknown;
  approvalRequired?: boolean;
}): Promise<OfferTemplateDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  if (typeof query.name !== "string" || query.name.trim().length === 0) {
    throw new RecruitingError("INVALID_INPUT", "an offer template needs a non-blank name — name the letter it renders");
  }
  if (typeof query.bodyTemplate !== "string" || query.bodyTemplate.trim().length === 0) {
    throw new RecruitingError("INVALID_INPUT", "an offer template needs a non-blank body — write the letter with {{placeholders}}");
  }
  const clauses = query.clauses === undefined ? [] : parseClauses(query.clauses, query.name.trim());
  return withOrgTransaction(orgId, async () => {
    await requireDepthFeature(db, orgId, "hrmOfferSigning");
    try {
      const row = (await db.execute<TemplateRow>(sql`
        insert into hrm_offer_templates
          (org_id, name, body_template, clauses, approval_required, created_by, updated_by)
        values (${orgId}, ${query.name}, ${query.bodyTemplate}, ${JSON.stringify(clauses)},
                ${query.approvalRequired === true}, ${actorId}, ${actorId})
        returning id, name, body_template as "bodyTemplate", clauses,
                  approval_required as "approvalRequired", is_active as "isActive"
      `)).rows[0];
      if (!row) throw new RecruitingError("REFUSED", "the template was not stored — no row was written; retry the request");
      return toTemplateDTO(row);
    } catch (error) {
      if ((error as { code?: string }).code === "23505" || (error as { cause?: { code?: string } }).cause?.code === "23505") {
        throw new RecruitingError(
          "REFUSED",
          `an offer template named ${query.name} already exists — rename the template or reactivate the existing one`,
        );
      }
      throw error;
    }
  });
}

/**
 * Render data bag for an offer (pure shape, also used by the PDF route):
 * the commercial terms plus the selected clause bodies.
 */
export function offerRenderData(offer: {
  jobTitle: string;
  proposedStartOn: string;
  compensationAmount: string;
  compensationCurrency: string;
  compensationBasis: string;
  candidateName: string;
}): Record<string, unknown> {
  return {
    job_title: offer.jobTitle,
    candidate_name: offer.candidateName,
    start_date: offer.proposedStartOn,
    compensation_amount: offer.compensationAmount,
    compensation_currency: offer.compensationCurrency,
    compensation_basis: offer.compensationBasis,
  };
}

/**
 * Render a template + selected clauses over data (pure, unit-tested):
 * the body renders over the data, then each selected clause body renders
 * over the same data and appends in clause order. Clauses always append —
 * they are never silently dropped when the body forgets them, and never
 * double-placed through a data key.
 */
export function renderOfferDocument(args: {
  bodyTemplate: string;
  clauses: readonly OfferClause[];
  selectedClauseKeys: readonly string[];
  data: Record<string, unknown>;
}): string {
  const selected = new Set(args.selectedClauseKeys);
  for (const key of selected) {
    if (!args.clauses.some((clause) => clause.key === key)) {
      throw new RecruitingError(
        "INVALID_INPUT",
        `clause ${key} is not on this template — select from the template's declared clauses instead of inventing one`,
      );
    }
  }
  const renderedClauses = args.clauses
    .filter((clause) => selected.has(clause.key))
    .map((clause) => renderTemplate(clause.body, args.data));
  const body = renderTemplate(args.bodyTemplate, args.data);
  return renderedClauses.length > 0 ? `${body}\n\n${renderedClauses.join("\n\n")}` : body;
}

/** SHA-256 hex of the rendered document — the identity the signature seals. */
export function hashOfferDocument(rendered: string): string {
  return createHash("sha256").update(rendered, "utf8").digest("hex");
}

function signatureSecret(): string {
  const key = process.env.FLOWS_EMAIL_SECRET || process.env.SESSION_SECRET;
  if (!key) {
    throw new Error("FLOWS_EMAIL_SECRET or SESSION_SECRET must be set to seal offer signatures");
  }
  return key;
}

/** Seal the HMAC evidence record (pure, unit-tested): signer + time + IP hash + document hash. */
export function sealSignatureEvidence(args: {
  signerName: string;
  signedAt: string;
  ipHash: string;
  documentHash: string;
  offerId: string;
  version: number;
}): { evidence: Record<string, string | number>; seal: string } {
  const evidence = {
    signer_name: args.signerName,
    signed_at: args.signedAt,
    ip_hash: args.ipHash,
    document_hash: args.documentHash,
    offer_id: args.offerId,
    version: args.version,
  };
  const seal = createHmac("sha256", signatureSecret())
    .update(`${OFFER_SIGNATURE_DOMAIN}|${args.offerId}|${args.version}|${args.documentHash}|${args.signerName}|${args.signedAt}`)
    .digest("hex");
  return { evidence, seal };
}

export async function renderOfferVersion(query: {
  orgId: string;
  actorId: string;
  offerId: string;
  templateId: unknown;
  selectedClauseKeys?: readonly string[];
  renderedFileId?: unknown;
}): Promise<OfferVersionDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const offerId = requireId(query.offerId, "offerId");
  const templateId = requireId(query.templateId, "templateId");
  const renderedFileId = query.renderedFileId == null ? null : requireId(query.renderedFileId, "renderedFileId");
  return withOrgTransaction(orgId, async () => {
    await requireDepthFeature(db, orgId, "hrmOfferSigning");
    const offer = await loadOffer(db, orgId, offerId);
    if (!offer) throw new RecruitingError("NOT_FOUND", "offer is not visible in this organization");
    const application = await loadApplication(db, orgId, offer.applicationId);
    if (!application) throw new RecruitingError("NOT_FOUND", "application is not visible in this organization");
    await requireHrmRecruitingManage(db, orgId, actorId, application.requisitionId);
    if (["accepted", "declined", "withdrawn", "expired"].includes(offer.status)) {
      throw new RecruitingError(
        "REFUSED",
        `a ${offer.status} offer is terminal and immutable — draft new terms instead of re-rendering this one`,
      );
    }
    const template = await loadOfferTemplate(db, orgId, templateId);
    if (!template) {
      throw new RecruitingError("NOT_FOUND", "offer template is not visible in this organization");
    }
    if (!template.isActive) {
      throw new RecruitingError(
        "REFUSED",
        `template ${template.name} is retired — reactivate it in Setup or pick a live template instead of rendering a retired one`,
      );
    }
    if (template.approvalRequired) {
      throw new RecruitingError(
        "REFUSED",
        `template ${template.name} requires approval before rendering — run the approval chain first instead of rendering directly`,
      );
    }
    const row = (await db.execute<{ version: number }>(sql`
      select coalesce(max(version), 0) + 1 as version
        from hrm_offer_versions where org_id = ${orgId} and offer_id = ${offerId}
    `)).rows[0];
    const version = row?.version ?? 1;
    const payload = {
      template_id: template.id,
      template_name: template.name,
      selected_clauses: [...(query.selectedClauseKeys ?? template.clauses.filter((c) => c.defaultOn).map((c) => c.key))],
      job_title: offer.jobTitle,
      proposed_start_on: offer.proposedStartOn,
      compensation_amount: offer.compensationAmount,
      compensation_currency: offer.compensationCurrency,
      compensation_basis: offer.compensationBasis,
      rendered_file_id: renderedFileId,
    };
    const inserted = (await db.execute<OfferVersionDTO>(sql`
      insert into hrm_offer_versions (org_id, offer_id, version, payload, rendered_file_id, created_by)
      values (${orgId}, ${offerId}, ${version}, ${JSON.stringify(payload)}, ${renderedFileId}, ${actorId})
      returning id, offer_id as "offerId", version, rendered_file_id as "renderedFileId",
                created_at as "createdAt"
    `)).rows[0];
    if (!inserted) throw new RecruitingError("REFUSED", "the offer version was not stored — no row was written; retry the request");
    const bumped = (await db.execute<{ one: number }>(sql`
      update hrm_offers
         set template_id = ${templateId}, version = ${version}, rendered_file_id = ${renderedFileId},
             signature_status = 'unsigned', updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${offerId}
      returning 1 as one
    `)).rows[0];
    if (!bumped) {
      throw new RecruitingError("REFUSED", "the offer was concurrently finalized — reload it instead of re-rendering");
    }
    return inserted;
  });
}

export async function listOfferVersions(query: {
  orgId: string;
  actorId: string;
  offerId: string;
}): Promise<readonly OfferVersionDTO[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const offerId = requireId(query.offerId, "offerId");
  return withOrgTransaction(orgId, async () => {
    await requireDepthFeature(db, orgId, "hrmOfferSigning");
    const offer = await loadOffer(db, orgId, offerId);
    if (!offer) throw new RecruitingError("NOT_FOUND", "offer is not visible in this organization");
    const application = await loadApplication(db, orgId, offer.applicationId);
    if (!application) throw new RecruitingError("NOT_FOUND", "application is not visible in this organization");
    await requireHrmRecruitingManage(db, orgId, actorId, application.requisitionId);
    const rows = (await db.execute<OfferVersionDTO>(sql`
      select id, offer_id as "offerId", version, rendered_file_id as "renderedFileId",
             created_at as "createdAt"
        from hrm_offer_versions
       where org_id = ${orgId} and offer_id = ${offerId}
       order by version
    `)).rows;
    return rows;
  });
}

/**
 * Recruiter-side signature state (loader-resolved reads): commercial
 * status, e-sign lifecycle state, current version, and version count.
 * State only — never the letter, never PII.
 */
export async function offerSignatureState(query: {
  orgId: string;
  actorId: string;
  offerId: string;
}): Promise<{
  offerId: string;
  status: string;
  signatureStatus: string | null;
  version: number;
  versionCount: number;
}> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const offerId = requireId(query.offerId, "offerId");
  return withOrgTransaction(orgId, async () => {
    await requireDepthFeature(db, orgId, "hrmOfferSigning");
    const offer = await loadOffer(db, orgId, offerId);
    if (!offer) throw new RecruitingError("NOT_FOUND", "offer is not visible in this organization");
    const application = await loadApplication(db, orgId, offer.applicationId);
    if (!application) throw new RecruitingError("NOT_FOUND", "application is not visible in this organization");
    try {
      await requireHrmRecruitingManage(db, orgId, actorId, application.requisitionId);
    } catch {
      const { requireHrmRecruitingRead } = await import("../authorization.ts");
      await requireHrmRecruitingRead(db, orgId, actorId, application.requisitionId);
    }
    const full = (await db.execute<{ signatureStatus: string | null; version: number }>(sql`
      select signature_status as "signatureStatus", version
        from hrm_offers where org_id = ${orgId} and id = ${offerId}
    `)).rows[0];
    const versions = (await db.execute<{ count: string }>(sql`
      select count(*)::text as count from hrm_offer_versions
       where org_id = ${orgId} and offer_id = ${offerId}
    `)).rows[0];
    return {
      offerId,
      status: offer.status,
      signatureStatus: full?.signatureStatus ?? null,
      version: full?.version ?? 1,
      versionCount: Number(versions?.count ?? 0),
    };
  });
}

/**
 * Offer desk rows for the Offers surface (loader-resolved): commercial +
 * signature state with version counts. State only — never the letter.
 */
export async function listOffersWithSignature(query: {
  orgId: string;
  actorId: string;
}): Promise<
  readonly {
    id: string;
    jobTitle: string;
    candidateName: string;
    status: string;
    signatureStatus: string | null;
    version: number;
    versionCount: number;
  }[]
> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  return withOrgTransaction(orgId, async () => {
    await requireDepthFeature(db, orgId, "hrmOfferSigning");
    const { requireAggregateRecruitingRead } = await import("../authorization.ts");
    const allowed = await requireAggregateRecruitingRead(db, orgId, actorId);
    const { pgUuidArray } = await import("./depth.ts");
    const rows = (await db.execute<{
      id: string;
      jobTitle: string;
      candidateName: string;
      status: string;
      signatureStatus: string | null;
      version: number;
      versionCount: string;
    }>(sql`
      select o.id, o.job_title as "jobTitle", c.display_name as "candidateName",
             o.status, o.signature_status as "signatureStatus", o.version,
             (select count(*)::text from hrm_offer_versions v
               where v.org_id = o.org_id and v.offer_id = o.id) as "versionCount"
        from hrm_offers o
        join hrm_applications a on a.org_id = o.org_id and a.id = o.application_id
        join hrm_candidates c on c.org_id = o.org_id and c.id = a.candidate_id
       where o.org_id = ${orgId}
         and (${allowed === null} or a.requisition_id = any(${allowed === null ? "{}" : pgUuidArray([...allowed])}::uuid[]))
       order by o.created_at desc
       limit 200
    `)).rows;
    return rows.map((row) => ({ ...row, versionCount: Number(row.versionCount) }));
  });
}

export interface OfferLinkResult {
  readonly offerId: string;
  readonly signingToken: string;
  readonly signingUrlPath: string;
}

/** Send the offer for signature: marks sent, mints the sessionless link, emails the candidate. */
export async function sendOfferLink(query: {
  orgId: string;
  actorId: string;
  offerId: string;
  candidateEmail: unknown;
  candidateName: unknown;
  enqueueEmail?: RecruitingEmailEnqueuer;
}): Promise<OfferLinkResult> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const offerId = requireId(query.offerId, "offerId");
  if (typeof query.candidateEmail !== "string" || query.candidateEmail.trim().length === 0) {
    throw new RecruitingError("INVALID_INPUT", "the candidate needs an email to receive the signing link — record contact PII first");
  }
  // Bind narrowed locals before the transaction closure (parameter
  // narrowing does not survive into the closure).
  const candidateEmail: string = query.candidateEmail;
  return withOrgTransaction(orgId, async () => {
    await requireDepthFeature(db, orgId, "hrmOfferSigning");
    const offer = await loadOffer(db, orgId, offerId);
    if (!offer) throw new RecruitingError("NOT_FOUND", "offer is not visible in this organization");
    const application = await loadApplication(db, orgId, offer.applicationId);
    if (!application) throw new RecruitingError("NOT_FOUND", "application is not visible in this organization");
    await requireHrmRecruitingManage(db, orgId, actorId, application.requisitionId);
    const live = (await db.execute<{ signatureStatus: string | null }>(sql`
      select signature_status as "signatureStatus" from hrm_offers where org_id = ${orgId} and id = ${offerId}
    `)).rows[0];
    if (live?.signatureStatus === "signed") {
      throw new RecruitingError("REFUSED", "this offer is already signed — the signature stands as recorded");
    }
    const token = createRecruitingToken({
      purpose: "offer",
      rowId: offerId,
      expiresAt: Date.now() + OFFER_TOKEN_TTL_MS,
    });
    const marked = (await db.execute<{ one: number }>(sql`
      update hrm_offers
         set signature_status = 'sent', updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${offerId}
         and (signature_status is null or signature_status in ('unsigned', 'sent', 'viewed'))
      returning 1 as one
    `)).rows[0];
    if (!marked) {
      throw new RecruitingError(
        "REFUSED",
        "this offer's signature is closed (signed, declined, or voided) — re-render a fresh version to reopen signing",
      );
    }
    const enqueue = query.enqueueEmail ?? enqueueRecruitingEmailJob;
    const name = typeof query.candidateName === "string" ? query.candidateName : "candidate";
    await enqueue(
      {
        orgId,
        to: candidateEmail,
        subject: `Your offer for ${offer.jobTitle}`,
        html: `<p>Dear ${escapeHtml(name)},</p><p>Your offer for ${escapeHtml(offer.jobTitle)} is ready to review and sign: <a href="/offer/${token}">review and sign your offer</a>.</p>`,
        text: `Dear ${name}, your offer for ${offer.jobTitle} is ready to review and sign: /offer/${token}`,
      },
      { jobId: `offer-sent|${orgId}|${offerId}` },
    );
    return { offerId, signingToken: token, signingUrlPath: `/offer/${token}` };
  });
}

async function offerScopeForToken(signingToken: string): Promise<{ orgId: string; offerId: string }> {
  const claims = verifyRecruitingToken(signingToken, "offer");
  if (!claims) {
    throw new RecruitingError(
      "REFUSED",
      "this signing link is invalid or expired — ask the recruiter for a fresh link instead of reusing this one",
    );
  }
  // The token binds the offer but not the org: resolve the org through the
  // offer row under bypass (the email-action route precedent), then run
  // everything else under that org. The token IS the grant for the lookup;
  // the row carries its org.
  const row = await withBypassContext(async () => {
    const found = (await db.execute<{ orgId: string }>(sql`
      select org_id as "orgId" from hrm_offers where id = ${claims.rowId}
    `)).rows[0];
    return found ?? null;
  });
  if (!row) {
    throw new RecruitingError("NOT_FOUND", "this offer no longer exists — ask the recruiter for the current terms");
  }
  return { orgId: row.orgId, offerId: claims.rowId };
}

/** Public offer view (sessionless): records viewed, returns the render payload. */
export async function readOfferForSigning(signingToken: string): Promise<{
  readonly offerId: string;
  readonly jobTitle: string;
  readonly candidateName: string;
  readonly signatureStatus: string | null;
  readonly version: number;
}> {
  const { orgId, offerId } = await offerScopeForToken(signingToken);
  return withOrgTransaction(orgId, async () => {
    const offer = await loadOffer(db, orgId, offerId);
    if (!offer) throw new RecruitingError("NOT_FOUND", "this offer no longer exists — ask the recruiter for the current terms");
    const full = (await db.execute<{
      signatureStatus: string | null;
      version: number;
      applicationId: string;
    }>(sql`
      select signature_status as "signatureStatus", version,
             application_id as "applicationId"
        from hrm_offers where org_id = ${orgId} and id = ${offerId}
    `)).rows[0];
    if (!full) throw new RecruitingError("NOT_FOUND", "this offer no longer exists — ask the recruiter for the current terms");
    if (full.signatureStatus === "sent") {
      await db.execute(sql`
        update hrm_offers set signature_status = 'viewed', updated_at = now()
         where org_id = ${orgId} and id = ${offerId} and signature_status = 'sent'
      `);
    }
    const application = await loadApplication(db, orgId, full.applicationId);
    const candidate = application
      ? (await db.execute<{ displayName: string }>(sql`
          select display_name as "displayName" from hrm_candidates
           where org_id = ${orgId} and id = ${application.candidateId}
        `)).rows[0]
      : null;
    return {
      offerId,
      jobTitle: offer.jobTitle,
      candidateName: candidate?.displayName ?? "candidate",
      signatureStatus: full.signatureStatus === "sent" ? "viewed" : full.signatureStatus,
      version: full.version,
    };
  });
}

/** Sign the offer (sessionless): seals the HMAC evidence, marks signed. */
export async function signOffer(query: {
  signingToken: string;
  signerName: unknown;
  ipHash: unknown;
  /** Optional client-observed hash; the service seals the latest rendered version when absent. */
  documentHash?: unknown;
  renderedFileId?: unknown;
}): Promise<{ offerId: string; signedAt: string }> {
  const { orgId, offerId } = await offerScopeForToken(query.signingToken);
  if (typeof query.signerName !== "string" || query.signerName.trim().length === 0) {
    throw new RecruitingError("INVALID_INPUT", "a signature needs the signer's name — type the name being signed with");
  }
  // Bind narrowed locals before the transaction closure (parameter
  // narrowing does not survive into the closure).
  const signerName: string = query.signerName;
  const documentHash: unknown = query.documentHash;
  const renderedFileId = query.renderedFileId == null ? null : requireId(query.renderedFileId, "renderedFileId");
  return withOrgTransaction(orgId, async () => {
    const current = (await db.execute<{ signatureStatus: string | null; version: number }>(sql`
      select signature_status as "signatureStatus", version
        from hrm_offers where org_id = ${orgId} and id = ${offerId}
    `)).rows[0];
    if (!current) throw new RecruitingError("NOT_FOUND", "this offer no longer exists — ask the recruiter for the current terms");
    if (current.signatureStatus === "signed") {
      throw new RecruitingError("REFUSED", "this offer is already signed — the signature stands as recorded; token reuse changes nothing");
    }
    if (current.signatureStatus === "voided") {
      throw new RecruitingError("REFUSED", "this offer was voided — ask the recruiter for fresh terms instead of signing a voided letter");
    }
    if (current.signatureStatus === "declined") {
      throw new RecruitingError("REFUSED", "this offer was already declined — a decline stands; ask the recruiter for fresh terms to reconsider");
    }
    // The sealed hash is the latest rendered version's payload — the
    // server's own render, never the client's claim about what it saw. A
    // client-supplied hash that disagrees names the disagreement instead
    // of sealing a document nobody rendered.
    const latest = (await db.execute<{ payload: unknown }>(sql`
      select payload from hrm_offer_versions
       where org_id = ${orgId} and offer_id = ${offerId}
       order by version desc limit 1
    `)).rows[0];
    const serverHash = hashOfferDocument(JSON.stringify(latest?.payload ?? { unsigned: true }));
    if (typeof documentHash === "string" && documentHash.length > 0 && documentHash !== serverHash) {
      throw new RecruitingError(
        "REFUSED",
        "the letter changed since this link was opened — reload the link to review the current terms before signing",
      );
    }
    const signedAt = new Date().toISOString();
    const { evidence, seal } = sealSignatureEvidence({
      signerName: signerName.trim(),
      signedAt,
      ipHash: typeof query.ipHash === "string" ? query.ipHash : "unknown",
      documentHash: serverHash,
      offerId,
      version: current.version,
    });
    const sealed = (await db.execute<{ one: number }>(sql`
      update hrm_offers
         set signature_status = 'signed', signed_at = ${signedAt},
             signed_evidence = ${JSON.stringify({ ...evidence, seal })}::jsonb,
             rendered_file_id = coalesce(${renderedFileId}, rendered_file_id),
             updated_at = now()
       where org_id = ${orgId} and id = ${offerId}
         and (signature_status is null or signature_status in ('unsigned', 'sent', 'viewed'))
      returning 1 as one
    `)).rows[0];
    if (!sealed) {
      throw new RecruitingError("REFUSED", "this offer's signature closed concurrently — reload the link to see the recorded state");
    }
    return { offerId, signedAt };
  });
}

/** Decline with reason (sessionless): a decline names why, like 0195. */
export async function declineOfferSigning(query: {
  signingToken: string;
  reason: unknown;
}): Promise<{ offerId: string }> {
  const { orgId, offerId } = await offerScopeForToken(query.signingToken);
  if (typeof query.reason !== "string" || query.reason.trim().length === 0) {
    throw new RecruitingError("INVALID_INPUT", "a decline needs a reason — say why the terms are refused");
  }
  return withOrgTransaction(orgId, async () => {
    const declined = (await db.execute<{ one: number }>(sql`
      update hrm_offers
         set signature_status = 'declined', decline_reason = ${query.reason}, updated_at = now()
       where org_id = ${orgId} and id = ${offerId}
         and (signature_status is null or signature_status in ('unsigned', 'sent', 'viewed'))
      returning 1 as one
    `)).rows[0];
    if (!declined) {
      throw new RecruitingError("REFUSED", "this offer's signature is already closed — the recorded state stands");
    }
    return { offerId };
  });
}

/** Void an open signature (recruiter-side): re-render to reopen signing. */
export async function voidOfferSignature(query: {
  orgId: string;
  actorId: string;
  offerId: string;
  reason: unknown;
}): Promise<void> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const offerId = requireId(query.offerId, "offerId");
  if (typeof query.reason !== "string" || query.reason.trim().length === 0) {
    throw new RecruitingError("INVALID_INPUT", "voiding a signature needs a reason — record why the letter was pulled");
  }
  await withOrgTransaction(orgId, async () => {
    await requireDepthFeature(db, orgId, "hrmOfferSigning");
    const offer = await loadOffer(db, orgId, offerId);
    if (!offer) throw new RecruitingError("NOT_FOUND", "offer is not visible in this organization");
    const application = await loadApplication(db, orgId, offer.applicationId);
    if (!application) throw new RecruitingError("NOT_FOUND", "application is not visible in this organization");
    await requireHrmRecruitingManage(db, orgId, actorId, application.requisitionId);
    if (["accepted", "declined", "withdrawn", "expired"].includes(offer.status)) {
      throw new RecruitingError(
        "REFUSED",
        `a ${offer.status} offer is terminal history — void the commercial status through the offer lifecycle instead of editing its signature`,
      );
    }
    const voided = (await db.execute<{ one: number }>(sql`
      update hrm_offers
         set signature_status = 'voided', signed_evidence = ${JSON.stringify({ voided_reason: query.reason })}::jsonb,
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${offerId}
         and (signature_status is null or signature_status in ('unsigned', 'sent', 'viewed'))
      returning 1 as one
    `)).rows[0];
    if (!voided) {
      throw new RecruitingError("REFUSED", "this offer is already signed — a signed letter is history; withdraw the offer instead of voiding its signature");
    }
  });
}

/**
 * The hire gate (called by hire.ts): with hrmOfferSigning on, hire
 * requires an accepted+signed offer and refuses BY NAME otherwise; with
 * the feature off, hire behaves exactly as today (no check).
 */
export async function requireSignedOfferForHire(
  exec: SqlExecutor,
  orgId: string,
  offerId: string,
): Promise<void> {
  const state = (await exec.execute<{ features: Record<string, boolean> | null }>(sql`
    select settings->'features' as features from orgs where id = ${orgId}
  `)).rows[0]?.features;
  const { featureEnabled } = await import("../../organization/feature-registry.ts");
  if (!featureEnabled(state ?? {}, "hrmOfferSigning")) return;
  const row = (await exec.execute<{ signatureStatus: string | null }>(sql`
    select signature_status as "signatureStatus" from hrm_offers where org_id = ${orgId} and id = ${offerId}
  `)).rows[0];
  if (!row) {
    throw new RecruitingError("NOT_FOUND", "offer is not visible in this organization");
  }
  if (row.signatureStatus !== "signed") {
    throw new RecruitingError(
      "REFUSED",
      `offer signing is on and this offer is ${row.signatureStatus ?? "unsigned"} — send the signing link and collect the candidate's signature before hiring; hire never lands on an unsigned offer`,
    );
  }
}
