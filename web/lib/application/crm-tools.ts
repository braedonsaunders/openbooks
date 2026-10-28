import "server-only";
import { z } from "zod";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { documentRevisionSql } from "@openbooks/engine/records/revision";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { QuoteToCashError } from "@openbooks/engine/billing/quote-to-cash";
import { SalesError, previewTerritory, writeSalesCommand } from "@openbooks/engine/crm/sales";
import { hasGeographicCoverage } from "@openbooks/engine/crm/sales/contracts";
import { can } from "../authz";
import { crmSharedScope } from "../crm-scope";
import { canonicalizeSalesGeography } from "../crm/territory-boundaries";
import { verifyCrmTerritoryLocation } from "../crm/territory-location";
import {
  activityToolUpdateSchema,
  deleteCrmActivity,
  updateCrmActivity,
} from "../crm/activity-actions";
import {
  crmOpportunityEstimateKey,
  createCrmOpportunityEstimate,
} from "../crm/opportunity-estimate";
import { deleteCrmOpportunity, patchCrmOpportunity } from "../crm/opportunity-actions";
import {
  createCrmAccountDraft,
  createCrmActivityDraft,
  createCrmOpportunityDraft,
  startCrmAccountTracking,
  type CrmActionResponse,
} from "../crm/actions";
import { patchCrmAccount } from "../crm/account-actions";
import { isFeatureEnabled, featureEnabled, resolvedFeatureState } from "../features";
import { salesCommandSchema, salesTerritorySchema } from "../crm/sales-schema";
import { ApplicationError, notFound } from "./errors";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { CRM_SERVICE_APPLICATION_TOOLS } from "./crm-tools-service";
import { assignPartyRolesInSlice, removePartyRoleFromParty } from "../party-role-actions";
import { sendPartyStatement } from "../party-statement";
import { loadPartyBankAccounts } from "../party-bank-accounts";
import {
  createPartyBankAccount,
  bankAccountCreateBody,
  bankAccountPatchBody,
  bankAccountRetirementBody,
  retirePartyBankAccount,
  submitPartyBankAccount,
  updatePartyBankAccount,
} from "../party-bank-account-actions";
import {
  authorizePartyBankWriteWithAuthz,
  denyOutsidePartyScope,
} from "@/app/api/parties/[id]/bank-accounts/party-scope";
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

const crmAccountUpdateBody = z.strictObject({
  annualRevenue: z
    .string()
    .max(100)
    .nullable()
    .optional()
    .describe("Annual revenue as an exact decimal string, or null to clear it."),
  assignmentReason: z
    .string()
    .max(2000)
    .nullable()
    .optional()
    .describe("Reason recorded when changing the account owner or territory."),
  category: z.string().max(2000).nullable().optional().describe("CRM account category."),
  custom: z
    .record(z.string().max(100), z.json())
    .optional()
    .describe("Custom CRM account fields keyed by configured field name."),
  employeeCount: z
    .union([z.number().int().min(0).max(2147483647), z.string().max(20)])
    .nullable()
    .optional()
    .describe("Employee count as an integer or digit string, or null to clear it."),
  expectedUpdatedAt: z
    .string()
    .min(1)
    .max(100)
    .describe("Exact current revision from get_crm_account."),
  industry: z.string().max(2000).nullable().optional().describe("Industry description."),
  isActive: z.boolean().optional().describe("Whether the CRM account remains active."),
  leadSourceId: UUID.nullable()
    .optional()
    .describe("Lead-source UUID from get_crm_pipeline_setup, or null to clear it."),
  lifecycleStage: z
    .enum(["lead", "prospect", "customer"])
    .optional()
    .describe("CRM lifecycle stage; customer promotion also establishes the customer role."),
  nextActionAt: z
    .string()
    .max(100)
    .nullable()
    .optional()
    .describe("Next action date or timestamp in ISO format, or null to clear it."),
  ownerUserId: UUID.nullable()
    .optional()
    .describe("Organization user UUID to assign as owner, or null to clear the owner."),
  qualification: z
    .record(z.string().max(100), z.json())
    .nullable()
    .optional()
    .describe("Qualification answers as a JSON object, or null to clear them."),
  qualificationScore: z
    .union([z.number().int().min(0).max(100), z.string().max(20)])
    .nullable()
    .optional()
    .describe("Qualification score from 0 to 100, or null to clear it."),
  route: z
    .boolean()
    .optional()
    .describe("Whether to route the account through its configured territory rules."),
  stageReason: z
    .string()
    .max(2000)
    .nullable()
    .optional()
    .describe("Reason recorded for a lifecycle stage change."),
  statusId: UUID.nullable()
    .optional()
    .describe("Active account status UUID for the selected lifecycle stage, or null to clear it."),
  territoryId: UUID.nullable()
    .optional()
    .describe("Sales territory UUID from get_crm_pipeline_setup, or null to clear it."),
});

