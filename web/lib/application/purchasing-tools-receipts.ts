import "server-only";
import { z } from "zod";
import { createDirectDebitRun } from "@openbooks/engine/payments/direct-debit";
import { PaymentError } from "@openbooks/engine/payments-core/payment-errors";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { can } from "../authz";
import { invalidInput } from "./errors";
import { assertApplicationPermission } from "./context";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from an active bank profile or customer invoice.");
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date (YYYY-MM-DD).");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

export const PURCHASING_RECEIPT_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "create_direct_debit_run",
    title: "Create Direct Debit Run",
    description:
      "Prepare a draft collection run from posted customer invoices with active debit mandates and one matching bank profile. Find eligible invoice ids with list_open_items and profile ids with list_setup_records for payment_bank_profiles.",
    inputSchema: z.object({
      paymentBankProfileId: UUID,
      invoiceDocumentIds: z
        .array(UUID)
        .min(1)
        .max(500)
        .describe("Posted customer invoices to collect."),
      scheduledFor: DATE.nullable()
        .optional()
        .describe("Optional collection date; omitted uses business today."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "ar.pay"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "ar.pay");
      try {
        const run = await createDirectDebitRun({
          orgId: context.authz.user.orgId,
          createdBy: context.authz.user.id,
          paymentBankProfileId: input.paymentBankProfileId,
          invoiceDocumentIds: input.invoiceDocumentIds,
          scheduledFor: input.scheduledFor,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return {
          ok: true,
          ...run,
          status: "draft",
          href: `/receipts?view=runs&run=${run.id}`,
        };
      } catch (error) {
        if (error instanceof PaymentError) throw invalidInput(error.message);
        throw error;
      }
    },
  }),
];
