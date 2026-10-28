import "server-only";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { isValidEmailAddress } from "@openbooks/emails";
import { db } from "@openbooks/engine/platform/database";
import { subsidiaryScopeAllows } from "@openbooks/engine/organization/scope";
import { can } from "../authz";
import {
  AutopayError,
  appBaseUrl,
  cancelEnrollment,
  enrollAutopay,
  listPaymentMethods,
  markExpiryOutreachSent,
  pauseEnrollment,
  removeMethod,
  resumeEnrollment,
  retryAttemptNow,
  runAutopayCollectionForOrg,
  saveAutopayPolicy,
  setDefaultMethod,
  setMethodFallbackPriority,
  startMethodSetup,
} from "@openbooks/engine/payments/autopay";
import {
  deriveEmailDeliveryKey,
  emailDeliveryBlockedMessage,
  paymentMethodSetupEmail,
  sendVia,
  type EmailTransport,
} from "@openbooks/emails";
import {
  insertEmailLog,
  markEmailFailed,
  markEmailSent,
  markEmailUncertain,
  resolveOrgEmailTransportDetailed,
} from "@openbooks/engine/delivery/email-config";
import { setupCurrencyAvailable, setupCustomerName, setupRecipients } from "../autopay-setup-link";
import { readOrgName } from "../record-scope-reads";
import type { ApplicationContext } from "./context";
import { invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import {
  assertTreasuryGate,
  assertUnrestricted,
  DATE,
  IDEMPOTENCY_KEY,
  runOutsideTenantTransaction,
  settleDomainRefusal,
  UUID,
} from "./treasury-tools-common";

function settleAutopayError(error: unknown): never {
  if (error instanceof AutopayError) settleDomainRefusal(error, 422);
  throw error;
}

async function assertPartyScope(context: ApplicationContext, partyId: string): Promise<void> {
  const allowed = context.authz.allowedSubsidiaryIds;
  if (allowed === null) return;
  const party = (
    await db.execute<{ subsidiaryId: string | null }>(
      sql`
      select subsidiary_id as "subsidiaryId" from parties
       where org_id = ${context.authz.user.orgId} and id = ${partyId}
    `,
      "objects",
    )
  )[0];
  if (!party || !subsidiaryScopeAllows(allowed, party.subsidiaryId, { orgWideNull: true }))
    throw notFound("record");
}

async function assertMethodScope(context: ApplicationContext, methodId: string): Promise<void> {
  const allowed = context.authz.allowedSubsidiaryIds;
  if (allowed === null) return;
  const party = (
    await db.execute<{ subsidiaryId: string | null }>(
      sql`
      select p.subsidiary_id as "subsidiaryId"
        from customer_payment_methods m join parties p on p.org_id = m.org_id and p.id = m.party_id
       where m.org_id = ${context.authz.user.orgId} and m.id = ${methodId}
    `,
      "objects",
    )
  )[0];
  if (!party || !subsidiaryScopeAllows(allowed, party.subsidiaryId, { orgWideNull: true }))
    throw notFound("record");
}

async function assertEnrollmentScope(
  context: ApplicationContext,
  enrollmentId: string,
): Promise<void> {
  const allowed = context.authz.allowedSubsidiaryIds;
  if (allowed === null) return;
  const party = (
    await db.execute<{ subsidiaryId: string | null }>(
      sql`
      select p.subsidiary_id as "subsidiaryId"
        from autopay_enrollments e join parties p on p.org_id = e.org_id and p.id = e.party_id
       where e.org_id = ${context.authz.user.orgId} and e.id = ${enrollmentId}
    `,
      "objects",
    )
  )[0];
  if (!party || !subsidiaryScopeAllows(allowed, party.subsidiaryId, { orgWideNull: true }))
    throw notFound("record");
}

async function assertAttemptScope(context: ApplicationContext, attemptId: string): Promise<void> {
  const row = (
    await db.execute<{ invoiceSubsidiaryId: string | null; partySubsidiaryId: string | null }>(
      sql`
      select d.subsidiary_id as "invoiceSubsidiaryId", p.subsidiary_id as "partySubsidiaryId"
        from collection_attempts a
        join autopay_enrollments e on e.org_id = a.org_id and e.id = a.enrollment_id
        join parties p on p.org_id = e.org_id and p.id = e.party_id
        join documents d on d.org_id = a.org_id and d.id = a.invoice_id and d.party_id = p.id
       where a.org_id = ${context.authz.user.orgId} and a.id = ${attemptId}
    `,
      "objects",
    )
  )[0];
  const allowed = context.authz.allowedSubsidiaryIds;
  if (
    !row ||
    !row.invoiceSubsidiaryId ||
    (allowed !== null &&
      (!allowed.has(row.invoiceSubsidiaryId) ||
        !subsidiaryScopeAllows(allowed, row.partySubsidiaryId, { orgWideNull: true })))
  )
    throw notFound("record");
}

export const TREASURY_AUTOPAY_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_customer_payment_methods",
    title: "List Customer Payment Methods",
    description:
      "List non-removed stored payment methods for a customer, including default status and masked provider details. Use a customer id from find_parties; subsidiary scope is enforced before any method data is returned.",
    inputSchema: z.object({ partyId: UUID.describe("Customer party id from find_parties.") }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "payment_methods.read"),
    featureKey: "autopay",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "payment_methods.read", "autopay");
      await assertPartyScope(context, input.partyId);
      try {
        return { methods: await listPaymentMethods(context.authz.user.orgId, input.partyId) };
      } catch (error) {
        settleAutopayError(error);
      }
    },
  }),
  definition({
    name: "create_customer_payment_method_setup",
    title: "Create Customer Payment Method Setup",
    description:
      "Create a hosted provider session so a customer can add a stored payment method; the session remains pending until the provider confirms setup. Use the customer id from find_parties and pass a currency enabled for that customer's legal entity.",
    inputSchema: z.object({
      partyId: UUID.describe("Customer party id from find_parties."),
      provider: z
        .enum(["stripe", "adyen", "gocardless"])
        .describe("Enabled online payment provider."),
      currency: z
        .string()
        .regex(/^[A-Za-z]{3}$/)
        .describe("Three-letter currency enabled for the customer."),
      recipientEmail: z
        .string()
        .trim()
        .max(320)
        .refine(isValidEmailAddress)
        .optional()
        .describe("Optional email already recorded on this customer or an active contact."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "payment_methods.manage"),
    featureKey: "autopay",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "payment_methods.manage", "autopay");
      await assertPartyScope(context, input.partyId);
      const orgId = context.authz.user.orgId;
      const currency = input.currency.toUpperCase();
      if (!(await setupCurrencyAvailable(orgId, input.partyId, currency)))
        throw invalidInput(
          `${currency} is not enabled for this customer; choose an available currency or enable Multi-currency in Company Settings → Features`,
        );
      let recipient: string | null = null;
      let transport: EmailTransport | null = null;
      if (input.recipientEmail) {
        const match = (await setupRecipients(orgId, input.partyId)).find(
          (row) => row.email.toLowerCase() === input.recipientEmail!.toLowerCase(),
        );
        if (!match)
          throw invalidInput(
            "that address is not on this customer; add it to the customer as a contact first",
          );
        const state = await resolveOrgEmailTransportDetailed(orgId);
        if (state.state !== "ready")
          throw invalidInput(
            `${emailDeliveryBlockedMessage(state)} Or omit recipientEmail and share the setup link yourself.`,
          );
        transport = state.transport;
        recipient = match.email;
      }
      const setupToken = randomBytes(32).toString("hex");
      try {
        const result = await runOutsideTenantTransaction(context, async () => {
          const session = await startMethodSetup(orgId, {
            partyId: input.partyId,
            provider: input.provider,
            currency,
            returnUrl: `${appBaseUrl()}/pay/setup/${setupToken}/return`,
            setupToken,
            actorId: context.authz.user.id,
          });
          const setupUrl = `/pay/setup/${setupToken}`;
          let delivery: { status: "sent" | "uncertain" | "failed"; recipient: string } | null =
            null;
          if (recipient && transport) {
            const mail = paymentMethodSetupEmail({
              orgName: await readOrgName(orgId),
              customerName: (await setupCustomerName(orgId, input.partyId)) ?? "",
              linkUrl: `${appBaseUrl()}${setupUrl}`,
            });
            const logId = await insertEmailLog({
              orgId,
              recipients: [recipient],
              subject: mail.subject,
              status: "queued",
              categoryKey: "autopay",
              meta: {
                event: "payment_method_setup",
                partyId: input.partyId,
                methodId: session.methodId,
              },
              actor: { kind: "user", userId: context.authz.user.id },
            });
            try {
              const outcome = await sendVia(
                transport,
                { to: recipient, subject: mail.subject, html: mail.html, text: mail.text },
                {
                  deliveryKey: deriveEmailDeliveryKey({
                    orgId,
                    scope: `direct:${logId}`,
                    to: recipient,
                  }),
                },
              );
              if (outcome.kind === "sent") {
                await markEmailSent(orgId, logId, outcome.providerMessageId);
                delivery = { status: "sent", recipient };
              } else {
                await markEmailUncertain(orgId, logId, outcome.reason);
                delivery = { status: "uncertain", recipient };
              }
            } catch (error) {
              await markEmailFailed(
                orgId,
                logId,
                error instanceof Error ? error.message : "payment method setup email failed",
              );
              delivery = { status: "failed", recipient };
            }
          }
          return {
            ok: true,
            methodId: session.methodId,
            setupUrl,
            redirectUrl: session.redirectUrl,
            delivery,
            status: "pending",
            href: `/customers/${input.partyId}`,
          };
        });
        return result;
      } catch (error) {
        settleAutopayError(error);
      }
    },
  }),
  definition({
    name: "create_autopay_enrollment",
    title: "Create Autopay Enrollment",
    description:
      "Enroll a customer or one of its subscriptions for automatic collection using an active stored payment method. Use find_parties and the subscription read to choose matching ids; the method must belong to the same customer.",
    inputSchema: z.object({
      partyId: UUID.describe("Customer party id."),
      subscriptionId: UUID.nullable()
        .optional()
        .describe("Optional subscription owned by this customer."),
      paymentMethodId: UUID.nullable()
        .optional()
        .describe(
          "Optional active method belonging to this customer; otherwise the default is used.",
        ),
      chargeOnIssue: z
        .boolean()
        .optional()
        .describe(
          "Charge an eligible invoice from its issue date instead of waiting for the due date.",
        ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "autopay.manage"),
    featureKey: "autopay",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "autopay.manage", "autopay");
      await assertPartyScope(context, input.partyId);
      try {
        const enrollment = await enrollAutopay(context.authz.user.orgId, {
          partyId: input.partyId,
          subscriptionId: input.subscriptionId ?? null,
          paymentMethodId: input.paymentMethodId ?? null,
          chargeOnIssue: input.chargeOnIssue ?? false,
          actorId: context.authz.user.id,
        });
        return {
          ok: true,
          enrollmentId: enrollment.id,
          status: enrollment.status,
          href: `/customers/${input.partyId}`,
        };
      } catch (error) {
        settleAutopayError(error);
      }
    },
  }),
  definition({
    name: "update_autopay_enrollment",
    title: "Update Autopay Enrollment",
    description:
      "Pause, resume, or cancel an existing autopay enrollment. Use the autopay enrollment read to confirm its customer and current status; cancellation is permanent for this enrollment.",
    inputSchema: z.object({
      enrollmentId: UUID.describe("Autopay enrollment id."),
      status: z.enum(["active", "paused", "canceled"]).describe("New enrollment state."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "autopay.manage"),
    featureKey: "autopay",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "autopay.manage", "autopay");
      await assertEnrollmentScope(context, input.enrollmentId);
      try {
        const orgId = context.authz.user.orgId;
        if (input.status === "paused")
          await pauseEnrollment(orgId, input.enrollmentId, context.authz.user.id);
        else if (input.status === "canceled")
          await cancelEnrollment(orgId, input.enrollmentId, context.authz.user.id);
        else await resumeEnrollment(orgId, input.enrollmentId, context.authz.user.id);
        return {
          ok: true,
          enrollmentId: input.enrollmentId,
          status: input.status,
          href: "/customers",
        };
      } catch (error) {
        settleAutopayError(error);
      }
    },
  }),
  definition({
    name: "set_default_payment_method",
    title: "Set Default Payment Method",
    description:
      "Make one active payment method the customer's default charge target. Use list_customer_payment_methods to find the method id and confirm the customer before changing the default.",
    inputSchema: z.object({
      methodId: UUID.describe("Active stored method id."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "payment_methods.manage"),
    featureKey: "autopay",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "payment_methods.manage", "autopay");
      await assertMethodScope(context, input.methodId);
      try {
        await setDefaultMethod(context.authz.user.orgId, input.methodId, context.authz.user.id);
        return { ok: true, methodId: input.methodId, status: "default", href: "/customers" };
      } catch (error) {
        settleAutopayError(error);
      }
    },
  }),
  definition({
    name: "set_payment_method_fallback_priority",
    title: "Set Payment Method Fallback Priority",
    description:
      "Set a stored method's backup order when autopay falls back from the default. Use list_customer_payment_methods to review the customer's current fallback chain.",
    inputSchema: z.object({
      methodId: UUID.describe("Stored method id."),
      fallbackPriority: z
        .number()
        .int()
        .min(0)
        .max(999)
        .describe("Lower values are tried earlier in the backup chain."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "payment_methods.manage"),
    featureKey: "autopay",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "payment_methods.manage", "autopay");
      await assertMethodScope(context, input.methodId);
      try {
        await setMethodFallbackPriority(
          context.authz.user.orgId,
          input.methodId,
          input.fallbackPriority,
          context.authz.user.id,
        );
        return {
          ok: true,
          methodId: input.methodId,
          fallbackPriority: input.fallbackPriority,
          href: "/customers",
        };
      } catch (error) {
        settleAutopayError(error);
      }
    },
  }),
  definition({
    name: "remove_customer_payment_method",
    title: "Remove Customer Payment Method",
    description:
      "Remove a stored payment method and detach it at its provider. Use list_customer_payment_methods to confirm the method is no longer needed by an active enrollment; this contacts the external provider.",
    inputSchema: z.object({
      methodId: UUID.describe("Stored payment method id."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "payment_methods.manage"),
    featureKey: "autopay",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "payment_methods.manage", "autopay");
      await assertMethodScope(context, input.methodId);
      try {
        await runOutsideTenantTransaction(context, () =>
          removeMethod(context.authz.user.orgId, input.methodId, context.authz.user.id),
        );
        return { ok: true, methodId: input.methodId, status: "removed", href: "/customers" };
      } catch (error) {
        settleAutopayError(error);
      }
    },
  }),
  definition({
    name: "retry_autopay_collection",
    title: "Retry Autopay Collection",
    description:
      "Retry a failed soft-decline collection immediately instead of waiting for the scheduled retry. Use the collection attempt read to find the id; hard declines refuse and require a new customer payment method. This contacts the payment provider.",
    inputSchema: z.object({
      attemptId: UUID.describe("Failed collection attempt id."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "autopay.manage"),
    featureKey: "autopay",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "autopay.manage", "autopay");
      await assertAttemptScope(context, input.attemptId);
      try {
        const result = await runOutsideTenantTransaction(context, () =>
          retryAttemptNow(
            context.authz.user.orgId,
            input.attemptId,
            context.authz.user.id,
            context.authz.allowedSubsidiaryIds,
          ),
        );
        return {
          ok: result.orgErrors.length === 0,
          attemptId: input.attemptId,
          ...result,
          href: "/collections",
        };
      } catch (error) {
        settleAutopayError(error);
      }
    },
  }),
  definition({
    name: "run_autopay_collection",
    title: "Run Autopay Collection",
    description:
      "Run one organization's due autopay collection scan, including recovery of interrupted attempts. This contacts payment providers and may create and post receipts; review the collections worklist and active enrollments first.",
    inputSchema: z.object({
      asOf: DATE.optional().describe(
        "Optional organization business date used for a controlled collection run.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "autopay.manage") && authz.allowedSubsidiaryIds === null,
    featureKey: "autopay",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "autopay.manage", "autopay");
      assertUnrestricted(context);
      try {
        const result = await runOutsideTenantTransaction(context, () =>
          runAutopayCollectionForOrg(
            context.authz.user.orgId,
            input.asOf ? { asOf: input.asOf } : undefined,
          ),
        );
        return {
          ok: result.orgErrors.length === 0,
          ...result,
          status: "completed",
          href: "/collections",
        };
      } catch (error) {
        settleAutopayError(error);
      }
    },
  }),
  definition({
    name: "record_payment_method_expiry_outreach",
    title: "Record Payment Method Expiry Outreach",
    description:
      "Record that a customer was contacted about an expiring stored card so it leaves the outreach queue. Use list_customer_payment_methods to verify the method and pass the actual date outreach was sent.",
    inputSchema: z.object({
      methodId: UUID.describe("Expiring stored method id."),
      sentOn: DATE.optional().describe(
        "Date outreach was sent; defaults to the organization's business date.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "payment_methods.manage"),
    featureKey: "autopay",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "payment_methods.manage", "autopay");
      await assertMethodScope(context, input.methodId);
      try {
        const sentOn =
          input.sentOn ??
          (await (
            await import("@openbooks/engine/platform/business-date/module")
          ).businessToday(context.authz.user.orgId));
        await markExpiryOutreachSent(
          context.authz.user.orgId,
          [input.methodId],
          sentOn,
          context.authz.allowedSubsidiaryIds,
          context.authz.user.id,
        );
        return {
          ok: true,
          methodId: input.methodId,
          sentOn,
          status: "recorded",
          href: "/customers",
        };
      } catch (error) {
        settleAutopayError(error);
      }
    },
  }),
  definition({
    name: "update_autopay_policy",
    title: "Update Autopay Policy",
    description:
      "Update the active customer collection policy's retry cadence, insufficient-funds schedule, expiry notice window, or final action. The policy is organization-wide, so only unrestricted setup administrators may change it.",
    inputSchema: z.object({
      policyId: UUID.describe("Customer collection policy id."),
      retryOffsetsDays: z
        .array(z.number().int().min(0).max(365))
        .min(1)
        .max(8)
        .describe("Retry day offsets for soft declines."),
      insufficientFundsOffsetsDays: z
        .array(z.number().int().min(0).max(365))
        .max(8)
        .optional()
        .describe("Retry day offsets for insufficient-funds declines."),
      expiryNoticeDays: z
        .number()
        .int()
        .min(1)
        .max(90)
        .optional()
        .describe("Days before card expiry to notify."),
      finalAction: z
        .enum(["none", "suspend", "cancel"])
        .describe("Action after retries are exhausted."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "autopay.manage") && authz.allowedSubsidiaryIds === null,
    featureKey: "autopay",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "autopay.manage", "autopay");
      assertUnrestricted(context);
      try {
        const policy = await saveAutopayPolicy(context.authz.user.orgId, {
          policyId: input.policyId,
          retryOffsetsDays: input.retryOffsetsDays,
          insufficientFundsOffsetsDays: input.insufficientFundsOffsetsDays,
          expiryNoticeDays: input.expiryNoticeDays,
          finalAction: input.finalAction,
          actorId: context.authz.user.id,
        });
        return { ok: true, policy, href: "/admin/setup?tab=collections" };
      } catch (error) {
        settleAutopayError(error);
      }
    },
  }),
];
