import "server-only";
import { z } from "zod";
import { can } from "../authz";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { isDocKindEnabled } from "@openbooks/engine/documents/write";
import { db, withOrgContext } from "@openbooks/engine/platform/db";
import {
  listCashDeposits,
  readSaleTillWindow,
  recordCashDeposit,
  readTillDropWindow,
  recordTillDrop,
} from "@openbooks/engine/ledger/cash-deposits/module";
import { readTipsPayableExposure } from "@openbooks/engine/sales/cash-closeout";
import { assertApplicationPermission, assertSubsidiaryAccess } from "./context";
import { ApplicationError, conflict, forbidden, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { listRecordDrawerHref } from "../cross-module-drawer-links";
import { domainUuidIdempotencyKey } from "./domain-idempotency-key";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from a cash sale, bank account, till account, or subsidiary read.");
const KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date in YYYY-MM-DD format.");
const MONEY = z
  .string()
  .min(1)
  .max(40)
  .describe("Exact decimal money amount as text; JSON numbers are refused.");
const visible = (permission: string) => (authz: Parameters<typeof can>[0]) =>
  can(authz, permission);

async function assertCashSalesEnabled(orgId: string) {
  if (!(await isDocKindEnabled(orgId, "cash_sale"))) throw notFound("cash sales");
}

function settleCashSale(error: unknown): never {
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

export const SALES_CASH_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_cash_sale_deposits",
    title: "List Cash Sale Deposits",
    description:
      "List bank drops already recorded against a posted cash sale. Find the sale id with get_record.",
    inputSchema: z.object({ saleId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "cashSales",
    visibleTo: visible("cash_sales.deposit"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "cash_sales.deposit");
      await assertCashSalesEnabled(context.authz.user.orgId);
      try {
        const drops = await listCashDeposits(
          context.authz.user.orgId,
          input.saleId,
          context.authz.allowedSubsidiaryIds,
        );
        return { ok: true, drops, href: listRecordDrawerHref("cash_sale", input.saleId) };
      } catch (error) {
        settleCashSale(error);
      }
    },
  }),
  definition({
    name: "record_cash_sale_deposit",
    title: "Record Cash Sale Deposit",
    description:
      "Record a bank deposit against undropped cash tender from a posted cash sale, using the bank slip number. Find the sale with get_record and accounts with list_records.",
    inputSchema: z.object({
      saleId: UUID,
      amount: MONEY,
      date: DATE.describe("Bank-drop date."),
      bankAccountId: UUID,
      slipNumber: z.string().min(1).max(120).describe("Bank deposit slip or confirmation number."),
      sourceAccountId: UUID.nullable()
        .optional()
        .describe("Cash till account; omit to use the sale's native tender account."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "cashSales",
    visibleTo: visible("cash_sales.deposit"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "cash_sales.deposit");
      await assertCashSalesEnabled(context.authz.user.orgId);
      try {
        const drop = await recordCashDeposit(
          context.authz.user.orgId,
          context.authz.user.id,
          {
            saleId: input.saleId,
            amount: input.amount,
            date: input.date,
            bankAccountId: input.bankAccountId,
            slipNumber: input.slipNumber,
            sourceAccountId: input.sourceAccountId ?? null,
          },
          {
            key: domainUuidIdempotencyKey(context.authz.user.orgId, input.idempotencyKey),
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          },
        );
        return {
          ok: true,
          id: drop.transferId,
          documentNumber: drop.documentNumber,
          posted: drop.posted,
          entryId: drop.entryId,
          ...(drop.pendingApproval ? { pendingApproval: true } : {}),
          ...(drop.postRefusal ? { postRefusal: drop.postRefusal } : {}),
          href: listRecordDrawerHref("cash_sale", input.saleId),
        };
      } catch (error) {
        settleCashSale(error);
      }
    },
  }),
  definition({
    name: "read_cash_sale_till_window",
    title: "Read Cash Sale Till Window",
    description:
      "Read the till cash and prior-drop reconciliation window for a posted cash sale. Find the sale id with get_record.",
    inputSchema: z.object({ saleId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "cashSales",
    visibleTo: visible("cash_sales.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "cash_sales.read");
      await assertCashSalesEnabled(context.authz.user.orgId);
      try {
        const till = await readSaleTillWindow(
          context.authz.user.orgId,
          input.saleId,
          context.authz.allowedSubsidiaryIds ?? null,
        );
        return { ok: true, till, href: listRecordDrawerHref("cash_sale", input.saleId) };
      } catch (error) {
        settleCashSale(error);
      }
    },
  }),
  definition({
    name: "read_till_drop_window",
    title: "Read Till Drop Window",
    description:
      "Read the cash tender and prior-drop reconciliation window for a till and date before recording the next bank drop. Find till-account ids in cash-sales setup.",
    inputSchema: z.object({
      tillAccountId: UUID,
      date: DATE,
      subsidiaryId: UUID.nullable().describe(
        "Legal entity for this till window, or null for the organization-wide till.",
      ),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "cashSales",
    visibleTo: visible("cash_sales.deposit"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "cash_sales.deposit");
      await assertCashSalesEnabled(context.authz.user.orgId);
      if (input.subsidiaryId !== null) assertSubsidiaryAccess(context, input.subsidiaryId);
      try {
        const window = await readTillDropWindow(
          context.authz.user.orgId,
          input.tillAccountId,
          input.date,
          {
            subsidiaryId: input.subsidiaryId,
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          },
        );
        return { ok: true, ...window, href: "/cash-sales" };
      } catch (error) {
        settleCashSale(error);
      }
    },
  }),
  definition({
    name: "record_till_drop",
    title: "Record Till Drop",
    description:
      "Record cash removed from a till and deposited at a bank, optionally declaring which sales date the drop covers. Review read_till_drop_window first, then provide the bank slip number.",
    inputSchema: z.object({
      tillAccountId: UUID,
      amount: MONEY,
      date: DATE.describe("Date cash was deposited."),
      coversThrough: DATE.nullable()
        .optional()
        .describe("Latest cash-sale date covered by this drop."),
      bankAccountId: UUID,
      slipNumber: z.string().min(1).max(120).describe("Bank deposit slip or confirmation number."),
      subsidiaryId: UUID.nullable().optional().describe("Legal entity for this till drop."),
      reason: z
        .string()
        .max(500)
        .nullable()
        .optional()
        .describe("Optional reason or reconciliation note."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "cashSales",
    visibleTo: visible("cash_sales.deposit"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "cash_sales.deposit");
      await assertCashSalesEnabled(context.authz.user.orgId);
      if (input.subsidiaryId != null) assertSubsidiaryAccess(context, input.subsidiaryId);
      try {
        const drop = await recordTillDrop(
          context.authz.user.orgId,
          context.authz.user.id,
          {
            tillAccountId: input.tillAccountId,
            amount: input.amount,
            date: input.date,
            coversThrough: input.coversThrough ?? null,
            bankAccountId: input.bankAccountId,
            slipNumber: input.slipNumber,
            subsidiaryId: input.subsidiaryId ?? null,
            reason: input.reason ?? null,
          },
          {
            key: domainUuidIdempotencyKey(context.authz.user.orgId, input.idempotencyKey),
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          },
        );
        return {
          ok: true,
          id: drop.transferId,
          documentNumber: drop.documentNumber,
          posted: drop.posted,
          entryId: drop.entryId,
          window: drop.window,
          ...(drop.pendingApproval ? { pendingApproval: true } : {}),
          ...(drop.postRefusal ? { postRefusal: drop.postRefusal } : {}),
          href: "/cash-sales",
        };
      } catch (error) {
        settleCashSale(error);
      }
    },
  }),
  definition({
    name: "read_tips_payable_exposure",
    title: "Read Tips Payable Exposure",
    description:
      "Read posted cash-sale tips carried in the tips-payable control account, grouped by server and sale date. Cash sales must be enabled; payroll readers can also use this view.",
    inputSchema: z.object({
      from: DATE.optional().describe("First sale date, inclusive."),
      to: DATE.optional().describe("Last sale date, inclusive."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "cashSales",
    visibleTo: (authz) => can(authz, "cash_sales.read") || can(authz, "payroll.read"),
    execute: async (context, input) => {
      if (!can(context.authz, "cash_sales.read") && !can(context.authz, "payroll.read"))
        throw forbidden("cash_sales.read");
      await assertCashSalesEnabled(context.authz.user.orgId);
      try {
        const rows = await withOrgContext(context.authz.user.orgId, () =>
          readTipsPayableExposure(db, context.authz.user.orgId, {
            ...input,
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          }),
        );
        return { ok: true, rows, href: "/cash-sales/tips-payable" };
      } catch (error) {
        settleCashSale(error);
      }
    },
  }),
];