async function requireFeature(context: ApplicationContext, feature: string): Promise<void> {
  const state = await resolvedFeatureState(context.authz.user.orgId);
  if (!featureEnabled(state, feature)) throw notFound(`${feature} record`);
}

function crmPermission(context: ApplicationContext, permission: string): void {
  assertApplicationPermission(context, permission);
}

async function requireCrmAccountVisible(
  context: ApplicationContext,
  partyId: string,
): Promise<void> {
  const visible = await db.execute(
    sql`select p.id from parties p join crm_account_profiles cp on cp.org_id=p.org_id and cp.party_id=p.id
      where p.id=${partyId} and p.org_id=${context.authz.user.orgId}${crmSharedScope(sql`p.subsidiary_id`, context.authz.allowedSubsidiaryIds)}`,
    "objects",
  );
  if (!visible.length) throw notFound("CRM account");
}

const PARTY_BANK_PERMISSIONS = [
  "parties.manage",
  "hrm.employment.manage",
  "payroll.manage",
] as const;

function assertPartyBankPermission(context: ApplicationContext): void {
  const permission = PARTY_BANK_PERMISSIONS.find((candidate) => can(context.authz, candidate));
  assertApplicationPermission(context, permission ?? "parties.manage");
}

function partyBankRequest(
  context: ApplicationContext,
  partyId: string,
  accountId?: string,
): Request {
  const url = new URL(`/api/parties/${partyId}/bank-accounts`, "http://openbooks.local");
  if (accountId) url.searchParams.set("accountId", accountId);
  return new Request(url, { headers: { "X-Request-Id": context.requestId } });
}

