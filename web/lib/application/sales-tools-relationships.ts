import "server-only";
import { z } from "zod";
import { can } from "../authz";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { db } from "@openbooks/engine/platform/db";
import { withScopeSnapshot } from "@openbooks/engine/organization/authority";
import {
  createBillingRelationship,
  deleteBillingRelationship,
  listConsolidationGroups,
  listCustomerBillingRelationships,
  RELATIONSHIP_ERRORS,
  updateBillingRelationship,
} from "../billing-relationships";
import { assertApplicationPermission } from "./context";
import { ApplicationError, conflict, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from a customer, billing relationship, or consolidation group read.");
const KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const DATE_OR_NULL = z
  .string()
  .max(10)
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()
  .describe("Calendar date in YYYY-MM-DD format, or null for an open end date.");
const OPTIONAL_DATE = z
  .string()
  .max(10)
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()
  .optional()
  .describe("Calendar date in YYYY-MM-DD format, or null when unspecified.");
const visible = (permission: string) => (authz: Parameters<typeof can>[0]) =>
  can(authz, permission);
const partyHref = (id: string) => `/parties?party=${encodeURIComponent(id)}`;

function settleRelationship(code: string, saveIsNotFound = false): never {
  if (code === "featureOff") {
    throw conflict(
      "Consolidated billing was turned off before this change could be saved — turn it back on under Company Settings → Features, then retry.",
      { errorCode: code },
    );
  }
  if (code === "notFound" || (saveIsNotFound && code === "save")) {
    throw notFound("billing relationship");
  }
  const message =
    RELATIONSHIP_ERRORS[code as keyof typeof RELATIONSHIP_ERRORS] ?? RELATIONSHIP_ERRORS.save;
  throw new ApplicationError("invalid_input", message, 400, { errorCode: code });
}

export const SALES_RELATIONSHIP_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_consolidation_groups",
    title: "List Consolidation Groups",
    description:
      "List active consolidation groups visible to the current legal-entity scope before assigning a payer relationship. Use returned group and payer ids with create_customer_billing_relationship.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "consolidatedBilling",
    visibleTo: visible("parties.read"),
    execute: async (context) => {
      assertApplicationPermission(context, "parties.read");
      const groups = await withScopeSnapshot(context.authz.user.orgId, () =>
        listConsolidationGroups(db, context.authz.user.orgId, context.authz.allowedSubsidiaryIds),
      );
      return { ok: true, groups, href: "/admin/setup/consolidation-groups" };
    },
  }),
  definition({
    name: "list_customer_billing_relationships",
    title: "List Customer Billing Relationships",
    description:
      "Read the active and historical bill-to, payer, and consolidation relationships for a customer. Find the customer id with list_records before updating or removing a relationship.",
    inputSchema: z.object({ childPartyId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "consolidatedBilling",
    visibleTo: visible("parties.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "parties.read");
      const result = await withScopeSnapshot(context.authz.user.orgId, () =>
        listCustomerBillingRelationships(
          db,
          context.authz.user.orgId,
          context.authz,
          input.childPartyId,
        ),
      );
      if (!result) throw notFound("customer billing relationship");
      return { ok: true, ...result, href: partyHref(input.childPartyId) };
    },
  }),
  definition({
    name: "create_customer_billing_relationship",
    title: "Create Customer Billing Relationship",
    description:
      "Route a billed customer to a bill-to customer and AR payer for an effective date range, optionally through an active consolidation group. Read the customer's relationships and group choices first; overlapping windows are refused.",
    inputSchema: z.object({
      childPartyId: UUID.describe("Customer whose billing destination is being configured."),
      billToPartyId: UUID.describe("Customer that receives the invoice."),
      payerPartyId: UUID.describe("Customer responsible for the receivable."),
      effectiveFrom: z
        .string()
        .max(10)
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("First calendar date governed by the relationship, in YYYY-MM-DD format."),
      effectiveTo: DATE_OR_NULL.describe(
        "Last calendar date governed by the relationship, or null for an open-ended window.",
      ),
      consolidationGroupId: UUID.nullable()
        .optional()
        .describe("Active consolidation group for the payer, or null for standalone billing."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "consolidatedBilling",
    visibleTo: visible("documents.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "documents.manage");
      const { idempotencyKey: _key, ...body } = input;
      const outcome = await createBillingRelationship(
        context.authz.user.orgId,
        context.authz.user.id,
        context.authz,
        body,
      );
      if (!("id" in outcome)) settleRelationship(outcome.errorCode);
      return { ok: true, ...outcome, href: partyHref(outcome.childPartyId) };
    },
  }),
  definition({
    name: "update_customer_billing_relationship",
    title: "Update Customer Billing Relationship",
    description:
      "Change the parties, consolidation group, or effective date range on an existing relationship while preserving its audit history. Find the relationship id with list_customer_billing_relationships; overlapping windows are refused.",
    inputSchema: z.object({
      id: UUID.describe("Billing relationship UUID from list_customer_billing_relationships."),
      childPartyId: UUID.optional().describe("Replacement billed customer UUID."),
      billToPartyId: UUID.optional().describe("Replacement invoice recipient UUID."),
      payerPartyId: UUID.optional().describe("Replacement receivable payer UUID."),
      effectiveFrom: OPTIONAL_DATE,
      effectiveTo: DATE_OR_NULL.optional().describe(
        "Replacement end date in YYYY-MM-DD format, or null for open-ended.",
      ),
      consolidationGroupId: UUID.nullable()
        .optional()
        .describe("Replacement active consolidation group, or null for standalone billing."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "consolidatedBilling",
    visibleTo: visible("documents.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "documents.manage");
      const { id, idempotencyKey: _key, ...body } = input;
      const outcome = await updateBillingRelationship(
        context.authz.user.orgId,
        context.authz.user.id,
        context.authz,
        id,
        body,
      );
      if (!("id" in outcome)) settleRelationship(outcome.errorCode, true);
      return { ok: true, ...outcome, href: partyHref(outcome.childPartyId) };
    },
  }),
  definition({
    name: "delete_customer_billing_relationship",
    title: "Delete Customer Billing Relationship",
    description:
      "Remove a customer billing relationship after reviewing its effective dates and downstream billing impact. Find the relationship id with list_customer_billing_relationships.",
    inputSchema: z.object({ id: UUID, idempotencyKey: KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "consolidatedBilling",
    visibleTo: visible("documents.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "documents.manage");
      const outcome = await deleteBillingRelationship(
        context.authz.user.orgId,
        context.authz.user.id,
        context.authz,
        input.id,
      );
      if (!("ok" in outcome)) settleRelationship(outcome.errorCode, true);
      return { ok: true, id: input.id, status: "deleted", href: partyHref(outcome.childPartyId) };
    },
  }),
];
