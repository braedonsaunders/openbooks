import "server-only";
import { cmp } from "@openbooks/engine/money/money";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { InventoryError } from "@openbooks/engine/inventory/contracts/module";
import {
  attributeDeficitAccount,
  listUnattributedDeficits,
} from "@openbooks/engine/inventory/provisional-attribution";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { isPricingCustomerVisible, resolveItemPrice } from "../item-pricing";
import { canonicalDecimal } from "../exact-decimal";
import { can } from "../authz";
import { type ApplicationToolDefinition } from "./tool-definition";
import { inventoryDefinition as definition, IDEMPOTENCY_KEY, UUID } from "./inventory-tools-common";
import { assertApplicationPermission } from "./context";
import { conflict, invalidInput, notFound } from "./errors";
import { z } from "zod";

const visibleRead = (authz: Parameters<ApplicationToolDefinition["visibleTo"]>[0]) =>
  can(authz, "items.read");
const SHORTFALL_HREF = (itemId: string) => `/items?item=${encodeURIComponent(itemId)}`;

export const INVENTORY_ITEM_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "preview_item_price",
    title: "Preview Item Price",
    description:
      "Resolve the effective item price for a customer, currency, date and requested quantities without creating a transaction. Find item and customer ids with search_items and party reads.",
    inputSchema: z.object({
      itemId: UUID.describe("Item id from search_items or get_item."),
      customerId: UUID.nullable()
        .optional()
        .describe("Customer party id, or null for organization pricing."),
      currency: z
        .string()
        .trim()
        .regex(/^[A-Za-z]{3}$/)
        .describe("Three-letter currency code."),
      onDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("Pricing date in YYYY-MM-DD format."),
      lineQuantity: z
        .string()
        .regex(/^\d+(?:\.\d{1,4})?$/)
        .describe("Exact positive line quantity string."),
      overallItemQuantity: z
        .string()
        .regex(/^\d+(?:\.\d{1,4})?$/)
        .optional()
        .describe("Exact positive total item quantity string; defaults to line quantity."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "ar.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "ar.read");
      const currency = input.currency.trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) throw invalidInput("Currency must be a three-letter code.");
      if (!isIsoCalendarDate(input.onDate))
        throw invalidInput("Pricing date must be a real calendar date (YYYY-MM-DD).");
      const lineQuantity = canonicalDecimal(input.lineQuantity, 4);
      const overallItemQuantity = canonicalDecimal(
        input.overallItemQuantity ?? input.lineQuantity,
        4,
      );
      if (
        !lineQuantity ||
        !overallItemQuantity ||
        cmp(lineQuantity, "0") <= 0 ||
        cmp(overallItemQuantity, "0") <= 0
      )
        throw invalidInput("Pricing quantities must be positive exact decimals.");
      if (
        input.customerId &&
        !(await isPricingCustomerVisible(
          context.authz.user.orgId,
          input.customerId,
          context.authz.allowedSubsidiaryIds,
        ))
      )
        throw notFound("record");
      const price = await resolveItemPrice({
        orgId: context.authz.user.orgId,
        itemId: input.itemId,
        customerId: input.customerId ?? null,
        currency,
        onDate: input.onDate,
        lineQuantity,
        overallItemQuantity,
      });
      return { ok: true, price, href: SHORTFALL_HREF(input.itemId) };
    },
  }),
  definition({
    name: "list_inventory_shortfalls",
    title: "List Inventory Shortfalls",
    description:
      "List an item's negative-stock shortfalls that still need an offset account before a receipt can settle them. Find the item id with search_items and use a returned shortfall id with attribute_inventory_shortfall_account.",
    inputSchema: z.object({ itemId: UUID.describe("Item id from search_items or get_item.") }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: visibleRead,
    featureKey: "inventory",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.read");
      try {
        return {
          shortfalls: await listUnattributedDeficits(
            context.authz.user.orgId,
            input.itemId,
            context.authz.allowedSubsidiaryIds,
          ),
          href: SHORTFALL_HREF(input.itemId),
        };
      } catch (error) {
        if (error instanceof ScopeNotFoundError) throw notFound("item");
        throw error;
      }
    },
  }),
  definition({
    name: "attribute_inventory_shortfall_account",
    title: "Attribute Inventory Shortfall Account",
    description:
      "Assign the accounting offset and a reason to one pending negative-stock shortfall so a later receipt can settle it. Find pending shortfall ids with list_inventory_shortfalls and verify the saved attribution with that read.",
    inputSchema: z.object({
      itemId: UUID.describe("Item id from list_inventory_shortfalls."),
      deficitId: UUID.describe("Shortfall id from list_inventory_shortfalls."),
      accountId: UUID.describe("Offset account id from the accounts read."),
      reason: z.string().min(1).max(500).describe("Reason for assigning the offset account."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "items.manage") && can(authz, "gl.post"),
    featureKey: "inventory",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.manage");
      assertApplicationPermission(context, "gl.post");
      const pending = await listUnattributedDeficits(
        context.authz.user.orgId,
        input.itemId,
        context.authz.allowedSubsidiaryIds,
      );
      if (!pending.some((shortfall) => shortfall.id === input.deficitId))
        throw conflict("That shortfall is no longer awaiting an account; reload the item.");
      try {
        const result = await attributeDeficitAccount({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          deficitId: input.deficitId,
          accountId: input.accountId,
          reason: input.reason,
        });
        return { ok: true, ...result, href: SHORTFALL_HREF(input.itemId) };
      } catch (error) {
        if (error instanceof ScopeNotFoundError) throw notFound("inventory shortfall");
        if (error instanceof InventoryError) throw invalidInput(error.message);
        throw error;
      }
    },
  }),
];