async function authorizePartyBankTool(context: ApplicationContext, partyId: string): Promise<void> {
  assertPartyBankPermission(context);
  const denied = await authorizePartyBankWriteWithAuthz(context.authz, partyId);
  if (denied) await settleNativeResponse(denied);
  const scopeDenied = await denyOutsidePartyScope(context.authz, partyId);
  if (scopeDenied) await settleNativeResponse(scopeDenied);
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

async function settleNativeResponse(response: NextResponse): Promise<Record<string, unknown>> {
  const body = (await response.json()) as Record<string, unknown>;
  if (response.status < 400) return body;
  const message = typeof body.error === "string" ? body.error : "CRM action was refused.";
  const code =
    response.status === 403
      ? "forbidden"
      : response.status === 404
        ? "not_found"
        : response.status === 409
          ? "conflict"
          : "invalid_input";
  throw new ApplicationError(code, message, response.status, body);
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
  authorizeReplay?: (context: ApplicationContext, input: z.output<NoInfer<T>>) => Promise<void>;
  execute: (
    context: ApplicationContext,
    input: z.output<NoInfer<T>>,
  ) => Promise<Record<string, unknown>>;
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
    authorizeReplay: args.authorizeReplay,
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
    name: "update_crm_account",
    title: "Update CRM Account",
    description:
      "Update CRM lifecycle, account status, ownership, territory, lead source, qualification and profile fields using the current revision. Read the account with get_crm_account and available setup ids with get_crm_pipeline_setup.",
    inputSchema: crmAccountUpdateBody.extend({
      partyId: UUID.describe("Tracked party UUID returned by search_crm_accounts."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "crm.accounts.manage",
    feature: "crm",
    authorizeReplay: async (context, input) => requireCrmAccountVisible(context, input.partyId),
    execute: async (context, input) => {
      const { idempotencyKey: _key, partyId, ...body } = input;
      const response = await patchCrmAccount(context.authz, partyId, body, true);
      const result = await settleNativeResponse(response);
      const profile = result.profile as Record<string, unknown> | undefined;
      return {
        ok: true,
        ...result,
        partyId,
        status: profile?.lifecycle_stage,
        href: `/crm/accounts?party=${partyId}`,
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
    name: "move_crm_opportunity_stage",
    title: "Move CRM Opportunity Stage",
    description:
      "Move an opportunity to a configured stage, including won or lost outcomes. Read the current revision with get_opportunity and stage ids with get_crm_pipeline_setup; closed stages also require the close permission and may enforce configured entry requirements.",
    inputSchema: z.strictObject({
      opportunityId: UUID.describe("Opportunity UUID returned by get_opportunity."),
      statusId: UUID.describe("Target stage UUID from get_crm_pipeline_setup."),
      expectedUpdatedAt: z
        .string()
        .min(1)
        .max(100)
        .describe("Current exact revision token from get_opportunity.updated_at."),
      probability: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe(
          "Optional probability percentage; defaults to the target stage's configured value.",
        ),
      forecastCategory: z
        .enum(["omitted", "worst_case", "most_likely", "upside"])
        .optional()
        .describe("Optional forecast category; defaults to the target stage's configured value."),
      stageReason: z
        .string()
        .max(2000)
        .nullable()
        .optional()
        .describe("Optional reason recorded for the stage transition."),
      winLossReason: z
        .string()
        .max(2000)
        .nullable()
        .optional()
        .describe("Win or loss reason required when the configured target stage requires it."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "crm.opportunities.manage"),
    featureKey: "crm",
    authorizeReplay: async (context, input) => {
      crmPermission(context, "crm.opportunities.manage");
      await requireFeature(context, "crm");
      const target = await db.execute<{ is_closed: boolean }>(
        sql`select is_closed from crm_opportunity_statuses where id = ${input.statusId} and org_id = ${context.authz.user.orgId} and is_active`,
        "objects",
      );
      if (target[0]?.is_closed) crmPermission(context, "crm.opportunities.close");
    },
    execute: async (context, input) => {
      crmPermission(context, "crm.opportunities.manage");
      await requireFeature(context, "crm");
      const response = await patchCrmOpportunity(
        context.authz,
        input.opportunityId,
        {
          statusId: input.statusId,
          expectedUpdatedAt: input.expectedUpdatedAt,
          ...(input.probability === undefined ? {} : { probability: input.probability }),
          ...(input.forecastCategory === undefined
            ? {}
            : { forecastCategory: input.forecastCategory }),
          ...(input.stageReason === undefined ? {} : { stageReason: input.stageReason }),
          ...(input.winLossReason === undefined ? {} : { winLossReason: input.winLossReason }),
        },
        async () => {
          crmPermission(context, "crm.opportunities.close");
          return null;
        },
        true,
      );
      const opportunity = await settleNativeResponse(response);
      return {
        ok: true,
        opportunityId: input.opportunityId,
        ...opportunity,
        status: opportunity.status_name,
        href: `/crm/opportunities?opportunity=${input.opportunityId}`,
      };
    },
  }),
  crmMutation({
    name: "delete_crm_opportunity",
    title: "Delete CRM Opportunity",
    description:
      "Delete an unlinked opportunity and its CRM-only lines, team, stage history and activity links. Use get_opportunity to confirm the id; opportunities with linked sales documents must be closed instead.",
    inputSchema: z.strictObject({
      opportunityId: UUID.describe("Opportunity UUID returned by get_opportunity."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "crm.opportunities.manage",
    feature: "crm",
    destructive: true,
    execute: async (context, input) => {
      const response = await deleteCrmOpportunity(context.authz, input.opportunityId);
      await settleNativeResponse(response);
      return {
        ok: true,
        opportunityId: input.opportunityId,
        status: "deleted",
        href: "/crm/opportunities",
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
    name: "update_crm_activity",
    title: "Update CRM Activity",
    description:
      "Update an activity or task, including its schedule, owner, participants, links or status. Read the activity with get_crm_activity first and include its current revision; completed or cancelled status changes are retained in the native activity history.",
    inputSchema: activityToolUpdateSchema.safeExtend({
      activityId: UUID.describe("Activity UUID from get_crm_activity or search_crm_activities."),
      expectedUpdatedAt: z
        .string()
        .min(1)
        .max(100)
        .describe("Current revision from get_crm_activity."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "crm.activities.manage",
    feature: "crm",
    execute: async (context, input) => {
      const { idempotencyKey: _key, activityId, ...body } = input;
      const result = await settleNativeResponse(
        await updateCrmActivity(context.authz, { id: activityId }, body, true),
      );
      return {
        ok: true,
        ...result,
        activityId,
        href: `/crm/activities?activity=${activityId}`,
      };
    },
  }),
  crmMutation({
    name: "delete_crm_activity",
    title: "Delete CRM Activity",
    description:
      "Delete an activity or task and its links and participants after checking the audit snapshot rules. Find the id with search_crm_activities and confirm the record with get_crm_activity first.",
    inputSchema: z.strictObject({
      activityId: UUID.describe("Activity UUID from get_crm_activity or search_crm_activities."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "crm.activities.manage",
    feature: "crm",
    destructive: true,
    execute: async (context, input) => {
      const result = await settleNativeResponse(
        await deleteCrmActivity(context.authz, { id: input.activityId }),
      );
      return { ok: true, ...result, activityId: input.activityId, href: "/crm/activities" };
    },
  }),
  crmMutation({
    name: "move_crm_account_stage",
    title: "Move CRM Account Stage",
    description:
      "Move a tracked account to lead, prospect or customer through the account editor's lifecycle rules. Read the current account revision with get_crm_account and stage ids with get_crm_pipeline_setup; moving backward requires a reason.",
    inputSchema: z.strictObject({
      partyId: UUID.describe("Tracked party UUID returned by search_crm_accounts."),
      toStage: z.enum(["lead", "prospect", "customer"]).describe("Target CRM lifecycle stage."),
      statusId: UUID.nullable()
        .optional()
        .describe("Active status in the target stage; omit to use its configured default."),
      reason: z.string().trim().min(1).max(2000).describe("Why the lifecycle stage is changing."),
      expectedUpdatedAt: z
        .string()
        .min(1)
        .max(100)
        .describe("Exact current revision from get_crm_account."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "crm.accounts.manage",
    feature: "crm",
    authorizeReplay: async (context, input) => requireCrmAccountVisible(context, input.partyId),
    execute: async (context, input) => {
      const response = await patchCrmAccount(
        context.authz,
        input.partyId,
        {
          lifecycleStage: input.toStage,
          statusId: input.statusId,
          stageReason: input.reason,
          expectedUpdatedAt: input.expectedUpdatedAt,
        },
        true,
      );
      const result = await settleNativeResponse(response);
      const profile = result.profile as Record<string, unknown> | undefined;
      return {
        ok: true,
        partyId: input.partyId,
        ...result,
        status: profile?.lifecycle_stage,
        href: `/crm/accounts?party=${input.partyId}`,
      };
    },
  }),
  crmMutation({
    name: "convert_crm_lead",
    title: "Convert CRM Lead",
    description:
      "Convert a lead or prospect to an active customer through the account editor's lifecycle rules, including the customer role and stage evidence. Read the current revision with get_crm_account first.",
    inputSchema: z.strictObject({
      partyId: UUID.describe("Tracked party UUID returned by search_crm_accounts."),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Reason for converting the lead to a customer."),
      expectedUpdatedAt: z
        .string()
        .min(1)
        .max(100)
        .describe("Exact current revision from get_crm_account."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "crm.accounts.manage",
    feature: "crm",
    authorizeReplay: async (context, input) => requireCrmAccountVisible(context, input.partyId),
    execute: async (context, input) => {
      const response = await patchCrmAccount(
        context.authz,
        input.partyId,
        {
          lifecycleStage: "customer",
          stageReason: input.reason,
          expectedUpdatedAt: input.expectedUpdatedAt,
        },
        true,
      );
      const result = await settleNativeResponse(response);
      const profile = result.profile as Record<string, unknown> | undefined;
      return {
        ok: true,
        partyId: input.partyId,
        ...result,
        status: profile?.lifecycle_stage,
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
    name: "get_party_bank_accounts",
    title: "Get Party Bank Accounts",
    description:
      "Read the party drawer's bank-detail rows, approval state, masked last four digits and exact revision token. Find the party id with search_parties; account numbers are never returned in plaintext.",
    inputSchema: z.strictObject({
      partyId: UUID.describe("Party UUID returned by search_parties."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "parties.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "parties.read");
      const bankAccountRead = await loadPartyBankAccounts(
        input.partyId,
        context.authz.user.orgId,
        context.authz.allowedSubsidiaryIds,
      );
      if (!bankAccountRead) throw notFound("party");
      return {
        partyId: input.partyId,
        bankAccounts: bankAccountRead.rows,
        href: `/parties?party=${input.partyId}`,
      };
    },
  }),
  definition({
    name: "create_party_bank_account",
    title: "Create Party Bank Account",
    description:
      "Record new party bank details; the account number is encrypted and approval flow rules determine whether the account remains pending or activates. Find the party id with search_parties, and read masked details with get_party_bank_accounts.",
    inputSchema: bankAccountCreateBody.extend({
      partyId: UUID.describe("Party UUID returned by search_parties."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => PARTY_BANK_PERMISSIONS.some((permission) => can(authz, permission)),
    authorizeReplay: async (context, input) => authorizePartyBankTool(context, input.partyId),
    execute: async (context, input) => {
      await authorizePartyBankTool(context, input.partyId);
      const { idempotencyKey: _key, partyId, ...body } = input;
      const result = await settleNativeResponse(
        await createPartyBankAccount({
          request: partyBankRequest(context, partyId),
          authz: context.authz,
          params: { id: partyId },
          body,
        }),
      );
      return {
        ok: true,
        ...result,
        bankAccountId: result.id,
        partyId,
        status: result.approvalStatus,
        href: `/parties?party=${partyId}`,
      };
    },
  }),
  definition({
    name: "update_party_bank_account",
    title: "Update Party Bank Account",
    description:
      "Replace material bank details using the current exact revision and a reason; every material edit re-enters approval and may cancel stale approval gates. Read account ids and revisions with get_party_bank_accounts.",
    inputSchema: bankAccountPatchBody.extend({
      partyId: UUID.describe("Party UUID returned by search_parties."),
      accountId: UUID.describe("Bank-account UUID from get_party_bank_accounts."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => PARTY_BANK_PERMISSIONS.some((permission) => can(authz, permission)),
    authorizeReplay: async (context, input) => authorizePartyBankTool(context, input.partyId),
    execute: async (context, input) => {
      await authorizePartyBankTool(context, input.partyId);
      const { idempotencyKey: _key, partyId, accountId, ...body } = input;
      const result = await settleNativeResponse(
        await updatePartyBankAccount({
          request: partyBankRequest(context, partyId, accountId),
          authz: context.authz,
          params: { id: partyId },
          body,
        }),
      );
      return {
        ok: true,
        ...result,
        bankAccountId: accountId,
        partyId,
        status: result.approvalStatus,
        href: `/parties?party=${partyId}`,
      };
    },
  }),
  definition({
    name: "retire_party_bank_account",
    title: "Retire Party Bank Account",
    description:
      "Retire bank details with the current exact revision and a reason after cancelling in-flight payment instructions and revoking live mandates. Read account ids and revisions with get_party_bank_accounts.",
    inputSchema: bankAccountRetirementBody.extend({
      partyId: UUID.describe("Party UUID returned by search_parties."),
      accountId: UUID.describe("Bank-account UUID from get_party_bank_accounts."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => PARTY_BANK_PERMISSIONS.some((permission) => can(authz, permission)),
    authorizeReplay: async (context, input) => authorizePartyBankTool(context, input.partyId),
    execute: async (context, input) => {
      await authorizePartyBankTool(context, input.partyId);
      const { idempotencyKey: _key, partyId, accountId, ...body } = input;
      const result = await settleNativeResponse(
        await retirePartyBankAccount({
          request: partyBankRequest(context, partyId, accountId),
          authz: context.authz,
          params: { id: partyId },
          body,
        }),
      );
      return {
        ok: true,
        ...result,
        bankAccountId: accountId,
        partyId,
        status: "retired",
        href: `/parties?party=${partyId}`,
      };
    },
  }),
  definition({
    name: "submit_party_bank_account_for_approval",
    title: "Submit Party Bank Account for Approval",
    description:
      "Submit pending party bank details to the configured approval flow, or apply them directly when no flow governs the record. Read pending account ids and statuses with get_party_bank_accounts.",
    inputSchema: z.strictObject({
      partyId: UUID.describe("Party UUID returned by search_parties."),
      accountId: UUID.describe("Pending bank-account UUID from get_party_bank_accounts."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => PARTY_BANK_PERMISSIONS.some((permission) => can(authz, permission)),
    authorizeReplay: async (context, input) => authorizePartyBankTool(context, input.partyId),
    execute: async (context, input) => {
      await authorizePartyBankTool(context, input.partyId);
      const result = await settleNativeResponse(
        await submitPartyBankAccount({
          request: partyBankRequest(context, input.partyId, input.accountId),
          authz: context.authz,
          params: { id: input.partyId },
        }),
      );
      return {
        ok: true,
        ...result,
        bankAccountId: input.accountId,
        partyId: input.partyId,
        status: result.approvalStatus,
        href: `/parties?party=${input.partyId}`,
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
