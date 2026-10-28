import "server-only";
import { z } from "zod";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { documentRevisionSql } from "@openbooks/engine/records/revision";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { QuoteToCashError } from "@openbooks/engine/billing/quote-to-cash";
import {
  CrmLifecycleRefusalError,
  promoteCrmAccount,
  transitionCrmAccountStage,
} from "@openbooks/engine/crm/crm";
import { SalesError, previewTerritory, writeSalesCommand } from "@openbooks/engine/crm/sales";
import { hasGeographicCoverage } from "@openbooks/engine/crm/sales/contracts";
import { can } from "../authz";
import { crmSharedScope } from "../crm-scope";
import { canonicalizeSalesGeography } from "../crm/territory-boundaries";
import { verifyCrmTerritoryLocation } from "../crm/territory-location";
import {
  crmOpportunityEstimateKey,
  createCrmOpportunityEstimate,
} from "../crm/opportunity-estimate";
import {
  createCrmAccountDraft,
  createCrmActivityDraft,
  createCrmOpportunityDraft,
  startCrmAccountTracking,
  type CrmActionResponse,
} from "../crm/actions";
import { isFeatureEnabled, featureEnabled, resolvedFeatureState } from "../features";
import { salesCommandSchema, salesTerritorySchema } from "../crm/sales-schema";
import { ApplicationError, invalidInput, notFound } from "./errors";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { CRM_SERVICE_APPLICATION_TOOLS } from "./crm-tools-service";
import { assignPartyRolesInSlice, removePartyRoleFromParty } from "../party-role-actions";
import { sendPartyStatement } from "../party-statement";
import { createCrmForecastSnapshot, crmForecastSnapshotSchema } from "../crm/forecasts";
import {
  crmAccountStatusBody,
  crmLeadSourceBody,
  crmOpportunityStatusBody,
  loadCrmSetup,
  saveCrmPipelineSetup,
} from "../crm/setup-actions";
import {
  PartyRelationshipsError,
  partyRelationshipsInput,
  updatePartyRelationships,
} from "../party-relationships";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import {
  getQuoteSignatureStatus,
  sendQuoteSignatureRequest,
  voidQuoteSignatureRequest,
} from "../quote-to-cash/signature-actions";

const UUID = z.string().regex(UUID_RE).describe("UUID copied from the matching CRM read tool.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

async function requireFeature(context: ApplicationContext, feature: string): Promise<void> {
  const state = await resolvedFeatureState(context.authz.user.orgId);
  if (!featureEnabled(state, feature)) throw notFound(`${feature} record`);
}

function crmPermission(context: ApplicationContext, permission: string): void {
  assertApplicationPermission(context, permission);
}

function settleCrmRefusal(error: unknown): never {
  if (error instanceof QuoteToCashError) {
    const code =
      error.status === 403
        ? "forbidden"
        : error.status === 404
          ? "not_found"
          : error.status === 409
            ? "conflict"
            : "invalid_input";
    throw new ApplicationError(code, error.message, error.status);
  }
  if (error instanceof CrmLifecycleRefusalError) {
    throw invalidInput(error.message);
  }
  if (error instanceof SalesError) {
    const code =
      error.status === 403
        ? "forbidden"
        : error.status === 404
          ? "not_found"
          : error.status === 409
            ? "conflict"
            : "invalid_input";
    throw new ApplicationError(code, error.message, error.status);
  }
  throw error;
}

async function settleRouteAction<T extends Record<string, unknown>>(
  result: CrmActionResponse<T>,
): Promise<T> {
  if ("response" in result) {
    const body = (await result.response.json()) as Record<string, unknown>;
    const message = typeof body.error === "string" ? body.error : "CRM action was refused.";
    const status = result.response.status;
    const code =
      status === 403
        ? "forbidden"
        : status === 404
          ? "not_found"
          : status === 409
            ? "conflict"
            : "invalid_input";
    throw new ApplicationError(code, message, status, body);
  }
  return result.body as T;
}

async function settlePartyAction<T extends Record<string, unknown>>(
  result: NextResponse | T,
  refusal = "Party action was refused.",
): Promise<T> {
  if (!(result instanceof NextResponse)) return result;
  const body = (await result.json()) as Record<string, unknown>;
  const message = typeof body.error === "string" ? body.error : refusal;
  const status = result.status;
  const code =
    status === 403
      ? "forbidden"
      : status === 404
        ? "not_found"
        : status === 409
          ? "conflict"
          : "invalid_input";
  throw new ApplicationError(code, message, status, body);
}

type CrmMutationArgs<T extends z.ZodType> = {
  name: string;
  title: string;
  description: string;
  inputSchema: T;
  permission: string;
  feature: string;
  destructive?: boolean;
  openWorld?: boolean;
  execute: (context: ApplicationContext, input: z.infer<T>) => Promise<Record<string, unknown>>;
};

function crmMutation<T extends z.ZodType>(args: CrmMutationArgs<T>) {
  return definition({
    name: args.name,
    title: args.title,
    description: args.description,
    inputSchema: args.inputSchema,
    readOnly: false,
    destructive: args.destructive ?? false,
    openWorld: args.openWorld ?? false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, args.permission),
    featureKey: args.feature,
    execute: async (context, input) => {
      crmPermission(context, args.permission);
      await requireFeature(context, args.feature);
      try {
        return await args.execute(context, input);
      } catch (error) {
        settleCrmRefusal(error);
      }
    },
  });
}

