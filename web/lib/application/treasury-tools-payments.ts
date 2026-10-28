import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { can } from "../authz";
import { db } from "@openbooks/engine/platform/db";
import { PaymentError } from "@openbooks/engine/payments-core/payment-errors";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { createPaymentRun } from "@openbooks/engine/payments/run-creation";
import {
  paymentRunBillsInScope,
  listOutboundPaymentRuns,
  loadPaymentRunDetail,
  paymentInstructionInRun,
  paymentLinkDocumentScope,
  paymentLinkScope,
  paymentDocumentScope,
  paymentPartyScope,
  creditApplicationSettlementScope,
  paymentFileStatus,
} from "@openbooks/engine/payments/payment-queries";
import {
  submitPaymentRun,
  rollbackPaymentRun,
  recordPaymentSettlement,
  resolveUncertainDelivery,
} from "@openbooks/engine/payments/operations";
import { generatePaymentFileArtifact } from "@openbooks/engine/payments/operations";
import { postPaymentRun } from "@openbooks/engine/payments/run-posting";
import { cancelPaymentRun } from "@openbooks/engine/payments/run-cancellation";
import { deliverRunToSftp } from "@openbooks/engine/sftp/import-job";
import {
  applyStandaloneCredits,
  unapplyCreditSettlement,
} from "@openbooks/engine/payments/credit-settlement";
import {
  writeOffInvoice,
  InvoiceWriteOffConflictError,
} from "@openbooks/engine/payments/documents";
import {
  createPaymentLink,
  voidPaymentLink,
  PaymentAcceptanceError,
} from "@openbooks/engine/payments/acceptance/operations";
import { replayPaymentPostingEffect } from "@openbooks/engine/payments/payment-effect-recovery";
import { PostingEffectsReplayError } from "@openbooks/engine/documents/posting-effects-errors";
import { paymentRunScopeSql } from "../payment-run-access";
import {
  assertApplicationPermission,
  assertSubsidiaryAccess,
  type ApplicationContext,
} from "./context";
import { ApplicationError, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import {
  assertTreasuryGate,
  DATE,
  IDEMPOTENCY_KEY,
  MONEY,
  runOutsideTenantTransaction,
  settleDomainRefusal,
  UUID,
} from "./treasury-tools-common";

const actorCanPay = (authz: Parameters<typeof can>[0]) =>
  can(authz, "ap.pay") || can(authz, "ar.pay");
const paymentHref = (id: string) => `/payments?view=runs&run=${encodeURIComponent(id)}`;

async function paymentRunForActor(context: ApplicationContext, runId: string) {
  if (!actorCanPay(context.authz)) throw new ApplicationError("not_found", "record not found", 404);
  const row = (
    await db.execute<{ id: string; direction: string }>(
      sql`
      select r.id, r.direction from payment_runs r
       where r.id = ${runId} and ${paymentRunScopeSql(context.authz)}
    `,
      "objects",
    )
  )[0];
  if (!row) throw notFound("payment run");
  const permission = row.direction === "inbound" ? "ar.pay" : "ap.pay";
  assertApplicationPermission(context, permission);
  return row;
}

function settlePaymentError(error: unknown): never {
  if (
    error instanceof PaymentError ||
    error instanceof PaymentAcceptanceError ||
    error instanceof InvoiceWriteOffConflictError ||
    error instanceof PostingEffectsReplayError
  ) {
    if (error instanceof InvoiceWriteOffConflictError) {
      throw new ApplicationError("conflict", error.message, 409);
    }
    settleDomainRefusal(error, 422);
  }
  if (error instanceof ScopeNotFoundError) throw notFound("record");
  throw error;
}

const creditInput = z.object({
  fromLineId: UUID.describe(
    "Credit or unapplied-payment open line id from credit_items_for_party.",
  ),
  toLineId: UUID.describe("Open item line id to settle."),
  amount: MONEY.describe("Exact amount to apply, as a decimal string."),
  sourceDocumentId: UUID.describe("Credit source document id."),
});

export const TREASURY_PAYMENT_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_payment_runs",
    title: "List Payment Runs",
    description:
      "List outbound payment runs visible in the caller's subsidiary scope. Use the returned ids with get_payment_run or the payment-run lifecycle commands.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "ap.pay"),
    execute: async (context) => {
      assertApplicationPermission(context, "ap.pay");
      const runs = await listOutboundPaymentRuns(
        context.authz.user.orgId,
        context.authz.allowedSubsidiaryIds,
      );
      return { runs };
    },
  }),
  definition({
    name: "get_payment_run",
    title: "Get Payment Run",
    description:
      "Read a payment run and its visible instructions before choosing a lifecycle action. Copy the id from list_payment_runs; out-of-scope runs read as missing.",
    inputSchema: z.object({ runId: UUID.describe("Payment run id from list_payment_runs.") }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: actorCanPay,
    execute: async (context, input) => {
      await paymentRunForActor(context, input.runId);
      const detail = await loadPaymentRunDetail(
        context.authz.user.orgId,
        input.runId,
        context.authz.allowedSubsidiaryIds,
      );
      if (!detail) throw notFound("payment run");
      return { ...detail, href: paymentHref(input.runId) };
    },
  }),
  definition({
    name: "create_payment_run",
    title: "Create Payment Run",
    description:
      "Build a draft outbound run from posted, open vendor bills selected by id, grouped into one payment per vendor. Use list_records for bill ids and payment-run reads to review the generated run before submission.",
    inputSchema: z.object({
      paymentBankProfileId: UUID.describe("Active payment bank profile id from payment setup."),
      billDocumentIds: z
        .array(UUID.describe("Posted open vendor bill id."))
        .min(1)
        .max(1000)
        .describe("Vendor bills included in this run."),
      scheduledFor: DATE.nullable().optional().describe("Optional requested payment date."),
      selectionCriteria: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Selection evidence saved with the run."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "ap.pay"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "ap.pay");
      const orgId = context.authz.user.orgId;
      const scope = context.authz.allowedSubsidiaryIds;
      if (scope && !(await paymentRunBillsInScope(orgId, input.billDocumentIds, scope)))
        throw notFound("record");
      try {
        const run = await createPaymentRun({
          orgId,
          createdBy: context.authz.user.id,
          paymentBankProfileId: input.paymentBankProfileId,
          billDocumentIds: input.billDocumentIds,
          allowedSubsidiaryIds: scope,
          scheduledFor: input.scheduledFor ?? null,
          selectionCriteria: input.selectionCriteria ?? {},
          allowExistingTransaction: true,
        });
        return {
          ok: true,
          runId: run.id,
          runNumber: run.runNumber,
          status: "draft",
          href: paymentHref(run.id),
        };
      } catch (error) {
        settlePaymentError(error);
      }
    },
  }),
  definition({
    name: "submit_payment_run",
    title: "Submit Payment Run",
    description:
      "Submit a non-empty draft payment run into its configured approval flow. Use get_payment_run to confirm it is still a draft and then read it again to see whether it is pending approval or approved.",
    inputSchema: z.object({
      runId: UUID.describe("Draft payment run id from get_payment_run."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: actorCanPay,
    execute: async (context, input) => {
      await paymentRunForActor(context, input.runId);
      try {
        const result = await submitPaymentRun(
          input.runId,
          context.authz.user.orgId,
          context.authz.user.id,
        );
        return { ok: true, runId: input.runId, ...result, href: paymentHref(input.runId) };
      } catch (error) {
        settlePaymentError(error);
      }
    },
  }),
  definition({
    name: "generate_payment_run_file",
    title: "Generate Payment Run File",
    description:
      "Generate the immutable bank file for an approved outbound payment run. Use get_payment_run to check readiness and read the run afterward to verify the file status.",
    inputSchema: z.object({
      runId: UUID.describe("Approved payment run id."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: actorCanPay,
    execute: async (context, input) => {
      await paymentRunForActor(context, input.runId);
      try {
        const file = await generatePaymentFileArtifact(
          input.runId,
          context.authz.user.orgId,
          context.authz.user.id,
          { allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds },
        );
        const status = await paymentFileStatus(context.authz.user.orgId, file.id);
        return {
          ok: true,
          runId: input.runId,
          fileId: file.id,
          filename: file.filename,
          status,
          href: paymentHref(input.runId),
        };
      } catch (error) {
        settlePaymentError(error);
      }
    },
  }),
  definition({
    name: "reprocess_payment_run_file",
    title: "Reprocess Payment Run File",
    description:
      "Generate a replacement artifact for a failed or otherwise unusable payment-run file while preserving its prior delivery history. Use get_payment_run to find the run and file ids before retrying.",
    inputSchema: z.object({
      runId: UUID.describe("Payment run id from get_payment_run."),
      fileId: UUID.describe("Existing failed or unusable file id from get_payment_run."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: actorCanPay,
    execute: async (context, input) => {
      await paymentRunForActor(context, input.runId);
      try {
        const file = await generatePaymentFileArtifact(
          input.runId,
          context.authz.user.orgId,
          context.authz.user.id,
          {
            reprocessFileId: input.fileId,
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          },
        );
        return {
          ok: true,
          runId: input.runId,
          fileId: file.id,
          filename: file.filename,
          status: await paymentFileStatus(context.authz.user.orgId, file.id),
          href: paymentHref(input.runId),
        };
      } catch (error) {
        settlePaymentError(error);
      }
    },
  }),
  definition({
    name: "deliver_payment_run_file",
    title: "Deliver Payment Run File",
    description:
      "Send an approved payment file to its configured SFTP destination. Use get_payment_run to verify the run and destination first; delivery contacts an external bank endpoint.",
    inputSchema: z.object({
      runId: UUID.describe("Approved payment run id."),
      sftpServerId: UUID.describe("Active SFTP server id shown for the run."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: actorCanPay,
    execute: async (context, input) => {
      await paymentRunForActor(context, input.runId);
      try {
        const delivery = await runOutsideTenantTransaction(context, () =>
          deliverRunToSftp(
            input.runId,
            input.sftpServerId,
            context.authz.user.orgId,
            context.authz.user.id,
            new Date(),
          ),
        );
        return {
          ok: true,
          runId: input.runId,
          ...delivery,
          status: "delivered",
          href: paymentHref(input.runId),
        };
      } catch (error) {
        settlePaymentError(error);
      }
    },
  }),
  definition({
    name: "post_payment_run",
    title: "Post Payment Run",
    description:
      "Post every payment instruction in an approved run through the payment posting engine. Use get_payment_run to review run readiness and read it again to inspect any instruction refusals.",
    inputSchema: z.object({
      runId: UUID.describe("Approved payment run id."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: actorCanPay,
    execute: async (context, input) => {
      await paymentRunForActor(context, input.runId);
      try {
        const result = await postPaymentRun(
          input.runId,
          context.authz.user.orgId,
          context.authz.user.id,
        );
        return {
          ok: result.failures.length === 0,
          runId: input.runId,
          ...result,
          href: paymentHref(input.runId),
        };
      } catch (error) {
        settlePaymentError(error);
      }
    },
  }),
  definition({
    name: "cancel_payment_run",
    title: "Cancel Payment Run",
    description:
      "Cancel a draft or exported run with a recorded reason while preserving its audit history. Use get_payment_run to verify the run is not already approved or delivered.",
    inputSchema: z.object({
      runId: UUID.describe("Draft or exported payment run id."),
      reason: z.string().trim().min(1).max(1000).describe("Why this run is being cancelled."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: actorCanPay,
    execute: async (context, input) => {
      await paymentRunForActor(context, input.runId);
      try {
        await cancelPaymentRun(
          input.runId,
          context.authz.user.orgId,
          context.authz.user.id,
          input.reason,
        );
        return {
          ok: true,
          runId: input.runId,
          status: "cancelled",
          href: paymentHref(input.runId),
        };
      } catch (error) {
        settlePaymentError(error);
      }
    },
  }),
  definition({
    name: "rollback_payment_run",
    title: "Roll Back Payment Run",
    description:
      "Roll back an approved or generated run when its instructions have not been paid. If a file reached the bank, include the run number as an explicit non-processing attestation; use get_payment_run first.",
    inputSchema: z.object({
      runId: UUID.describe("Approved, generated, or delivered payment run id."),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(1000)
        .describe("Reason for releasing this run's reserved bills."),
      bankNotProcessedAttestation: z
        .string()
        .max(100)
        .optional()
        .describe(
          "Run number typed back only after confirming with the bank that it will not process the delivered file.",
        ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: actorCanPay,
    execute: async (context, input) => {
      await paymentRunForActor(context, input.runId);
      try {
        await rollbackPaymentRun(
          input.runId,
          context.authz.user.orgId,
          context.authz.user.id,
          input.reason,
          { bankNotProcessedAttestation: input.bankNotProcessedAttestation ?? null },
        );
        return {
          ok: true,
          runId: input.runId,
          status: "rolled_back",
          href: paymentHref(input.runId),
        };
      } catch (error) {
        settlePaymentError(error);
      }
    },
  }),
  definition({
    name: "record_payment_instruction_settlement",
    title: "Record Payment Instruction Settlement",
    description:
      "Record a bank settlement, return, or rejection for an instruction in a payment run. Use get_payment_run to find instruction ids and confirm the bank's effective date and reference.",
    inputSchema: z.object({
      runId: UUID.describe("Payment run containing the instruction."),
      instructionId: UUID.describe("Instruction id from get_payment_run."),
      status: z.enum(["settled", "returned", "rejected"]).describe("Bank outcome."),
      effectiveOn: DATE,
      bankReference: z
        .string()
        .nullable()
        .optional()
        .describe("Statement or bank reference, when supplied."),
      returnCode: z
        .string()
        .nullable()
        .optional()
        .describe("Bank return code, for a return or rejection."),
      returnReason: z
        .string()
        .nullable()
        .optional()
        .describe("Required reason for a returned or rejected instruction."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: actorCanPay,
    execute: async (context, input) => {
      await paymentRunForActor(context, input.runId);
      if (
        !(await paymentInstructionInRun(context.authz.user.orgId, input.runId, input.instructionId))
      )
        throw notFound("payment instruction");
      if (input.status !== "settled" && !input.returnReason?.trim())
        throw invalidInput("a return reason is required");
      try {
        await recordPaymentSettlement({
          instructionId: input.instructionId,
          orgId: context.authz.user.orgId,
          userId: context.authz.user.id,
          status: input.status,
          effectiveOn: input.effectiveOn,
          bankReference: input.bankReference ?? null,
          returnCode: input.returnCode ?? null,
          returnReason: input.returnReason ?? null,
        });
        return {
          ok: true,
          runId: input.runId,
          instructionId: input.instructionId,
          status: input.status,
          href: paymentHref(input.runId),
        };
      } catch (error) {
        settlePaymentError(error);
      }
    },
  }),
  definition({
    name: "resolve_payment_file_delivery",
    title: "Resolve Payment File Delivery",
    description:
      "Resolve a delivery_uncertain file after checking with the bank: mark delivered if received, or return it to approved only after confirming it was not received. Use get_payment_run to obtain the file id and preserve the verification reason.",
    inputSchema: z.object({
      runId: UUID.describe("Payment run containing the file."),
      fileId: UUID.describe("Uncertain payment file id."),
      outcome: z
        .enum(["delivered", "approved"])
        .describe("Set delivered when the bank received it; approved when it did not."),
      reason: z
        .string()
        .trim()
        .min(5)
        .max(1000)
        .describe("Bank confirmation and resolution reason."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: actorCanPay,
    execute: async (context, input) => {
      await paymentRunForActor(context, input.runId);
      try {
        await resolveUncertainDelivery({
          fileId: input.fileId,
          orgId: context.authz.user.orgId,
          userId: context.authz.user.id,
          outcome: input.outcome,
          reason: input.reason,
          runId: input.runId,
        });
        return {
          ok: true,
          runId: input.runId,
          fileId: input.fileId,
          status: input.outcome,
          href: paymentHref(input.runId),
        };
      } catch (error) {
        settlePaymentError(error);
      }
    },
  }),
  definition({
    name: "apply_open_credits",
    title: "Apply Open Credits",
    description:
      "Settle posted credit memos or unapplied payment balances against open items without recording cash. Use credit_items_for_party and list_open_items to obtain the party, line and source document ids; the date must not predate either posting.",
    inputSchema: z.object({
      partyId: UUID.describe("Party id from a payment or credit read."),
      side: z.enum(["ap", "ar"]).describe("AP vendor credits or AR customer credits."),
      appliedOn: DATE,
      credits: z
        .array(creditInput)
        .min(1)
        .max(1000)
        .describe("Exact credit-to-open-item allocations."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: actorCanPay,
    execute: async (context, input) => {
      assertApplicationPermission(context, input.side === "ap" ? "ap.pay" : "ar.pay");
      const party = await paymentPartyScope(context.authz.user.orgId, input.partyId);
      if (!party) throw notFound("party");
      if (
        party.subsidiaryId &&
        context.authz.allowedSubsidiaryIds &&
        !context.authz.allowedSubsidiaryIds.has(party.subsidiaryId)
      )
        throw notFound("party");
      try {
        const result = await applyStandaloneCredits(
          context.authz.user.orgId,
          context.authz.user.id,
          {
            partyId: input.partyId,
            side: input.side,
            appliedOn: input.appliedOn,
            credits: input.credits,
            idempotencyKey: input.idempotencyKey,
          },
          context.authz.allowedSubsidiaryIds,
        );
        return {
          ok: true,
          ...result,
          status: "applied",
          href: input.side === "ar" ? "/receivables" : "/payables",
        };
      } catch (error) {
        settlePaymentError(error);
      }
    },
  }),
  definition({
    name: "unapply_open_credit",
    title: "Unapply Open Credit",
    description:
      "Release a live credit settlement so both balances reopen; cash applications are refused because the payment's own void workflow controls them. Use get_credit_application_state to find the settlement id and side.",
    inputSchema: z.object({
      applicationId: UUID.describe("Live credit settlement id."),
      side: z.enum(["ap", "ar"]).describe("The side owning the credit settlement."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: actorCanPay,
    execute: async (context, input) => {
      assertApplicationPermission(context, input.side === "ap" ? "ap.pay" : "ar.pay");
      const row = await creditApplicationSettlementScope(
        context.authz.user.orgId,
        input.applicationId,
      );
      const side =
        row?.kind === "vendor_credit" || row?.kind === "vendor_payment"
          ? "ap"
          : row?.kind === "customer_credit" || row?.kind === "customer_payment"
            ? "ar"
            : null;
      if (!row || side !== input.side) throw notFound("credit settlement");
      if (row.partyId) {
        const party = await paymentPartyScope(context.authz.user.orgId, row.partyId);
        if (!party) throw notFound("party");
        if (
          party.subsidiaryId &&
          context.authz.allowedSubsidiaryIds &&
          !context.authz.allowedSubsidiaryIds.has(party.subsidiaryId)
        )
          throw notFound("party");
      }
      try {
        const result = await unapplyCreditSettlement(
          context.authz.user.orgId,
          context.authz.user.id,
          input.applicationId,
          context.authz.allowedSubsidiaryIds,
        );
        return {
          ok: true,
          applicationId: input.applicationId,
          ...result,
          status: "unapplied",
          href: input.side === "ar" ? "/receivables" : "/payables",
        };
      } catch (error) {
        settlePaymentError(error);
      }
    },
  }),
  definition({
    name: "write_off_invoice_balance",
    title: "Write Off Invoice Balance",
    description:
      "Write off an uncollectible portion of a posted customer invoice through the native AR credit and settlement path. Use get_document to verify the invoice and current open balance; include a reason and a date in an open period.",
    inputSchema: z.object({
      invoiceId: UUID.describe("Posted customer invoice id."),
      amount: MONEY,
      date: DATE,
      reason: z.string().trim().min(1).max(500).describe("Why this balance is uncollectible."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "ar.create") && can(authz, "ar.post") && can(authz, "ar.pay"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "ar.create");
      assertApplicationPermission(context, "ar.post");
      assertApplicationPermission(context, "ar.pay");
      try {
        const result = await writeOffInvoice(
          context.authz.user.orgId,
          context.authz.user.id,
          input,
          context.authz.allowedSubsidiaryIds,
        );
        return { ok: true, ...result, href: `/invoices/${input.invoiceId}` };
      } catch (error) {
        settlePaymentError(error);
      }
    },
  }),
  definition({
    name: "create_payment_link",
    title: "Create Payment Link",
    description:
      "Create a hosted payment link for a posted customer invoice using an enabled payment provider. Use get_document to verify invoice identity and scope; creating the link contacts the external payment provider.",
    inputSchema: z.object({
      documentId: UUID.describe("Posted customer invoice id."),
      provider: z
        .enum(["stripe", "adyen", "gocardless"])
        .describe("Enabled online payment provider."),
      bankAccountId: UUID.nullable()
        .optional()
        .describe("Optional provider clearing bank account."),
      expiresOn: DATE.nullable().optional(),
      memo: z
        .string()
        .max(1000)
        .nullable()
        .optional()
        .describe("Optional memo displayed on the hosted payment page."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "ar.create"),
    featureKey: "onlinePayments",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "ar.create", "onlinePayments");
      const invoice = await paymentLinkDocumentScope(context.authz.user.orgId, input.documentId);
      if (!invoice) throw notFound("record");
      assertSubsidiaryAccess(context, invoice.subsidiaryId);
      try {
        const link = await runOutsideTenantTransaction(context, () =>
          createPaymentLink(
            context.authz.user.orgId,
            context.authz.user.id,
            {
              documentId: input.documentId,
              provider: input.provider,
              bankAccountId: input.bankAccountId ?? null,
              expiresOn: input.expiresOn ?? null,
              memo: input.memo ?? null,
            },
            context.authz.allowedSubsidiaryIds,
          ),
        );
        return {
          ok: true,
          linkId: link.id,
          ...link,
          href: `/invoices/${input.documentId}`,
        };
      } catch (error) {
        settlePaymentError(error);
      }
    },
  }),
  definition({
    name: "void_payment_link",
    title: "Void Payment Link",
    description:
      "Void a hosted payment link so its bearer token can no longer collect funds. Use the invoice's payment-link read to find the link id and confirm it is not already paid.",
    inputSchema: z.object({
      linkId: UUID.describe("Payment link id from the invoice's payment-link read."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "ar.create"),
    featureKey: "onlinePayments",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "ar.create", "onlinePayments");
      const link = await paymentLinkScope(context.authz.user.orgId, input.linkId);
      if (!link) throw notFound("record");
      assertSubsidiaryAccess(context, link.subsidiaryId);
      try {
        await runOutsideTenantTransaction(context, () =>
          voidPaymentLink(
            context.authz.user.orgId,
            context.authz.user.id,
            input.linkId,
            context.authz.allowedSubsidiaryIds,
          ),
        );
        return { ok: true, linkId: input.linkId, status: "voided", href: "/invoices" };
      } catch (error) {
        settlePaymentError(error);
      }
    },
  }),
  definition({
    name: "retry_payment_posting_effect",
    title: "Retry Payment Posting Effect",
    description:
      "Retry a failed downstream posting effect for a posted payment without changing its journal or applications. Use get_document to verify payment status and provide the operator's reason; the command requires Banking and the payment's AP or AR permission.",
    inputSchema: z.object({
      paymentId: UUID.describe("Posted vendor payment or customer receipt id."),
      reason: z
        .string()
        .trim()
        .min(10)
        .max(1000)
        .describe("Why the downstream effect is being retried."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: actorCanPay,
    featureKey: "banking",
    execute: async (context, input) => {
      if (!actorCanPay(context.authz)) throw notFound("record");
      await assertTreasuryGate(
        context,
        can(context.authz, "ap.pay") ? "ap.pay" : "ar.pay",
        "banking",
      );
      const payment = await paymentDocumentScope(context.authz.user.orgId, input.paymentId);
      if (!payment) throw notFound("record");
      assertApplicationPermission(context, payment.kind === "vendor_payment" ? "ap.pay" : "ar.pay");
      assertSubsidiaryAccess(context, payment.subsidiaryId);
      try {
        const result = await replayPaymentPostingEffect({
          orgId: context.authz.user.orgId,
          paymentId: input.paymentId,
          paymentKind: payment.kind,
          actorId: context.authz.user.id,
          reason: input.reason,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        if (!result) throw notFound("record");
        return {
          ok: true,
          paymentId: input.paymentId,
          ...result,
          href: `/payments?payment=${encodeURIComponent(input.paymentId)}`,
        };
      } catch (error) {
        settlePaymentError(error);
      }
    },
  }),
];
