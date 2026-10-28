/**
 * Service quotes on native estimates. The estimate (kind quote) carries the
 * priced lines and is issued through the native estimate lifecycle; the
 * service terms add which lines are optional add-ons and the deposit due on
 * acceptance. The customer accepts through a possession-token link recorded
 * in the native signature request ledger: the presentation (lines, options
 * and deposit) is hashed when sent and re-checked when signed, so nobody
 * accepts terms that changed, and an estimate edit voids the open request.
 */
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import {
  hashPossessionToken,
  mintPossessionToken,
  verifyPossessionToken,
} from "../platform/signing-tokens.ts";
import { add, cmp, mulPercent, sum } from "../money/money.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import {
  auditService,
  lockCommandKey,
  lockDependentFeature,
  lockServiceFeature,
  optionalText,
  requireMinutes,
  requireMoney,
  requireOne,
  requiredText,
  requireUuid,
  requireUuidList,
  resolveServiceCustomer,
  serviceAuthority,
  SYSTEM_ACTOR,
  type ServiceActor,
} from "./common.ts";
import { ServiceError, serviceDatabaseRefusal } from "./errors.ts";
import {
  billingMode,
  insertJob,
  JOB_COLUMNS,
  validateLabor,
  type BillingMode,
  type StoredJob,
} from "./jobs.ts";
import { lockRequest, setRequestStatus } from "./requests.ts";
import { requestIsOpen } from "./status.ts";
import { insertVisit, normalizeVisitInput, type VisitInput } from "./visits.ts";

const SERVICE_QUOTE_DOMAIN = "service-quote:v1";
const SUBJECT_TABLE = "documents";

export const SERVICE_QUOTE_CONSENT =
  "By typing my name below I accept this quote, including the optional items I selected, as the customer's authorized signatory, " +
  "and I agree to pay the deposit shown when it is due. I understand this electronic signature carries the same effect as a handwritten one.";

export type ServiceQuoteTerms = {
  readonly quoteDocumentId: string;
  readonly status: "draft" | "sent" | "accepted" | "declined";
  readonly depositBasis: "none" | "percent" | "amount";
  readonly depositValue: string;
  readonly requestId: string | null;
  readonly jobId: string | null;
  readonly revision: number;
  readonly signatureRequestId: string | null;
  readonly acceptedTotal: string | null;
  readonly depositDue: string | null;
};

type QuoteDocument = {
  id: string;
  documentNumber: string;
  status: string;
  partyId: string | null;
  subsidiaryId: string | null;
  currency: string;
  total: string;
  memo: string | null;
};
type QuoteLine = {
  id: string;
  lineNumber: number;
  itemId: string | null;
  description: string | null;
  quantity: string;
  unitPrice: string;
  amount: string;
  taxAmount: string;
  taxCodeId: string | null;
};

async function lockQuoteDocument(orgId: string, quoteDocumentId: string): Promise<QuoteDocument> {
  const row = (
    await db.execute<QuoteDocument & { kind: string }>(
      sql`select id, document_number as "documentNumber", status, party_id as "partyId", subsidiary_id as "subsidiaryId",
      currency, total::text as total, memo, kind from documents where org_id = ${orgId} and id = ${requireUuid(quoteDocumentId, "Estimate")} for update`,
      "objects",
    )
  )[0];
  if (!row || row.kind !== "quote") throw new ScopeNotFoundError();
  return row;
}

async function quoteLines(orgId: string, quoteDocumentId: string): Promise<QuoteLine[]> {
  return await db.execute<QuoteLine>(
    sql`select id, line_number as "lineNumber", item_id as "itemId", description, quantity::text, unit_price::text as "unitPrice",
      amount::text, coalesce(tax_amount, 0)::text as "taxAmount", tax_code_id as "taxCodeId"
    from document_lines where org_id = ${orgId} and document_id = ${quoteDocumentId} order by line_number`,
    "objects",
  );
}

const TERMS_COLUMNS = sql`quote_document_id as "quoteDocumentId", status, deposit_basis as "depositBasis", deposit_value::text as "depositValue",
  request_id as "requestId", job_id as "jobId", revision, signature_request_id as "signatureRequestId", accepted_total::text as "acceptedTotal", deposit_due::text as "depositDue"`;

async function lockTerms(
  orgId: string,
  quoteDocumentId: string,
): Promise<ServiceQuoteTerms | null> {
  return (
    (
      await db.execute<ServiceQuoteTerms>(
        sql`select ${TERMS_COLUMNS} from service_quotes where org_id = ${orgId} and quote_document_id = ${quoteDocumentId} for update`,
        "objects",
      )
    )[0] ?? null
  );
}

async function optionalLineIds(orgId: string, quoteDocumentId: string): Promise<Set<string>> {
  return new Set(
    (
      await db.execute<{ id: string }>(
        sql`select document_line_id as id from service_quote_lines
    where org_id = ${orgId} and quote_document_id = ${quoteDocumentId} and optional`,
        "objects",
      )
    ).map((row) => row.id),
  );
}

