import "server-only";
import { z } from "zod";
import { can } from "../authz";
import { db } from "@openbooks/engine/platform/db";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import {
  closeSession,
  completePosRefund,
  completePosSale,
  holdCart,
  listHeldCarts,
  listSessions,
  listUsableRegisters,
  openSession,
  quotePosCart,
  readRegisterContext,
  readPosReceipt,
  recordCashMovement,
  resumeHeldCart,
  PosError,
} from "@openbooks/engine/pos";
import { posCountSchema, posQuoteBody, posRefundBody, posSaleBody } from "../api/pos-schemas";
import { emailPosReceipt, posAuthority, posPricing } from "../pos";
import { assertApplicationPermission } from "./context";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { listRecordDrawerHref } from "../cross-module-drawer-links";
import { domainUuidIdempotencyKey } from "./domain-idempotency-key";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from a POS register, session, receipt, item, or party read.");
const KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const EMAIL = z
  .string()
  .max(320)
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)
  .describe("Recipient email address.");
const visible = (permission: string) => (authz: Parameters<typeof can>[0]) =>
  can(authz, permission);

function settlePos(error: unknown): never {
  if (error instanceof PosError) {
    const details = error.remedy
      ? { code: error.code, remedy: error.remedy }
      : { code: error.code };
    if (error.status === 404) throw notFound(error.message);
    if (error.status === 409) throw conflict(error.message, details);
    if (error.status === 403) throw new ApplicationError("forbidden", error.message, 403, details);
    throw invalidInput(error.message, details);
  }
  throw error;
}

