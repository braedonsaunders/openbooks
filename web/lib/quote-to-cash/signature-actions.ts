import "server-only";
import {
  QUOTE_SUBJECT_TABLE,
  QuoteToCashError,
  quoteCashPreview,
  requestQuoteSignature,
  voidSignatureRequestsForSubject,
} from "@openbooks/engine/billing/quote-to-cash";
import { db, withOrgTransaction } from "@openbooks/engine/platform/database";
import type { Authz } from "../authz";
import { deliverQuoteSignature } from "./delivery";

export async function getQuoteSignatureStatus(authz: Authz, quoteId: string) {
  const preview = await quoteCashPreview(authz.user.orgId, quoteId, authz.allowedSubsidiaryIds);
  return { request: preview.signature };
}

export async function voidQuoteSignatureRequest(authz: Authz, quoteId: string) {
  return withOrgTransaction(authz.user.orgId, () =>
    voidSignatureRequestsForSubject(
      db,
      authz.user.orgId,
      QUOTE_SUBJECT_TABLE,
      quoteId,
      authz.allowedSubsidiaryIds,
    ),
  );
}

export async function sendQuoteSignatureRequest(input: {
  authz: Authz;
  quoteId: string;
  signerName: string;
  signerEmail: string;
  expiresInDays?: number | null;
  request?: Request;
}) {
  const { authz, quoteId } = input;
  if (!input.request && !process.env.OPENBOOKS_APP_URL?.trim()) {
    throw new QuoteToCashError(
      "The public application URL is required to send a quote signature link.",
    );
  }
  const preview = await quoteCashPreview(authz.user.orgId, quoteId, authz.allowedSubsidiaryIds);
  const sent = await requestQuoteSignature({
    orgId: authz.user.orgId,
    actorId: authz.user.id,
    quoteId,
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    signerName: input.signerName,
    signerEmail: input.signerEmail,
    expiresInDays: input.expiresInDays,
  });
  if (sent.status === "pending_approval") return sent;
  const delivery = await deliverQuoteSignature({
    orgId: authz.user.orgId,
    actorId: authz.user.id,
    req: input.request,
    quoteNumber: preview.quote.documentNumber,
    currency: preview.quote.currency,
    totalContractValue: preview.tcv,
    termMonths: Math.max(0, ...preview.terms.map((term) => term.term.termMonths)),
    token: sent.token,
    signerName: input.signerName,
    signerEmail: input.signerEmail,
    expiresAt: sent.expiresAt,
  });
  return {
    requestId: sent.requestId,
    expiresAt: sent.expiresAt.toISOString(),
    ...delivery,
  };
}