/** The deposit a total carries under the terms: a percentage or a fixed amount, never more than the total. */
export function depositFor(
  basis: ServiceQuoteTerms["depositBasis"],
  value: string,
  total: string,
): string {
  if (basis === "none") return "0.0000";
  const due = basis === "percent" ? mulPercent(total, value, 2) : value;
  return cmp(due, total) > 0 ? total : add(due, "0");
}

function presentationHash(
  quote: QuoteDocument,
  lines: readonly QuoteLine[],
  optional: ReadonlySet<string>,
  terms: { depositBasis: string; depositValue: string },
): string {
  const canonical = JSON.stringify({
    quote: {
      id: quote.id,
      number: quote.documentNumber,
      party: quote.partyId,
      currency: quote.currency,
      total: quote.total,
    },
    lines: lines.map((line) => [
      line.id,
      line.lineNumber,
      line.itemId,
      line.description,
      line.quantity,
      line.unitPrice,
      line.amount,
      line.taxAmount,
      optional.has(line.id),
    ]),
    deposit: [terms.depositBasis, terms.depositValue],
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Attach or change the service terms of an estimate: the request or job it
 * quotes, the optional add-on lines and the deposit. Terms change while the
 * quote is unsent, or after an estimate edit voided the sent request.
 */
export async function saveServiceQuoteTerms(
  actor: ServiceActor & {
    quoteDocumentId: string;
    requestId?: string | null;
    depositBasis: ServiceQuoteTerms["depositBasis"];
    depositValue: string;
    optionalLineIds: readonly string[];
  },
): Promise<ServiceQuoteTerms> {
  if (!["none", "percent", "amount"].includes(actor.depositBasis))
    throw new ServiceError("Choose no deposit, a percentage or an amount.", {
      code: "service_invalid",
    });
  const depositValue =
    actor.depositBasis === "none" ? "0" : requireMoney(actor.depositValue, "Deposit");
  if (actor.depositBasis === "percent" && cmp(depositValue, "100") > 0)
    throw new ServiceError("A deposit percentage is at most 100.", { code: "service_invalid" });
  if (actor.depositBasis !== "none" && cmp(depositValue, "0") <= 0)
    throw new ServiceError("Enter the deposit, or choose no deposit.", { code: "service_invalid" });
  const optional = new Set(requireUuidList(actor.optionalLineIds, "Optional line", 500));
  return withOrgTransaction(actor.orgId, async () => {
    await lockDependentFeature(actor.orgId, "orders", "Orders");
    const quote = await lockQuoteDocument(actor.orgId, actor.quoteDocumentId);
    await serviceAuthority(actor, "service.manage", quote.subsidiaryId);
    await lockActorCommandAuthority(
      db,
      actor.orgId,
      actor.actorId,
      quote.subsidiaryId,
      "estimates.create",
    );
    if (quote.status === "voided")
      throw new ServiceError("This estimate is voided.", { status: 409, code: "service_invalid" });
    const existing = await lockTerms(actor.orgId, quote.id);
    if (existing && (existing.status === "accepted" || existing.status === "declined")) {
      throw new ServiceError("The customer already answered this quote.", {
        status: 409,
        code: "service_invalid_transition",
        remedy: "Issue a revised estimate for changed terms.",
      });
    }
    if (existing?.status === "sent") {
      const open = (
        await db.execute(
          sql`select 1 from signature_requests where org_id = ${actor.orgId} and id = ${existing.signatureRequestId} and status in ('sent','viewed')`,
          "objects",
        )
      )[0];
      if (open)
        throw new ServiceError("The quote is with the customer.", {
          status: 409,
          code: "service_invalid_transition",
          remedy:
            "Edit the estimate (which withdraws the sent link) or wait for the customer's answer.",
        });
    }
    const requestId =
      actor.requestId === undefined
        ? (existing?.requestId ?? null)
        : actor.requestId
          ? requireUuid(actor.requestId, "Request")
          : null;
    if (requestId) {
      const request = await lockRequest(actor.orgId, requestId);
      if (!requestIsOpen(request.status))
        throw new ServiceError("The request is closed.", {
          status: 409,
          code: "service_invalid_transition",
        });
      if (request.customerPartyId !== quote.partyId)
        throw new ServiceError("The estimate is for another customer.", {
          code: "service_invalid",
          remedy: "Set the estimate's customer to the request's customer.",
        });
    }
    if (!quote.partyId)
      throw new ServiceError("The estimate has no customer.", {
        code: "service_invalid",
        remedy: "Choose the customer on the estimate first.",
      });
    await resolveServiceCustomer(actor.orgId, allowed, {
      customerPartyId: quote.partyId,
      subsidiaryId: quote.subsidiaryId,
    });
    const lines = await quoteLines(actor.orgId, quote.id);
    const lineIds = new Set(lines.map((line) => line.id));
    for (const id of optional)
      if (!lineIds.has(id))
        throw new ServiceError("An optional line is not on the estimate.", {
          code: "service_invalid",
          remedy: "Reload the estimate and choose the add-ons again.",
        });
    if (lines.length && lines.every((line) => optional.has(line.id)))
      throw new ServiceError("At least one line must be required.", {
        code: "service_invalid",
        remedy: "Leave the core work required and mark only add-ons optional.",
      });
    let terms: ServiceQuoteTerms;
    if (existing) {
      terms = requireOne(
        await db.execute<ServiceQuoteTerms>(
          sql`update service_quotes set request_id = ${requestId}, deposit_basis = ${actor.depositBasis},
          deposit_value = ${depositValue}, status = 'draft', sent_at = null, signature_request_id = null,
          revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
        where org_id = ${actor.orgId} and quote_document_id = ${quote.id} and revision = ${existing.revision} returning ${TERMS_COLUMNS}`,
          "objects",
        ),
        "The quote terms",
      );
    } else {
      terms = requireOne(
        await db.execute<ServiceQuoteTerms>(
          sql`insert into service_quotes (org_id, quote_document_id, request_id, deposit_basis, deposit_value, status, created_by, updated_by)
        values (${actor.orgId}, ${quote.id}, ${requestId}, ${actor.depositBasis}, ${depositValue}, 'draft', ${actor.actorId}, ${actor.actorId}) returning ${TERMS_COLUMNS}`,
          "objects",
        ),
        "The quote terms",
      );
    }
    await db.execute(
      sql`delete from service_quote_lines where org_id = ${actor.orgId} and quote_document_id = ${quote.id}`,
    );
    for (const line of lines) {
      requireOne(
        await db.execute(
          sql`insert into service_quote_lines (org_id, quote_document_id, document_line_id, optional)
        values (${actor.orgId}, ${quote.id}, ${line.id}, ${optional.has(line.id)}) returning document_line_id`,
          "objects",
        ),
        "A quote line marking",
      );
    }
    await auditService({
      orgId: actor.orgId,
      table: "service_quotes",
      rowId: quote.id,
      action: existing ? "update" : "insert",
      actorId: actor.actorId,
      before: existing,
      after: { ...terms, optionalLineIds: [...optional] },
    });
    return terms;
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

export interface SentServiceQuote {
  readonly requestId: string;
  /** The raw link token, returned once for delivery and never stored. */
  readonly token: string;
  readonly expiresAt: string;
  readonly quoteNumber: string;
  readonly total: string;
  readonly depositLabel: string | null;
  readonly signerName: string;
  readonly signerEmail: string;
}

/** Send an issued estimate with its service terms to the customer for acceptance. */
export async function sendServiceQuote(
  actor: ServiceActor & {
    quoteDocumentId: string;
    signerName: string;
    signerEmail: string;
    expiresInDays?: number;
  },
): Promise<SentServiceQuote> {
  const signerName = requiredText(actor.signerName, "Signer name", 120);
  const signerEmail = requiredText(actor.signerEmail, "Signer email", 320);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(signerEmail))
    throw new ServiceError("Enter a valid signer email.", { code: "service_invalid" });
  const days = actor.expiresInDays ?? 30;
  if (!Number.isSafeInteger(days) || days < 1 || days > 90)
    throw new ServiceError("The acceptance link lasts 1 to 90 days.", { code: "service_invalid" });
  return withOrgTransaction(actor.orgId, async () => {
    await lockDependentFeature(actor.orgId, "orders", "Orders");
    const quote = await lockQuoteDocument(actor.orgId, actor.quoteDocumentId);
    await serviceAuthority(actor, "service.manage", quote.subsidiaryId);
    await lockActorCommandAuthority(
      db,
      actor.orgId,
      actor.actorId,
      quote.subsidiaryId,
      "estimates.issue",
    );
    const terms = await lockTerms(actor.orgId, quote.id);
    if (!terms)
      throw new ServiceError("The estimate has no service terms.", {
        code: "service_invalid",
        remedy: "Save the quote's add-ons and deposit first.",
      });
    if (terms.status === "accepted" || terms.status === "declined")
      throw new ServiceError("The customer already answered this quote.", {
        status: 409,
        code: "service_invalid_transition",
      });
    if (quote.status !== "approved")
      throw new ServiceError("Issue the estimate before sending it for acceptance.", {
        status: 409,
        code: "service_invalid_transition",
        remedy: "Issue the estimate from its drawer; any configured approval runs there.",
      });
    const lines = await quoteLines(actor.orgId, quote.id);
    if (!lines.length)
      throw new ServiceError("The estimate has no lines.", { code: "service_invalid" });
    const marked = new Set(
      (
        await db.execute<{ id: string }>(
          sql`select document_line_id as id from service_quote_lines where org_id = ${actor.orgId} and quote_document_id = ${quote.id}`,
          "objects",
        )
      ).map((row) => row.id),
    );
    if (lines.some((line) => !marked.has(line.id)) || marked.size !== lines.length) {
      throw new ServiceError("The estimate's lines changed since the add-ons were chosen.", {
        status: 409,
        code: "service_stale",
        remedy: "Review the optional add-ons and save the quote terms again.",
      });
    }
    const optional = await optionalLineIds(actor.orgId, quote.id);
    const documentHash = presentationHash(quote, lines, optional, terms);
    const expiresAt = new Date(Date.now() + days * 86_400_000);
    const requestId = randomUUID();
    const token = mintPossessionToken(SERVICE_QUOTE_DOMAIN, actor.orgId, requestId, expiresAt);
    // A previous link that lapsed or was declined stays as history; an open one blocks re-sending.
    requireOne(
      await db.execute(
        sql`insert into signature_requests
        (id, org_id, subject_table, subject_id, signer_name, signer_email, token_hash, status, expires_at, sent_at, document_hash, consent_text, created_by, updated_by)
      values (${requestId}, ${actor.orgId}, ${SUBJECT_TABLE}, ${quote.id}, ${signerName}, ${signerEmail}, ${hashPossessionToken(token)}, 'sent', ${expiresAt}, now(),
        ${documentHash}, ${SERVICE_QUOTE_CONSENT}, ${actor.actorId}, ${actor.actorId}) returning id`,
        "objects",
      ),
      "The acceptance request",
    );
    requireOne(
      await db.execute(
        sql`update service_quotes set status = 'sent', sent_at = now(), signature_request_id = ${requestId},
        revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
      where org_id = ${actor.orgId} and quote_document_id = ${quote.id} and revision = ${terms.revision} returning quote_document_id`,
        "objects",
      ),
      "The quote terms",
    );
    if (terms.requestId) {
      const request = await lockRequest(actor.orgId, terms.requestId);
      if (requestIsOpen(request.status) && request.status !== "quoted")
        await setRequestStatus(actor, request, "quoted");
    }
    await auditService({
      orgId: actor.orgId,
      table: "signature_requests",
      rowId: requestId,
      action: "insert",
      actorId: actor.actorId,
      after: { subject: quote.id, signerEmail, documentHash, expiresAt: expiresAt.toISOString() },
    });
    const required = lines.filter((line) => !optional.has(line.id));
    const requiredTotal = sum(required.map((line) => add(line.amount, line.taxAmount)));
    const deposit = depositFor(terms.depositBasis, terms.depositValue, requiredTotal);
    return {
      requestId,
      token,
      expiresAt: expiresAt.toISOString(),
      quoteNumber: quote.documentNumber,
      total: `${requiredTotal} ${quote.currency}`,
      depositLabel:
        cmp(deposit, "0") > 0
          ? `${deposit} ${quote.currency}${terms.depositBasis === "percent" ? ` (${terms.depositValue}%)` : ""}`
          : null,
      signerName,
      signerEmail,
    };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/** Withdraw the current open customer-acceptance request for a service quote. */
export async function voidServiceQuoteSignatureRequest(
  actor: ServiceActor & { quoteDocumentId: string },
): Promise<{ voided: boolean; requestId: string | null; status: string | null }> {
  return withOrgTransaction(actor.orgId, async () => {
    await lockDependentFeature(actor.orgId, "orders", "Orders");
    const quote = await lockQuoteDocument(actor.orgId, actor.quoteDocumentId);
    await serviceAuthority(actor, "service.manage", quote.subsidiaryId);
    await lockActorCommandAuthority(
      db,
      actor.orgId,
      actor.actorId,
      quote.subsidiaryId,
      "estimates.create",
    );
    const terms = await lockTerms(actor.orgId, quote.id);
    if (!terms?.signatureRequestId) {
      return { voided: false, requestId: null, status: terms?.status ?? null };
    }
    if (terms.status === "accepted" || terms.status === "declined") {
      throw new ServiceError("The customer already answered this quote.", {
        status: 409,
        code: "service_invalid_transition",
        remedy: "Issue a revised estimate if the accepted terms need to change.",
      });
    }
    const request = (
      await db.execute<{ id: string; status: string }>(
        sql`select id, status from signature_requests
          where org_id = ${actor.orgId} and id = ${terms.signatureRequestId}
          and subject_table = ${SUBJECT_TABLE} and subject_id = ${quote.id} for update`,
        "objects",
      )
    )[0];
    if (!request) {
      throw new ServiceError("The quote's signature request is missing.", {
        status: 409,
        code: "service_stale",
        remedy: "Reload the estimate before changing its signature state.",
      });
    }
    if (request.status !== "sent" && request.status !== "viewed") {
      return { voided: false, requestId: request.id, status: request.status };
    }
    requireOne(
      await db.execute(
        sql`update signature_requests set status = 'voided', voided_at = now(), updated_at = now(), updated_by = ${actor.actorId}
          where org_id = ${actor.orgId} and id = ${request.id} and status in ('sent','viewed') returning id`,
        "objects",
      ),
      "The service quote signature request",
    );
    const after = requireOne(
      await db.execute<ServiceQuoteTerms>(
        sql`update service_quotes set status = 'draft', sent_at = null, signature_request_id = null,
          revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
          where org_id = ${actor.orgId} and quote_document_id = ${quote.id} and revision = ${terms.revision}
          returning ${TERMS_COLUMNS}`,
        "objects",
      ),
      "The service quote terms",
    );
    await auditService({
      orgId: actor.orgId,
      table: "signature_requests",
      rowId: request.id,
      action: "update",
      actorId: actor.actorId,
      before: { status: request.status },
      after: { status: "voided", quoteStatus: after.status },
    });
    return { voided: true, requestId: request.id, status: "voided" };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/** Read the current service-quote terms and the signature request they reference. */
export async function getServiceQuoteSignatureStatus(
  actor: ServiceActor & { quoteDocumentId: string },
): Promise<Record<string, unknown>> {
  return withOrgTransaction(actor.orgId, async () => {
    await lockDependentFeature(actor.orgId, "orders", "Orders");
    const quote = await lockQuoteDocument(actor.orgId, actor.quoteDocumentId);
    await serviceAuthority(actor, "service.read", quote.subsidiaryId);
    const terms = await lockTerms(actor.orgId, quote.id);
    if (!terms) {
      return { quoteDocumentId: quote.id, quoteStatus: null, signatureRequest: null };
    }
    const signatureRequest = terms.signatureRequestId
      ? ((
          await db.execute(
            sql`select id as "requestId", status, signer_name as "signerName", signer_email as "signerEmail",
              (expires_at at time zone 'UTC')::text as "expiresAt"
              from signature_requests where org_id = ${actor.orgId} and id = ${terms.signatureRequestId}
                and subject_table = ${SUBJECT_TABLE} and subject_id = ${quote.id}`,
            "objects",
          )
        )[0] ?? null)
      : null;
    return {
      quoteDocumentId: quote.id,
      quoteStatus: terms.status,
      signatureRequest,
      revision: terms.revision,
    };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

type OpenRequestRow = {
  id: string;
  orgId: string;
  subjectId: string;
  status: string;
  signerName: string;
  expiresAt: string;
  documentHash: string;
  consentText: string | null;
};

async function loadOpenRequest(
  token: string,
): Promise<{ claims: { orgId: string; rowId: string }; row: OpenRequestRow }> {
  const claims = verifyPossessionToken(SERVICE_QUOTE_DOMAIN, token);
  if (!claims)
    throw new ServiceError("This quote link is invalid or expired.", {
      status: 404,
      code: "service_link_invalid",
      remedy: "Ask the sender to send the quote again.",
    });
  const row = (
    await db.execute<OpenRequestRow>(
      sql`select id, org_id as "orgId", subject_id as "subjectId", status, signer_name as "signerName",
      to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt", document_hash as "documentHash", consent_text as "consentText"
    from signature_requests where org_id = ${claims.orgId} and token_hash = ${hashPossessionToken(token)} for update`,
      "objects",
    )
  )[0];
  if (!row || row.id !== claims.rowId)
    throw new ServiceError("This quote link is invalid or expired.", {
      status: 404,
      code: "service_link_invalid",
      remedy: "Ask the sender to send the quote again.",
    });
  return { claims, row };
}

async function expireIfLapsed(row: OpenRequestRow): Promise<boolean> {
  if (row.status !== "sent" && row.status !== "viewed") return false;
  if (Date.parse(row.expiresAt) >= Date.now()) return false;
  requireOne(
    await db.execute(
      sql`update signature_requests set status = 'expired', updated_at = now()
    where org_id = ${row.orgId} and id = ${row.id} and status in ('sent','viewed') returning id`,
      "objects",
    ),
    "The quote link expiry",
  );
  return true;
}

export interface PublicServiceQuote {
  readonly orgName: string;
  readonly customerName: string;
  readonly quoteNumber: string;
  readonly title: string | null;
  readonly currency: string;
  readonly status: string;
  readonly expiresAt: string;
  readonly signerName: string;
  readonly consentText: string;
  readonly depositBasis: ServiceQuoteTerms["depositBasis"];
  readonly depositValue: string;
  readonly lines: readonly {
    readonly id: string;
    readonly description: string;
    readonly quantity: string;
    readonly unitPrice: string;
    readonly amount: string;
    readonly taxAmount: string;
    readonly optional: boolean;
  }[];
}

/** The quote the customer reviews on the hosted page; records the first view. */
export async function publicServiceQuoteView(token: string): Promise<PublicServiceQuote> {
  const claims = verifyPossessionToken(SERVICE_QUOTE_DOMAIN, token);
  if (!claims)
    throw new ServiceError("This quote link is invalid or expired.", {
      status: 404,
      code: "service_link_invalid",
      remedy: "Ask the sender to send the quote again.",
    });
  return withOrgTransaction(claims.orgId, async () => {
    await lockServiceFeature(claims.orgId);
    const { row } = await loadOpenRequest(token);
    if (await expireIfLapsed(row))
      throw new ServiceError("This quote link expired.", {
        status: 410,
        code: "service_link_expired",
        remedy: "Ask the sender to send the quote again.",
      });
    if (row.status === "sent") {
      requireOne(
        await db.execute(
          sql`update signature_requests set status = 'viewed', viewed_at = now(), updated_at = now()
        where org_id = ${row.orgId} and id = ${row.id} and status = 'sent' returning id`,
          "objects",
        ),
        "The quote view",
      );
    }
    const quote = await lockQuoteDocument(row.orgId, row.subjectId);
    const terms = await lockTerms(row.orgId, quote.id);
    if (!terms) throw new ScopeNotFoundError();
    const optional = await optionalLineIds(row.orgId, quote.id);
    const lines = await quoteLines(row.orgId, quote.id);
    const names = (
      await db.execute<{ orgName: string; customerName: string }>(
        sql`select o.name as "orgName", p.display_name as "customerName"
      from orgs o left join parties p on p.org_id = o.id and p.id = ${quote.partyId} where o.id = ${row.orgId}`,
        "objects",
      )
    )[0]!;
    const itemNames = new Map(
      (
        await db.execute<{ id: string; name: string }>(
          sql`select id, name from items where org_id = ${row.orgId}
      and id = any(${`{${lines
        .map((line) => line.itemId)
        .filter(Boolean)
        .join(",")}}`}::uuid[])`,
          "objects",
        )
      ).map((item) => [item.id, item.name]),
    );
    return {
      orgName: names.orgName,
      customerName: names.customerName,
      quoteNumber: quote.documentNumber,
      title: quote.memo,
      currency: quote.currency,
      status: row.status === "sent" ? "viewed" : row.status,
      expiresAt: row.expiresAt,
      signerName: row.signerName,
      consentText: row.consentText ?? SERVICE_QUOTE_CONSENT,
      depositBasis: terms.depositBasis,
      depositValue: terms.depositValue,
      lines: lines.map((line) => ({
        id: line.id,
        description: line.description ?? itemNames.get(line.itemId ?? "") ?? "",
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        amount: line.amount,
        taxAmount: line.taxAmount,
        optional: optional.has(line.id),
      })),
    };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/**
 * Accept the quote on the hosted page with the chosen add-ons. The
 * presentation is re-hashed: a quote changed after sending refuses. One
 * answer per link; a replayed acceptance refuses.
 */
export async function acceptServiceQuote(input: {
  token: string;
  name: string;
  selectedOptionalLineIds: readonly string[];
  signatureSvg?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<{ acceptedTotal: string; depositDue: string; currency: string }> {
  const name = requiredText(input.name, "Your name", 120);
  const selected = new Set(requireUuidList(input.selectedOptionalLineIds, "Add-on", 500));
  const svg = input.signatureSvg ? optionalText(input.signatureSvg, "Signature", 200_000) : null;
  const claims = verifyPossessionToken(SERVICE_QUOTE_DOMAIN, input.token);
  if (!claims)
    throw new ServiceError("This quote link is invalid or expired.", {
      status: 404,
      code: "service_link_invalid",
      remedy: "Ask the sender to send the quote again.",
    });
  return withOrgTransaction(claims.orgId, async () => {
    await lockServiceFeature(claims.orgId);
    const { row } = await loadOpenRequest(input.token);
    if (await expireIfLapsed(row))
      throw new ServiceError("This quote link expired.", {
        status: 410,
        code: "service_link_expired",
        remedy: "Ask the sender to send the quote again.",
      });
    if (row.status !== "sent" && row.status !== "viewed")
      throw new ServiceError("This quote was already answered or withdrawn.", {
        status: 409,
        code: "service_link_used",
        remedy: "Contact the sender if you need to change your answer.",
      });
    const quote = await lockQuoteDocument(row.orgId, row.subjectId);
    const terms = await lockTerms(row.orgId, quote.id);
    if (!terms || terms.status !== "sent" || terms.signatureRequestId !== row.id)
      throw new ServiceError("This quote was withdrawn.", {
        status: 409,
        code: "service_link_used",
        remedy: "Ask the sender to send the quote again.",
      });
    const lines = await quoteLines(row.orgId, quote.id);
    const optional = await optionalLineIds(row.orgId, quote.id);
    if (presentationHash(quote, lines, optional, terms) !== row.documentHash) {
      throw new ServiceError(
        "The quote changed after it was sent, so it cannot be accepted as shown.",
        {
          status: 409,
          code: "service_quote_changed",
          remedy: "Ask the sender to send the current quote.",
        },
      );
    }
    for (const id of selected)
      if (!optional.has(id))
        throw new ServiceError("A selected add-on is not offered on this quote.", {
          code: "service_invalid",
          remedy: "Reload the quote and choose again.",
        });
    const accepted = lines.filter((line) => !optional.has(line.id) || selected.has(line.id));
    const acceptedTotal = sum(accepted.map((line) => add(line.amount, line.taxAmount)));
    const depositDue = depositFor(terms.depositBasis, terms.depositValue, acceptedTotal);
    requireOne(
      await db.execute(
        sql`update signature_requests set status = 'signed', signed_at = now(), signer_ip = ${input.ip ?? null},
        signer_user_agent = ${input.userAgent ?? null}, signature_svg = ${svg}, updated_at = now()
      where org_id = ${row.orgId} and id = ${row.id} and status in ('sent','viewed') returning id`,
        "objects",
      ),
      "The acceptance",
    );
    for (const line of lines) {
      const value = optional.has(line.id) ? selected.has(line.id) : true;
      requireOne(
        await db.execute(
          sql`update service_quote_lines set selected = ${value}
        where org_id = ${row.orgId} and quote_document_id = ${quote.id} and document_line_id = ${line.id} and selected is null returning document_line_id`,
          "objects",
        ),
        "A quote line selection",
      );
    }
    requireOne(
      await db.execute(
        sql`update service_quotes set status = 'accepted', decided_at = now(), decided_name = ${name}, accepted_total = ${acceptedTotal},
        deposit_due = ${depositDue}, revision = revision + 1, updated_at = now()
      where org_id = ${row.orgId} and quote_document_id = ${quote.id} and revision = ${terms.revision} returning quote_document_id`,
        "objects",
      ),
      "The quote acceptance",
    );
    await auditService({
      orgId: row.orgId,
      table: "signature_requests",
      rowId: row.id,
      action: "update",
      actorId: null,
      before: { status: row.status },
      after: {
        status: "signed",
        signedName: name,
        selectedOptionalLineIds: [...selected],
        acceptedTotal,
        depositDue,
        documentHash: row.documentHash,
        consent: row.consentText,
      },
    });
    return { acceptedTotal, depositDue, currency: quote.currency };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/** Decline the quote on the hosted page. */
export async function declineServiceQuote(input: {
  token: string;
  name: string;
  reason?: string | null;
}): Promise<void> {
  const name = requiredText(input.name, "Your name", 120);
  const reason = optionalText(input.reason, "Reason", 2000);
  const claims = verifyPossessionToken(SERVICE_QUOTE_DOMAIN, input.token);
  if (!claims)
    throw new ServiceError("This quote link is invalid or expired.", {
      status: 404,
      code: "service_link_invalid",
      remedy: "Ask the sender to send the quote again.",
    });
  await withOrgTransaction(claims.orgId, async () => {
    await lockServiceFeature(claims.orgId);
    const { row } = await loadOpenRequest(input.token);
    if (await expireIfLapsed(row))
      throw new ServiceError("This quote link expired.", {
        status: 410,
        code: "service_link_expired",
      });
    if (row.status !== "sent" && row.status !== "viewed")
      throw new ServiceError("This quote was already answered or withdrawn.", {
        status: 409,
        code: "service_link_used",
      });
    const terms = await lockTerms(row.orgId, row.subjectId);
    if (!terms || terms.status !== "sent" || terms.signatureRequestId !== row.id)
      throw new ServiceError("This quote was withdrawn.", {
        status: 409,
        code: "service_link_used",
      });
    requireOne(
      await db.execute(
        sql`update signature_requests set status = 'declined', declined_at = now(), updated_at = now()
      where org_id = ${row.orgId} and id = ${row.id} and status in ('sent','viewed') returning id`,
        "objects",
      ),
      "The decline",
    );
    requireOne(
      await db.execute(
        sql`update service_quotes set status = 'declined', decided_at = now(), decided_name = ${name}, revision = revision + 1, updated_at = now()
      where org_id = ${row.orgId} and quote_document_id = ${row.subjectId} and revision = ${terms.revision} returning quote_document_id`,
        "objects",
      ),
      "The quote decline",
    );
    if (terms.requestId) {
      const request = await lockRequest(row.orgId, terms.requestId);
      if (request.status === "quoted")
        await setRequestStatus({ orgId: row.orgId, actorId: SYSTEM_ACTOR }, request, "assessed", {
          reason: reason ?? `Quote declined by ${name}`,
        });
    }
    await auditService({
      orgId: row.orgId,
      table: "signature_requests",
      rowId: row.id,
      action: "update",
      actorId: null,
      before: { status: row.status },
      after: { status: "declined", declinedName: name },
      reason,
    });
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}

/**
 * Convert an accepted quote to a service job: the required lines and the
 * add-ons the customer chose become the job's scope, the deposit due becomes
 * the job's deposit, and the quoted request closes as converted.
 */
export async function convertServiceQuote(
  actor: ServiceActor & {
    id: string;
    quoteDocumentId: string;
    estimatedMinutes: number;
    billingMode: BillingMode;
    laborItemId?: string | null;
    laborUnitPrice?: string | null;
    serviceAddressId?: string | null;
    contactId?: string | null;
    title?: string;
    firstVisit?: Omit<VisitInput, "estimatedMinutes"> | null;
  },
): Promise<{ job: StoredJob; visitId: string | null }> {
  const jobId = requireUuid(actor.id, "Job key");
  return withOrgTransaction(actor.orgId, async () => {
    const quote = await lockQuoteDocument(actor.orgId, actor.quoteDocumentId);
    const allowed = await serviceAuthority(actor, "service.manage", quote.subsidiaryId);
    await lockCommandKey("service-job", actor.orgId, jobId);
    const terms = await lockTerms(actor.orgId, quote.id);
    if (!terms || terms.status !== "accepted")
      throw new ServiceError("Only an accepted quote converts to a job.", {
        status: 409,
        code: "service_invalid_transition",
        remedy: "Send the quote and wait for the customer's acceptance.",
      });
    if (terms.jobId) {
      const existing = (
        await db.execute<StoredJob>(
          sql`select ${JOB_COLUMNS} from service_jobs where org_id = ${actor.orgId} and id = ${terms.jobId}`,
          "objects",
        )
      )[0]!;
      return { job: existing, visitId: null };
    }
    const request = terms.requestId ? await lockRequest(actor.orgId, terms.requestId) : null;
    const customer = await resolveServiceCustomer(actor.orgId, allowed, {
      customerPartyId: quote.partyId,
      subsidiaryId: quote.subsidiaryId,
      serviceAddressId: actor.serviceAddressId ?? request?.serviceAddressId ?? null,
      contactId: actor.contactId ?? request?.contactId ?? null,
    });
    const accepted = await db.execute<{
      id: string;
      itemId: string | null;
      description: string | null;
      quantity: string;
      unitPrice: string;
      taxCodeId: string | null;
    }>(
      sql`select l.id, l.item_id as "itemId", l.description,
        l.quantity::text, l.unit_price::text as "unitPrice", l.tax_code_id as "taxCodeId"
      from document_lines l join service_quote_lines q on q.org_id = l.org_id and q.document_line_id = l.id and q.selected
      where l.org_id = ${actor.orgId} and l.document_id = ${quote.id} order by l.line_number`,
      "objects",
    );
    if (accepted.some((line) => !line.itemId))
      throw new ServiceError("Every accepted estimate line needs an item to become job scope.", {
        code: "service_invalid",
        remedy: "Revise the estimate so each line names an item.",
      });
    const mode = billingMode(actor.billingMode);
    const labor = await validateLabor(actor.orgId, {
      estimatedMinutes: actor.estimatedMinutes,
      billingMode: mode,
      laborItemId: actor.laborItemId,
      laborUnitPrice: actor.laborUnitPrice,
    });
    const job = await insertJob(actor, {
      id: jobId,
      customer,
      requestId: request?.id ?? null,
      quoteDocumentId: quote.id,
      agreementId: null,
      title: requiredText(
        actor.title ?? request?.title ?? quote.memo ?? `Quote ${quote.documentNumber}`,
        "Title",
        200,
      ),
      description: request?.description ?? null,
      priority: request?.priority ?? "normal",
      requiredQualificationTypeIds: [],
      estimatedMinutes: requireMinutes(actor.estimatedMinutes, "Duration estimate"),
      billingMode: mode,
      ...labor,
      depositRequired: terms.depositDue ?? "0",
      askedAt: request?.createdAt ?? new Date().toISOString(),
      lines: accepted.map((line) => ({
        itemId: line.itemId!,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        taxCodeId: line.taxCodeId,
        sourceQuoteLineId: line.id,
      })),
    });
    requireOne(
      await db.execute(
        sql`update service_quotes set job_id = ${job.id}, revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
      where org_id = ${actor.orgId} and quote_document_id = ${quote.id} and revision = ${terms.revision} returning quote_document_id`,
        "objects",
      ),
      "The quote conversion",
    );
    if (request && requestIsOpen(request.status))
      await setRequestStatus(actor, request, "converted");
    let visitId: string | null = null;
    if (actor.firstVisit !== null) {
      const visit = await normalizeVisitInput(
        actor.orgId,
        {
          ...(actor.firstVisit ?? {}),
          estimatedMinutes: job.estimatedMinutes,
          preferredOn: actor.firstVisit?.preferredOn ?? request?.preferredOn ?? null,
        },
        { priority: job.priority, requiredQualificationTypeIds: job.requiredQualificationTypeIds },
      );
      visitId = await insertVisit(actor, {
        subsidiaryId: job.subsidiaryId,
        kind: "service",
        jobId: job.id,
        requestId: null,
        slaDueAt: job.slaDueAt,
        visit,
      });
    }
    return { job, visitId };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(error);
  });
}