export const CRM_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "get_crm_pipeline_setup",
    title: "Get CRM Pipeline Setup",
    description:
      "Read CRM account stages, opportunity stages, lead sources, territories, teams and quotas before configuring pipelines. The Sales Settings view uses the same setup reader.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "crm.setup.manage"),
    featureKey: "crm",
    execute: async (context) => {
      crmPermission(context, "crm.setup.manage");
      await requireFeature(context, "crm");
      return {
        ...(await loadCrmSetup(
          context.authz.user.orgId,
          context.authz.allowedSubsidiaryIds !== null,
          null,
        )),
        href: "/crm/setup",
      };
    },
  }),
  crmMutation({
    name: "save_crm_account_status",
    title: "Save CRM Account Status",
    description:
      "Create or update an account status and lifecycle stage used for lead, prospect and customer records. Read current stages with get_crm_pipeline_setup before saving.",
    inputSchema: crmAccountStatusBody.omit({ action: true }).extend({
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "crm.setup.manage",
    feature: "crm",
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...payload } = input;
      const result = await saveCrmPipelineSetup(context.authz, {
        ...payload,
        action: "save-account-status",
      });
      const settled = await settlePartyAction(result, "CRM account status was refused.");
      return { ok: true, ...settled, href: "/crm/setup" };
    },
  }),
  crmMutation({
    name: "save_crm_opportunity_status",
    title: "Save CRM Opportunity Status",
    description:
      "Create or update an opportunity stage, win probability, forecast category and entry requirements. Read current stages with get_crm_pipeline_setup before saving.",
    inputSchema: crmOpportunityStatusBody.omit({ action: true }).extend({
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "crm.setup.manage",
    feature: "crm",
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...payload } = input;
      const result = await saveCrmPipelineSetup(context.authz, {
        ...payload,
        action: "save-opportunity-status",
      });
      const settled = await settlePartyAction(result, "CRM opportunity status was refused.");
      return { ok: true, ...settled, href: "/crm/setup" };
    },
  }),
  crmMutation({
    name: "save_crm_lead_source",
    title: "Save CRM Lead Source",
    description:
      "Create or update a source option for CRM leads. Read current sources with get_crm_pipeline_setup before saving.",
    inputSchema: crmLeadSourceBody.omit({ action: true }).extend({
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "crm.setup.manage",
    feature: "crm",
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...payload } = input;
      const result = await saveCrmPipelineSetup(context.authz, {
        ...payload,
        action: "save-lead-source",
      });
      const settled = await settlePartyAction(result, "CRM lead source was refused.");
      return { ok: true, ...settled, href: "/crm/setup" };
    },
  }),
  crmMutation({
    name: "create_crm_forecast_snapshot",
    title: "Create CRM Forecast Snapshot",
    description:
      "Save a calculated or authorized override snapshot for a whole-organization CRM forecast period. Use crm_forecast to inspect the period and saved snapshots; owner and team targets must belong to this organization.",
    inputSchema: crmForecastSnapshotSchema(undefined, IDEMPOTENCY_KEY),
    permission: "crm.forecasts.manage",
    feature: "crm",
    execute: async (context, input) => {
      const result = await createCrmForecastSnapshot(context.authz, input);
      const settled = await settlePartyAction(result, "CRM forecast snapshot was refused.");
      return { ok: true, ...settled, href: "/crm/forecasts" };
    },
  }),
  crmMutation({
    name: "create_crm_lead",
    title: "Create CRM Lead",
    description:
      "Create an inactive lead or prospect placeholder, then complete its party details with create_record or update_record. Find the new party id with search_crm_accounts.",
    inputSchema: z.object({
      lifecycleStage: z
        .enum(["lead", "prospect"])
        .optional()
        .describe("Start as a lead or prospect; defaults to lead."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "crm.accounts.create",
    feature: "crm",
    execute: async (context, input) => {
      const result = await createCrmAccountDraft(context.authz, input.lifecycleStage ?? "lead");
      const body = await settleRouteAction<{ id: string }>(result);
      return { ok: true, partyId: body.id, href: `/crm/accounts?party=${body.id}` };
    },
  }),
  crmMutation({
    name: "start_crm_account_tracking",
    title: "Start CRM Account Tracking",
    description:
      "Start CRM relationship tracking for an existing party created outside the CRM flow. Find party ids with search_parties; the stage follows its active customer role when present.",
    inputSchema: z.object({ partyId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    permission: "crm.accounts.manage",
    feature: "crm",
    execute: async (context, input) => {
      const body = await settleRouteAction<{ account: unknown }>(
        await startCrmAccountTracking(context.authz, input.partyId),
      );
      return {
        ok: true,
        partyId: input.partyId,
        ...body,
        href: `/crm/accounts?party=${input.partyId}`,
      };
    },
  }),
  crmMutation({
    name: "create_crm_opportunity",
    title: "Create CRM Opportunity",
    description:
      "Create an inactive opportunity draft for an active party, or leave partyId empty to attach a customer later. Find opportunities with search_opportunities.",
    inputSchema: z.object({
      partyId: UUID.nullable()
        .optional()
        .describe("Active party to associate with the opportunity."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "crm.opportunities.manage",
    feature: "crm",
    execute: async (context, input) => {
      const body = await settleRouteAction<{ id: string }>(
        await createCrmOpportunityDraft(context.authz, input.partyId ?? null),
      );
      return {
        ok: true,
        opportunityId: body.id,
        href: `/crm/opportunities?opportunity=${body.id}`,
      };
    },
  }),
  definition({
    name: "convert_crm_opportunity_to_quote",
    title: "Convert CRM Opportunity to Quote",
    description:
      "Create a quote draft from an active opportunity with an account and item-backed lines. Use the opportunity id from get_opportunity; this action also requires Accounts Receivable create permission and an enabled Quotes document kind.",
    inputSchema: z.strictObject({
      opportunityId: UUID.describe("Active opportunity UUID returned by get_opportunity."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "crm.opportunities.manage") && can(authz, "ar.create"),
    featureKey: "crm",
    execute: async (context, input) => {
      crmPermission(context, "crm.opportunities.manage");
      crmPermission(context, "ar.create");
      await requireFeature(context, "crm");
      const response = await createCrmOpportunityEstimate(
        context.authz,
        input.opportunityId,
        crmOpportunityEstimateKey(input.idempotencyKey),
      );
      const payload = (await response.json()) as Record<string, unknown>;
      if (response.status >= 400) {
        const message =
          typeof payload.error === "string" ? payload.error : "Opportunity conversion was refused.";
        const status = response.status;
        const code =
          status === 403
            ? "forbidden"
            : status === 404
              ? "not_found"
              : status === 409
                ? "conflict"
                : "invalid_input";
        throw new ApplicationError(code, message, status, payload);
      }
      return { ok: true, ...payload, href: `/estimates/${String(payload.id)}` };
    },
  }),
  crmMutation({
    name: "create_crm_activity",
    title: "Create CRM Activity",
    description:
      "Create a planned task, call, event, email or note, optionally linked to a visible CRM subject. Find activity ids with search_crm_activities.",
    inputSchema: z
      .object({
        kind: z
          .enum(["task", "call", "event", "email", "note"])
          .optional()
          .describe("Activity kind; defaults to task."),
        subjectKind: z
          .enum(["account", "contact", "opportunity", "document", "project"])
          .optional()
          .describe("Visible subject type to link."),
        subjectId: UUID.optional().describe("Subject id from the matching CRM read tool."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine((body) => (body.subjectKind === undefined) === (body.subjectId === undefined), {
        message: "subjectKind and subjectId must be supplied together",
      }),
    permission: "crm.activities.manage",
    feature: "crm",
    execute: async (context, input) => {
      const body = await settleRouteAction<{ id: string }>(
        await createCrmActivityDraft(context.authz, input),
      );
      return { ok: true, activityId: body.id, href: `/crm/activities?activity=${body.id}` };
    },
  }),
  crmMutation({
    name: "move_crm_account_stage",
    title: "Move CRM Account Stage",
    description:
      "Move a tracked account to lead, prospect or customer and record a reason. Find the party id and current lifecycle stage with search_crm_accounts; moving backward requires a reason.",
    inputSchema: z.object({
      partyId: UUID,
      toStage: z.enum(["lead", "prospect", "customer"]).describe("Target CRM lifecycle stage."),
      statusId: UUID.nullable()
        .optional()
        .describe("Active status in the target stage; omit to use its configured default."),
      reason: z.string().trim().min(1).max(2000).describe("Why the lifecycle stage is changing."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "crm.accounts.manage",
    feature: "crm",
    execute: async (context, input) => {
      const orgId = context.authz.user.orgId;
      const visible = await db.execute(
        sql`select p.id from parties p join crm_account_profiles cp on cp.org_id=p.org_id and cp.party_id=p.id
          where p.id=${input.partyId} and p.org_id=${orgId}${crmSharedScope(sql`p.subsidiary_id`, context.authz.allowedSubsidiaryIds)}`,
        "objects",
      );
      if (!visible.length) throw notFound("CRM account");
      const result = await db.transaction((tx) =>
        input.toStage === "customer"
          ? promoteCrmAccount(tx, {
              orgId,
              partyId: input.partyId,
              actorId: context.authz.user.id,
              toStage: "customer",
              sourceKind: "manual",
              reason: input.reason,
            })
          : transitionCrmAccountStage(tx, {
              orgId,
              partyId: input.partyId,
              actorId: context.authz.user.id,
              toStage: input.toStage,
              sourceKind: "manual",
              reason: input.reason,
              statusId: input.statusId,
            }),
      );
      return {
        ok: true,
        partyId: input.partyId,
        ...result,
        href: `/crm/accounts?party=${input.partyId}`,
      };
    },
  }),
  crmMutation({
    name: "convert_crm_lead",
    title: "Convert CRM Lead",
    description:
      "Convert a lead or prospect to an active customer through the CRM lifecycle, including the customer role and stage evidence. Find the party id with search_crm_accounts.",
    inputSchema: z.object({
      partyId: UUID,
      reason: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Reason for converting the lead to a customer."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "crm.accounts.manage",
    feature: "crm",
    execute: async (context, input) => {
      const orgId = context.authz.user.orgId;
      const visible = await db.execute(
        sql`select p.id from parties p join crm_account_profiles cp on cp.org_id=p.org_id and cp.party_id=p.id
          where p.id=${input.partyId} and p.org_id=${orgId}${crmSharedScope(sql`p.subsidiary_id`, context.authz.allowedSubsidiaryIds)}`,
        "objects",
      );
      if (!visible.length) throw notFound("CRM account");
      const result = await db.transaction((tx) =>
        promoteCrmAccount(tx, {
          orgId,
          partyId: input.partyId,
          actorId: context.authz.user.id,
          toStage: "customer",
          sourceKind: "manual",
          reason: input.reason,
        }),
      );
      return {
        ok: true,
        partyId: input.partyId,
        ...result,
        href: `/crm/accounts?party=${input.partyId}`,
      };
    },
  }),
  crmMutation({
    name: "write_crm_sales_setup",
    title: "Write CRM Sales Setup",
    description:
      "Create or revise a sales representative, team, territory or effective-dated quota using the native sales command. Supply the current revision and previewRevision when a territory is being activated.",
    inputSchema: z.object({
      command: salesCommandSchema.describe(
        "Representative, team, territory, quota or quota lifecycle command.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "crm.setup.manage",
    feature: "salesManagement",
    execute: async (context, input) => {
      if (
        input.command.action === "territory" &&
        (hasGeographicCoverage(input.command.geography) ||
          input.command.geography.excludes.length) &&
        !(await isFeatureEnabled(context.authz.user.orgId, "geographicTerritories"))
      ) {
        throw notFound("territory map coverage");
      }
      const command =
        input.command.action === "territory"
          ? {
              ...input.command,
              geography: await canonicalizeSalesGeography(input.command.geography),
            }
          : input.command;
      const result = await writeSalesCommand(
        {
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        },
        command,
      );
      return { ok: true, ...(result as Record<string, unknown>), href: "/crm/sales" };
    },
  }),
  definition({
    name: "preview_crm_territory",
    title: "Preview CRM Territory",
    description:
      "Preview account coverage and overlap for a territory before saving or activating it. Use the territory ids from Sales Setup; map boundaries require Geographic Territories to be enabled.",
    inputSchema: salesTerritorySchema,
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "crm.setup.manage"),
    featureKey: "salesManagement",
    execute: async (context, input) => {
      crmPermission(context, "crm.setup.manage");
      await requireFeature(context, "salesManagement");
      if (
        (hasGeographicCoverage(input.geography) || input.geography.excludes.length) &&
        !(await isFeatureEnabled(context.authz.user.orgId, "geographicTerritories"))
      ) {
        throw notFound("territory map coverage");
      }
      try {
        const geography = await canonicalizeSalesGeography(input.geography);
        const result = await db.transaction((tx) =>
          previewTerritory(
            tx,
            {
              orgId: context.authz.user.orgId,
              actorId: context.authz.user.id,
              allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
            },
            { ...input, geography },
          ),
        );
        return { ok: true, ...result, href: "/crm/sales" };
      } catch (error) {
        settleCrmRefusal(error);
      }
    },
  }),
  crmMutation({
    name: "verify_crm_territory_location",
    title: "Verify CRM Territory Location",
    description:
      "Save verified coordinates for an account address missing from a geographic territory preview. Use addressId and addressRevision from preview_crm_territory; the address must remain unchanged until verification.",
    inputSchema: z.strictObject({
      addressId: UUID.describe("Address UUID returned by preview_crm_territory."),
      longitude: z.number().min(-180).max(180).describe("Verified longitude from -180 to 180."),
      latitude: z.number().min(-90).max(90).describe("Verified latitude from -90 to 90."),
      expectedRevision: z
        .string()
        .min(1)
        .max(100)
        .describe("Address revision returned by the territory preview."),
      reason: z.string().trim().min(1).max(1000).describe("Reason the location was verified."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "crm.accounts.manage",
    feature: "geographicTerritories",
    execute: async (context, input) => {
      await verifyCrmTerritoryLocation(context.authz, input.addressId, input);
      return { ok: true, id: input.addressId, href: "/crm/sales" };
    },
  }),
  definition({
    name: "assign_party_roles",
    title: "Assign Party Roles",
    description:
      "Assign a customer, vendor or employee role to every role-less party matching the directory filter. Search parties first and narrow large batches; existing roles are never reactivated.",
    inputSchema: z.object({
      role: z.enum(["customer", "vendor", "employee"]).describe("Native party role to add."),
      q: z
        .string()
        .trim()
        .max(200)
        .optional()
        .describe("Same name, code or email filter as the party directory."),
      includeInactive: z
        .boolean()
        .optional()
        .describe("Include inactive parties in the matching slice."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "parties.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "parties.manage");
      const { idempotencyKey: _key, ...body } = input;
      const result = await assignPartyRolesInSlice(context.authz, body);
      const settled = await settlePartyAction(result);
      return { ok: true, ...settled, href: "/parties" };
    },
  }),
  crmMutation({
    name: "send_quote_for_signature",
    title: "Send Quote for Signature",
    description:
      "Issue an approved or draft quote for customer signature through quote-to-cash controls. Read the quote first and provide the authorized signer's name and email; pending approvals remain pending.",
    inputSchema: z.object({
      quoteId: UUID,
      signerName: z.string().trim().min(1).max(120).describe("Authorized signer's name."),
      signerEmail: z
        .string()
        .trim()
        .min(1)
        .max(320)
        .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)
        .describe("Authorized signer's email address."),
      expiresInDays: z
        .number()
        .int()
        .min(1)
        .max(90)
        .nullable()
        .optional()
        .describe("Signature link lifetime in days; omit to use the configured policy."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "estimates.create",
    feature: "quoteToCash",
    openWorld: true,
    execute: async (context, input) => {
      const result = await sendQuoteSignatureRequest({
        authz: context.authz,
        quoteId: input.quoteId,
        signerName: input.signerName,
        signerEmail: input.signerEmail,
        expiresInDays: input.expiresInDays ?? undefined,
      });
      return { ok: true, ...result, href: `/estimates/${input.quoteId}` };
    },
  }),
  crmMutation({
    name: "void_quote_signature_request",
    title: "Void Quote Signature Request",
    description:
      "Void open sent or viewed signature requests for a quote before sending revised terms. Find the quote id and latest request status with get_quote_signature_status.",
    inputSchema: z.object({ quoteId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    permission: "estimates.create",
    feature: "quoteToCash",
    destructive: true,
    execute: async (context, input) => ({
      ok: true,
      ...(await voidQuoteSignatureRequest(context.authz, input.quoteId)),
      quoteId: input.quoteId,
      href: `/estimates/${input.quoteId}`,
    }),
  }),
  definition({
    name: "get_quote_signature_status",
    title: "Get Quote Signature Status",
    description:
      "Read the open or latest signature request for a quote, including signer, expiry and status. Find quote ids with get_document.",
    inputSchema: z.object({ quoteId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "estimates.read"),
    featureKey: "quoteToCash",
    execute: async (context, input) => {
      assertApplicationPermission(context, "estimates.read");
      await requireFeature(context, "quoteToCash");
      try {
        return {
          ok: true,
          ...(await getQuoteSignatureStatus(context.authz, input.quoteId)),
          href: `/estimates/${input.quoteId}`,
        };
      } catch (error) {
        settleCrmRefusal(error);
      }
    },
  }),
  definition({
    name: "remove_party_role",
    title: "Remove Party Role",
    description:
      "Remove a customer, vendor or employee role only when no open operational records depend on it. Find the party and active roles with search_parties; the service preserves the party's base kind and audit history.",
    inputSchema: z.object({
      partyId: UUID,
      role: z.enum(["customer", "vendor", "employee"]).describe("Native party role to remove."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "parties.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "parties.manage");
      const result = await removePartyRoleFromParty(context.authz, input.partyId, input.role);
      const settled = await settlePartyAction(result);
      return {
        ok: true,
        ...settled,
        partyId: input.partyId,
        href: `/parties?party=${input.partyId}`,
      };
    },
  }),
  definition({
    name: "get_party_relationships",
    title: "Get Party Relationships",
    description:
      "Read a party's current address and contact rows with the revision needed to replace them. Find the party id with search_parties.",
    inputSchema: z.object({ partyId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "parties.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "parties.read");
      const party = (
        await db.execute<{ id: string; revision: string }>(
          sql`select p.id, ${documentRevisionSql(sql`p.updated_at`)} as revision
            from parties p where p.org_id = ${context.authz.user.orgId} and p.id = ${input.partyId}
              ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, context.authz.allowedSubsidiaryIds, { orgWideNull: true })}`,
          "objects",
        )
      )[0];
      if (!party) throw notFound("party");
      const addresses = await db.execute(
        sql`select id, label, line1, line2, city, region, postal_code as "postalCode", country,
            is_default_billing as "isDefaultBilling", is_default_shipping as "isDefaultShipping"
          from addresses where org_id = ${context.authz.user.orgId} and party_id = ${party.id} order by created_at, id`,
        "objects",
      );
      const contacts = await db.execute(
        sql`select id, first_name as "firstName", last_name as "lastName", name, title, role,
            email, phone, mobile_phone as "mobilePhone", is_primary as "isPrimary", is_active as "isActive"
          from contacts where org_id = ${context.authz.user.orgId} and party_id = ${party.id} order by created_at, id`,
        "objects",
      );
      return {
        ok: true,
        partyId: party.id,
        revision: party.revision,
        addresses,
        contacts,
        href: `/parties?party=${party.id}`,
      };
    },
  }),
  definition({
    name: "replace_party_relationships",
    title: "Replace Party Relationships",
    description:
      "Replace a party's address list, contact list or both using the revision from get_party_relationships. Each supplied list is a full replacement and is audited with the party record.",
    inputSchema: partyRelationshipsInput
      .extend({
        partyId: UUID,
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine((input) => input.addresses !== undefined || input.contacts !== undefined, {
        message: "Supply addresses, contacts or both.",
      }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "parties.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "parties.manage");
      const { idempotencyKey: _key, ...args } = input;
      try {
        const result = await db.transaction((tx) =>
          updatePartyRelationships(tx, {
            ...args,
            orgId: context.authz.user.orgId,
            actorId: context.authz.user.id,
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          }),
        );
        return { ok: true, ...result, href: `/parties?party=${input.partyId}` };
      } catch (error) {
        if (error instanceof PartyRelationshipsError) {
          const code =
            error.status === 404
              ? "not_found"
              : error.status === 409
                ? "conflict"
                : "invalid_input";
          throw new ApplicationError(code, error.message, error.status);
        }
        throw error;
      }
    },
  }),
  definition({
    name: "send_party_statement",
    title: "Send Party Statement",
    description:
      "Render and email the selected customer's or vendor's statement for an explicit period. Find the party id with search_parties; the sender needs the matching AR or AP create permission plus reports.read.",
    inputSchema: z.object({
      partyId: UUID,
      side: z
        .enum(["ar", "ap"])
        .describe("Statement ledger: ar for customer receivables, ap for vendor payables."),
      to: z
        .string()
        .trim()
        .max(320)
        .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)
        .optional()
        .describe("Override recipient; defaults to the party's preferred statement contact."),
      message: z
        .string()
        .max(2000)
        .optional()
        .describe("Optional note included in the statement email."),
      from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Beginning date (YYYY-MM-DD)."),
      toDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Ending date (YYYY-MM-DD)."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) =>
      can(authz, "reports.read") && (can(authz, "ar.create") || can(authz, "ap.create")),
    execute: async (context, input) => {
      crmPermission(context, input.side === "ap" ? "ap.create" : "ar.create");
      crmPermission(context, "reports.read");
      const { idempotencyKey: _key, partyId, ...body } = input;
      const result = await sendPartyStatement(context.authz, partyId, body);
      const settled = await settlePartyAction(result);
      const { ok: _ok, ...statement } = settled;
      return {
        ok: true,
        ...statement,
        partyId,
        href: `/reports/statements/${partyId}?side=${input.side}`,
      };
    },
  }),
  ...CRM_SERVICE_APPLICATION_TOOLS,
];
