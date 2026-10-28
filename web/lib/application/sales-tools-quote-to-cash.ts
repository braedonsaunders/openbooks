import "server-only";
import { z } from "zod";
import { can } from "../authz";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import {
  activateQuote,
  deleteQuoteTerm,
  quoteCashPreview,
  saveQuoteTerm,
} from "@openbooks/engine/billing/quote-to-cash";
import { listActiveSubscriptionPlans } from "@openbooks/engine/billing/quote-to-cash-read";
import {
  sendQuoteSignatureRequest,
  voidQuoteSignatureRequest,
} from "../quote-to-cash/signature-actions";
import { assertApplicationPermission } from "./context";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { listRecordDrawerHref } from "../cross-module-drawer-links";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from a quote, quote line, subscription plan, or subscription read.");
const KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date in YYYY-MM-DD format.");
const DECIMAL = z
  .string()
  .min(1)
  .max(40)
  .describe("Exact decimal quantity, price, or percentage as text.");
const visible = (permission: string) => (authz: Parameters<typeof can>[0]) =>
  can(authz, permission);

function settleQuoteCash(error: unknown): never {
  if (error instanceof Error && "status" in error && typeof error.status === "number") {
    const details: Record<string, unknown> = {};
    if ("code" in error && typeof error.code === "string") details.code = error.code;
    if ("remedy" in error && typeof error.remedy === "string") details.remedy = error.remedy;
    if (error.status === 404) throw notFound(error.message);
    if (error.status === 409) throw conflict(error.message, details);
    if (error.status === 403) throw new ApplicationError("forbidden", error.message, 403, details);
    throw invalidInput(error.message, details);
  }
  throw error;
}

