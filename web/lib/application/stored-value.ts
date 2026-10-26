import "server-only";
import { sql } from "drizzle-orm";
import { db, withOrgContext, withOrgTransaction } from "@openbooks/engine/platform/db";
import { fromUnits, toUnits } from "@openbooks/engine/money/money";
import { lockLedgerSetupFence } from "@openbooks/engine/organization/ledger-setup";
import { lockScopeRow } from "@openbooks/engine/organization/scope";
import { submitAndReleaseIfUngated } from "@openbooks/engine/flows/module";
import {
  createPaymentDocument,
  updateDraftPayment,
} from "@openbooks/engine/payments/payment-documents";
import { openItemsForParty } from "@openbooks/engine/payments/payment-queries";
import { sameCurrencyAllocation } from "@openbooks/engine/payments/settlement-policy";
import { postPaymentWithApplications } from "@openbooks/engine/payments/payment-posting";
import { PaymentError } from "@openbooks/engine/payments-core/payment-errors";
import { PostingError } from "@openbooks/engine/journal/contracts";
import { hashStoredValueCode } from "@openbooks/engine/stored-value";
import { isFeatureEnabled } from "../features";
import {
  lookupStoredValueByCode,
  resolveStoredValueTender,
} from "@openbooks/engine/stored-value/accounts";
import { StoredValueError } from "@openbooks/engine/stored-value/errors";
import { isUuid } from "../list-params";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission, assertSubsidiaryAccess } from "./context";
import { ApplicationError, invalidInput, notFound } from "./errors";
import { executeIdempotent } from "./idempotency";

function storedValueFailure(error: unknown): never {
  if (error instanceof StoredValueError) {
    throw new ApplicationError("invalid_input", error.message, error.status, {
      code: error.code,
      remedy: error.remedy,
    });
  }
  if (error instanceof PaymentError || error instanceof PostingError) {
    throw new ApplicationError("invalid_input", error.message, 422);
  }
  throw error;
}

export interface StoredValueLookupResult {
  kind: "gift_card" | "store_credit";
  currency: string;
  balance: string;
  status: string;
  expiresOn: string | null;
}

/**
 * POS/storefront balance check. Unknown codes read exactly like any other
 * miss: the caller learns nothing about which codes exist.
 */
export async function lookupStoredValueBalance(
  context: ApplicationContext,
  input: { code: string },
): Promise<StoredValueLookupResult> {
  assertApplicationPermission(context, "stored_value.read");
  const orgId = context.authz.user.orgId;
  if (!(await isFeatureEnabled(orgId, "storedValue"))) throw notFound("stored value");
  const code = input.code.trim();
  if (!code) throw invalidInput("code is required");
  const found = await withOrgContext(orgId, () =>
    lookupStoredValueByCode(orgId, code, context.authz.allowedSubsidiaryIds),
  );
  if (!found) throw notFound("stored value");
  return {
    kind: found.kind,
    currency: found.currency,
    balance: fromUnits(BigInt(found.balanceMinor)),
    status: found.status,
    expiresOn: found.expiresOn,
  };
}

export interface StoredValueRedeemResult {
  status: "posted" | "pending_approval";
  paymentId: string;
  entryId: string | null;
  requestId?: string;
  accountId: string;
  balance: string;
}

/**
 * POS/storefront redemption against one invoice. The receipt is an ordinary
 * customer_payment whose tender splits bank (zero here) and the liability,
 * so the books stay balanced through the payment kernel — never a parallel
 * payment. Exactly-once per Idempotency-Key through the shared journal.
 */