export const SALES_POS_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_pos_registers",
    title: "List POS Registers",
    description:
      "List active registers available to the current legal-entity scope. Use a returned register id to open a session or price a cart.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "posRegister",
    visibleTo: visible("pos.sell"),
    execute: async (context) => {
      assertApplicationPermission(context, "pos.sell");
      try {
        return {
          ok: true,
          registers: await listUsableRegisters(
            db,
            context.authz.user.orgId,
            context.authz.allowedSubsidiaryIds,
          ),
          href: "/pos",
        };
      } catch (error) {
        settlePos(error);
      }
    },
  }),
  definition({
    name: "list_pos_sessions",
    title: "List POS Sessions",
    description:
      "Find open or closed drawer sessions by register and business date. Use a session id for sales, cash movements, or closeout.",
    inputSchema: z.object({
      registerId: UUID.optional().describe("Filter by register UUID from list_pos_registers."),
      status: z.enum(["open", "closed"]).optional().describe("Filter to open or closed sessions."),
      from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("First business date, inclusive, in YYYY-MM-DD format."),
      to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Last business date, inclusive, in YYYY-MM-DD format."),
      offset: z
        .number()
        .int()
        .min(0)
        .max(1_000_000)
        .optional()
        .describe("Number of newest sessions to skip."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "posRegister",
    visibleTo: visible("pos.drawer"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "pos.drawer");
      try {
        return {
          ok: true,
          ...(await listSessions(
            db,
            context.authz.user.orgId,
            input,
            context.authz.allowedSubsidiaryIds,
          )),
          href: "/pos/sessions",
        };
      } catch (error) {
        settlePos(error);
      }
    },
  }),
  definition({
    name: "get_pos_register",
    title: "Get POS Register",
    description:
      "Read the register settings and current open session before selling or managing the drawer. Find register ids with list_pos_registers.",
    inputSchema: z.object({ registerId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "posRegister",
    visibleTo: visible("pos.sell"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "pos.sell");
      try {
        return {
          ok: true,
          register: await readRegisterContext(
            db,
            context.authz.user.orgId,
            input.registerId,
            context.authz.allowedSubsidiaryIds,
          ),
          href: `/pos/${input.registerId}`,
        };
      } catch (error) {
        settlePos(error);
      }
    },
  }),
  definition({
    name: "quote_pos_cart",
    title: "Quote POS Cart",
    description:
      "Price a cart with the register's live prices, discounts, and taxes before taking payment. Use list_pos_registers and the POS item search to find ids.",
    inputSchema: posQuoteBody,
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "posRegister",
    visibleTo: visible("pos.sell"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "pos.sell");
      try {
        const quote = await quotePosCart(
          {
            orgId: context.authz.user.orgId,
            registerId: input.registerId,
            customerId: input.customerId ?? null,
            lines: input.lines,
            orderDiscount: input.orderDiscount ?? null,
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          },
          posAuthority(context.authz),
          posPricing,
        );
        return { ok: true, quote, href: `/pos/${input.registerId}` };
      } catch (error) {
        settlePos(error);
      }
    },
  }),
  definition({
    name: "get_pos_receipt",
    title: "Get POS Receipt",
    description:
      "Read a posted POS receipt with its original line numbers, tenders, and refundable quantities before refunding or emailing it. Find receipt ids with get_record or complete_pos_sale.",
    inputSchema: z.object({
      documentId: UUID.describe("Cash-sale receipt UUID from get_record or complete_pos_sale."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "posRegister",
    visibleTo: visible("pos.sell"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "pos.sell");
      try {
        const receipt = await readPosReceipt(
          db,
          context.authz.user.orgId,
          input.documentId,
          context.authz.allowedSubsidiaryIds,
        );
        return { ok: true, receipt, href: listRecordDrawerHref("cash_sale", input.documentId) };
      } catch (error) {
        settlePos(error);
      }
    },
  }),
  definition({
    name: "open_pos_session",
    title: "Open POS Session",
    description:
      "Open a drawer session on a register using the cashier's counted opening float. Find a register id with list_pos_registers.",
    inputSchema: z.object({ registerId: UUID, openingCount: posCountSchema, idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "posRegister",
    visibleTo: visible("pos.drawer"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "pos.drawer");
      try {
        const session = await openSession({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          registerId: input.registerId,
          openingCount: input.openingCount,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, session, href: `/pos/sessions?session=${session.id}` };
      } catch (error) {
        settlePos(error);
      }
    },
  }),
  definition({
    name: "close_pos_session",
    title: "Close POS Session",
    description:
      "Close an open drawer after entering its denomination count and optional closeout note. Find the session with list_pos_sessions.",
    inputSchema: z.object({
      sessionId: UUID.describe("Open session UUID from list_pos_sessions."),
      closingCount: posCountSchema,
      note: z.string().trim().max(1000).nullable().optional().describe("Optional closeout note."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "posRegister",
    visibleTo: visible("pos.drawer"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "pos.drawer");
      try {
        const summary = await closeSession({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          sessionId: input.sessionId,
          closingCount: input.closingCount,
          note: input.note ?? null,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, summary, href: `/pos/sessions?session=${input.sessionId}` };
      } catch (error) {
        settlePos(error);
      }
    },
  }),
  definition({
    name: "record_pos_cash_movement",
    title: "Record POS Cash Movement",
    description:
      "Record cash paid into or removed from an open drawer against a configured movement reason. Find the session with list_pos_sessions and movement reasons in POS setup.",
    inputSchema: z.object({
      sessionId: UUID,
      reasonId: UUID.describe("Configured cash-movement reason UUID."),
      amount: z.string().trim().max(24).describe("Exact decimal amount as text."),
      note: z.string().trim().max(500).nullable().optional().describe("Optional operator note."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "posRegister",
    visibleTo: visible("pos.drawer"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "pos.drawer");
      try {
        const movement = await recordCashMovement({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          sessionId: input.sessionId,
          reasonId: input.reasonId,
          amount: input.amount,
          note: input.note ?? null,
          idempotencyKey: domainUuidIdempotencyKey(context.authz.user.orgId, input.idempotencyKey),
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, ...movement, href: `/pos/sessions?session=${input.sessionId}` };
      } catch (error) {
        settlePos(error);
      }
    },
  }),
  definition({
    name: "complete_pos_sale",
    title: "Complete POS Sale",
    description:
      "Post a register sale using the exact cart and tender amounts after confirming its quote. Find an open session with list_pos_sessions and customer or item ids with POS search.",
    inputSchema: posSaleBody.extend({ idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "posRegister",
    visibleTo: visible("pos.sell"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "pos.sell");
      try {
        const completion = await completePosSale(
          {
            orgId: context.authz.user.orgId,
            actorId: context.authz.user.id,
            sessionId: input.sessionId,
            idempotencyKey: domainUuidIdempotencyKey(
              context.authz.user.orgId,
              input.idempotencyKey,
            ),
            customerId: input.customerId ?? null,
            lines: input.lines,
            orderDiscount: input.orderDiscount ?? null,
            payments: input.payments,
            expectedTotal: input.expectedTotal ?? null,
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          },
          posAuthority(context.authz),
          posPricing,
        );
        return {
          ok: true,
          ...completion,
          href: listRecordDrawerHref("cash_sale", completion.documentId),
        };
      } catch (error) {
        settlePos(error);
      }
    },
  }),
  definition({
    name: "refund_pos_sale",
    title: "Refund POS Sale",
    description:
      "Post a refund for specified lines of a posted POS receipt, using supported refund tenders and an operator reason. Use the receipt read to find its id and original line numbers.",
    inputSchema: posRefundBody.extend({ idempotencyKey: KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "posRegister",
    visibleTo: visible("pos.refund"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "pos.refund");
      try {
        const completion = await completePosRefund({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          sessionId: input.sessionId,
          idempotencyKey: domainUuidIdempotencyKey(context.authz.user.orgId, input.idempotencyKey),
          originalDocumentId: input.originalDocumentId,
          lines: input.lines,
          payments: input.payments,
          reason: input.reason ?? null,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return {
          ok: true,
          ...completion,
          href: listRecordDrawerHref("cash_sale", completion.documentId),
        };
      } catch (error) {
        settlePos(error);
      }
    },
  }),
  definition({
    name: "hold_pos_cart",
    title: "Hold POS Cart",
    description:
      "Park a priced cart at its register so another customer can be served. Find the register with list_pos_registers; resume held carts from the same register.",
    inputSchema: z.object({
      registerId: UUID,
      label: z.string().max(120).describe("Short operator label for finding the held cart."),
      cart: posQuoteBody
        .omit({ registerId: true })
        .describe("Customer, lines, and optional order discount to preserve."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "posRegister",
    visibleTo: visible("pos.sell"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "pos.sell");
      try {
        const held = await holdCart({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          registerId: input.registerId,
          label: input.label,
          cart: input.cart,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, ...held, href: `/pos/${input.registerId}` };
      } catch (error) {
        settlePos(error);
      }
    },
  }),
  definition({
    name: "list_held_pos_carts",
    title: "List Held POS Carts",
    description:
      "List parked carts for a register so an operator can choose one to resume. Find register ids with list_pos_registers.",
    inputSchema: z.object({ registerId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "posRegister",
    visibleTo: visible("pos.sell"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "pos.sell");
      try {
        const carts = await listHeldCarts(
          context.authz.user.orgId,
          input.registerId,
          context.authz.allowedSubsidiaryIds,
        );
        return { ok: true, carts, href: `/pos/${input.registerId}` };
      } catch (error) {
        settlePos(error);
      }
    },
  }),
  definition({
    name: "resume_held_pos_cart",
    title: "Resume Held POS Cart",
    description:
      "Return a parked cart to its register and remove it from the held list. Use list_held_pos_carts to find the cart id.",
    inputSchema: z.object({ registerId: UUID, cartId: UUID, idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "posRegister",
    visibleTo: visible("pos.sell"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "pos.sell");
      try {
        const cart = await resumeHeldCart(
          context.authz.user.orgId,
          input.registerId,
          input.cartId,
          context.authz.allowedSubsidiaryIds,
        );
        return { ok: true, cart, href: `/pos/${input.registerId}` };
      } catch (error) {
        settlePos(error);
      }
    },
  }),
  definition({
    name: "email_pos_receipt",
    title: "Email POS Receipt",
    description:
      "Email a posted POS receipt to the customer's saved address or a supplied recipient. Use the receipt read to find its document id; organization email delivery must be configured.",
    inputSchema: z.object({
      documentId: UUID.describe("Posted POS receipt document UUID."),
      to: EMAIL.nullable()
        .optional()
        .describe("Optional recipient email; defaults to the customer's saved address."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    featureKey: "posRegister",
    visibleTo: visible("pos.sell"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "pos.sell");
      try {
        const result = await emailPosReceipt({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          documentId: input.documentId,
          to: input.to ?? null,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, ...result, href: listRecordDrawerHref("cash_sale", input.documentId) };
      } catch (error) {
        settlePos(error);
      }
    },
  }),
];