export const SALES_QUOTE_TO_CASH_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "preview_quote_cash_terms",
    title: "Preview Quote Cash Terms",
    description:
      "Read the quote's subscription terms, signature status, and valued subscription preview before activation or signature. Find the quote id with get_record.",
    inputSchema: z.object({ quoteId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "quoteToCash",
    visibleTo: visible("estimates.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "estimates.read");
      try {
        const preview = await quoteCashPreview(
          context.authz.user.orgId,
          input.quoteId,
          context.authz.allowedSubsidiaryIds,
        );
        return { ok: true, ...preview, href: listRecordDrawerHref("quote", input.quoteId) };
      } catch (error) {
        settleQuoteCash(error);
      }
    },
  }),
  definition({
    name: "list_quote_subscription_plans",
    title: "List Quote Subscription Plans",
    description:
      "List active subscription plans available when adding recurring terms to a quote. Use a returned plan id in save_quote_subscription_term.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "quoteToCash",
    visibleTo: visible("ar.read"),
    execute: async (context) => {
      assertApplicationPermission(context, "ar.read");
      try {
        return {
          ok: true,
          plans: await listActiveSubscriptionPlans(context.authz.user.orgId),
          href: "/collections",
        };
      } catch (error) {
        settleQuoteCash(error);
      }
    },
  }),
  definition({
    name: "activate_quote_subscriptions",
    title: "Activate Quote Subscriptions",
    description:
      "Activate an eligible signed quote into its billed subscriptions and revenue contract. Preview its terms first with preview_quote_cash_terms.",
    inputSchema: z.object({
      quoteId: UUID,
      startOn: DATE.nullable().optional().describe("Optional subscription start date override."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "quoteToCash",
    visibleTo: visible("ar.create"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "ar.create");
      try {
        const result = await activateQuote(
          context.authz.user.orgId,
          context.authz.user.id,
          input.quoteId,
          { startOn: input.startOn, allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds },
        );
        return { ok: true, ...result, href: listRecordDrawerHref("quote", input.quoteId) };
      } catch (error) {
        settleQuoteCash(error);
      }
    },
  }),
  definition({
    name: "save_quote_subscription_term",
    title: "Save Quote Subscription Term",
    description:
      "Create or update recurring billing terms on a quote line, including co-terming and ramp steps. Find quote and line ids with get_record and plan ids with list_subscription_plans.",
    inputSchema: z.object({
      quoteId: UUID,
      termId: UUID.nullable().optional().describe("Existing term id when replacing a quote term."),
      quoteLineId: UUID,
      planId: UUID,
      planVersionId: UUID.nullable().optional().describe("Optional fixed plan version UUID."),
      termMonths: z.number().int().describe("Contract term length in months."),
      startRule: z
        .enum(["quote_date", "first_of_next_month", "custom"])
        .nullable()
        .optional()
        .describe("Start-date rule for the subscription."),
      billingTiming: z
        .enum(["advance", "arrears"])
        .nullable()
        .optional()
        .describe("Whether recurring bills are issued in advance or arrears."),
      cotermSubscriptionId: UUID.nullable()
        .optional()
        .describe("Existing subscription UUID to co-term with."),
      steps: z
        .array(
          z.object({
            startsAfterMonths: z
              .number()
              .int()
              .describe("Month offset when this price step begins."),
            unitPrice: DECIMAL.describe("Exact unit price as decimal text."),
            quantity: DECIMAL.describe("Exact subscribed quantity as decimal text."),
            escalatorPercent: DECIMAL.nullable()
              .optional()
              .describe("Optional exact escalation percentage."),
          }),
        )
        .max(500)
        .describe("One or more price and quantity steps over the term."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "quoteToCash",
    visibleTo: visible("estimates.create"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "estimates.create");
      try {
        const { quoteId, idempotencyKey: _key, ...body } = input;
        const result = await saveQuoteTerm(
          context.authz.user.orgId,
          context.authz.user.id,
          quoteId,
          body,
          context.authz.allowedSubsidiaryIds,
        );
        return { ok: true, ...result, href: listRecordDrawerHref("quote", quoteId) };
      } catch (error) {
        settleQuoteCash(error);
      }
    },
  }),
  definition({
    name: "delete_quote_subscription_term",
    title: "Delete Quote Subscription Term",
    description:
      "Remove a saved subscription term from a quote before it is signed or activated. Find the quote and term ids with preview_quote_cash_terms.",
    inputSchema: z.object({ quoteId: UUID, termId: UUID, idempotencyKey: KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "quoteToCash",
    visibleTo: visible("estimates.create"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "estimates.create");
      try {
        const result = await deleteQuoteTerm(
          context.authz.user.orgId,
          context.authz.user.id,
          input.quoteId,
          input.termId,
          context.authz.allowedSubsidiaryIds,
        );
        return { ok: true, ...result, href: listRecordDrawerHref("quote", input.quoteId) };
      } catch (error) {
        settleQuoteCash(error);
      }
    },
  }),
  definition({
    name: "send_quote_for_signature",
    title: "Send Quote For Signature",
    description:
      "Create a signature request and email its link to the named signer when organization email is configured. Use preview_quote_cash_terms to confirm the quote and its recurring value; provide the public OpenBooks origin for the returned sign link.",
    inputSchema: z.object({
      quoteId: UUID,
      signerName: z
        .string()
        .min(1)
        .max(300)
        .describe("Signer name shown in the signature request."),
      signerEmail: z
        .string()
        .max(320)
        .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)
        .describe("Signer email address."),
      expiresInDays: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe("Optional expiry interval in days."),
      publicOrigin: z
        .string()
        .max(2048)
        .regex(/^https?:\/\/[^/\s?#]+$/)
        .describe("Public OpenBooks origin, such as https://erp.example.com."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    featureKey: "quoteToCash",
    visibleTo: visible("estimates.create"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "estimates.create");
      const origin = new URL(input.publicOrigin);
      if (
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash ||
        !["http:", "https:"].includes(origin.protocol)
      )
        throw invalidInput("publicOrigin must be an HTTP(S) origin without a path.");
      try {
        const sent = await sendQuoteSignatureRequest({
          authz: context.authz,
          quoteId: input.quoteId,
          signerName: input.signerName,
          signerEmail: input.signerEmail,
          expiresInDays: input.expiresInDays,
          request: new Request(`${origin.origin}/api/quote-signature-command`),
        });
        return { ok: true, ...sent, href: listRecordDrawerHref("quote", input.quoteId) };
      } catch (error) {
        settleQuoteCash(error);
      }
    },
  }),
  definition({
    name: "cancel_quote_signature_request",
    title: "Cancel Quote Signature Request",
    description:
      "Void all open signature links for a quote so they can no longer be used. Find the quote id with get_record; a replacement request can then be sent.",
    inputSchema: z.object({ quoteId: UUID, idempotencyKey: KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "quoteToCash",
    visibleTo: visible("estimates.create"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "estimates.create");
      try {
        const result = await voidQuoteSignatureRequest(context.authz, input.quoteId);
        return { ok: true, ...result, href: listRecordDrawerHref("quote", input.quoteId) };
      } catch (error) {
        settleQuoteCash(error);
      }
    },
  }),
];