export async function redeemStoredValueForInvoice(
  context: ApplicationContext,
  input: { code: string; amount: string; invoiceId: string; idempotencyKey: string },
): Promise<{ replayed: boolean; result: StoredValueRedeemResult }> {
  assertApplicationPermission(context, "stored_value.manage");
  assertApplicationPermission(context, "ar.pay");
  const orgId = context.authz.user.orgId;
  if (!(await isFeatureEnabled(orgId, "storedValue"))) throw notFound("stored value");
  if (!isUuid(input.invoiceId)) throw invalidInput("invoiceId must be a UUID");
  const code = input.code.trim();
  if (!code) throw invalidInput("code is required");
  let amountMinor: bigint;
  try {
    amountMinor = toUnits(input.amount);
  } catch {
    throw invalidInput("amount must be a decimal with at most 4 decimal places");
  }
  if (amountMinor <= 0n) throw invalidInput("amount must be positive");
  const outcome = await executeIdempotent({
    context,
    operation: "stored_value.redeem",
    idempotencyKey: input.idempotencyKey,
    // The secret code never persists here: the org-bound digest identifies
    // the tender, so tendering a different code under the same key hashes
    // differently and fails closed instead of replaying another card.
    request: {
      codeHash: hashStoredValueCode(orgId, code),
      amount: input.amount,
      invoiceId: input.invoiceId,
    },
    // A stored receipt replays only while the actor still sees both sides:
    // losing invoice or account visibility refuses without ever returning
    // the original receipt.
    authorizeReplay: async () => {
      await withOrgContext(orgId, async () => {
        const again = await resolveStoredValueTender(
          orgId,
          code,
          context.authz.allowedSubsidiaryIds,
        );
        if (!again) throw notFound("stored value");
        const replayInvoice = (
          await db.execute<{ subsidiaryId: string | null }>(
            sql`
          select subsidiary_id as "subsidiaryId" from documents
           where id = ${input.invoiceId} and org_id = ${orgId} and kind = 'customer_invoice'
        `,
            "objects",
          )
        )[0];
        if (!replayInvoice) throw notFound("invoice");
        assertSubsidiaryAccess(context, replayInvoice.subsidiaryId);
      });
    },
    execute: async () => {
      try {
        return await withOrgTransaction(orgId, async () => {
          const resolved = await resolveStoredValueTender(
            orgId,
            code,
            context.authz.allowedSubsidiaryIds,
          );
          if (!resolved) throw notFound("stored value");
          const invoice = (
            await db.execute<{
              id: string;
              status: string;
              currency: string;
              partyId: string | null;
              subsidiaryId: string | null;
            }>(
              sql`
            select id, status, currency, party_id as "partyId", subsidiary_id as "subsidiaryId"
              from documents
             where id = ${input.invoiceId} and org_id = ${orgId} and kind = 'customer_invoice'
             limit 1
          `,
              "objects",
            )
          )[0];
          if (!invoice) throw notFound("invoice");
          // Scope before lifecycle: a foreign invoice refuses here, before
          // its status or open balance can leak through a named refusal.
          assertSubsidiaryAccess(context, invoice.subsidiaryId);
          if (invoice.status !== "posted" && invoice.status !== "approved") {
            throw invalidInput(
              `invoice is ${invoice.status}; only an open invoice can be paid with stored value`,
            );
          }
          // The receipt applies against the invoice's open AR line, not the
          // document: the settlement kernel allocates per open-item line with
          // rate evidence, so a document reference alone no longer addresses
          // anything. An invoice with no open line is already paid.
          const openLine = invoice.partyId
            ? (
                await openItemsForParty(
                  invoice.partyId,
                  "ar",
                  orgId,
                  context.authz.allowedSubsidiaryIds,
                )
              ).find((item) => item.documentId === invoice.id)
            : undefined;
          if (!openLine) {
            throw invalidInput(
              "invoice has no open balance; only an unpaid invoice can be paid with stored value",
            );
          }
          await lockLedgerSetupFence(db, orgId, "shared");
          const created = await createPaymentDocument({
            orgId,
            kind: "customer_payment",
            createdBy: context.authz.user.id,
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
            partyId: invoice.partyId,
            bankAccountId: null,
            subsidiaryId: invoice.subsidiaryId,
            currency: invoice.currency,
          });
          await lockScopeRow(db, orgId, "document", created.id, context.authz.allowedSubsidiaryIds);
          await updateDraftPayment(
            created.id,
            {
              allocations: [sameCurrencyAllocation(openLine.lineId, input.amount)],
              storedValueTenders: [{ code, amount: input.amount }],
            },
            context.authz.user.id,
            orgId,
            { allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds },
          );
          const submission = await submitAndReleaseIfUngated(
            "customer_payment",
            created.id,
            context.authz.user.id,
          );
          if (submission.flowError) {
            throw new ApplicationError(
              "invalid_input",
              `approval could not be routed: ${submission.flowError}`,
              422,
            );
          }
          if (submission.gated) {
            return {
              status: "pending_approval" as const,
              paymentId: created.id,
              entryId: null,
              requestId: submission.runId ?? undefined,
              accountId: resolved.accountId,
              balance: fromUnits(BigInt(resolved.balanceMinor)),
            };
          }
          const posted = await postPaymentWithApplications(
            created.id,
            undefined,
            context.authz.user.id,
            context.source,
          );
          const balance = (
            await db.execute<{ balance: string }>(
              sql`
            select balance_minor::text as balance from stored_value_accounts
             where id = ${resolved.accountId} and org_id = ${orgId}`,
              "objects",
            )
          )[0];
          // The receipt carries the posted balance: an unreadable row
          // refuses by name instead of fabricating a zero success.
          if (!balance) {
            throw invalidInput(
              "The stored-value receipt posted but its balance is no longer readable; have the stored-value entry history reviewed before retrying.",
            );
          }
          return {
            status: "posted" as const,
            paymentId: created.id,
            entryId: posted.entryId,
            accountId: resolved.accountId,
            balance: fromUnits(BigInt(balance.balance)),
          };
        });
      } catch (error) {
        storedValueFailure(error);
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}
