import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { can, type Authz } from "../authz";
import { isFeatureEnabled } from "../features";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import {
  cardBodySchema,
  createLaborRateCard,
  createLaborRateCardSchema,
  updateLaborRateCard,
} from "../labor-rate-card-actions";

const KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from the labor rate card version read.");
const canManageSetup = (authz: Authz) => can(authz, "admin.setup.manage");

async function requireProjects(context: ApplicationContext) {
  if (!(await isFeatureEnabled(context.authz.user.orgId, "projects")))
    throw notFound("labor rate card");
}

async function settleResponse(response: Response, id: string, status?: string) {
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      typeof payload.error === "string"
        ? payload.error
        : typeof payload.errorCode === "string"
          ? payload.errorCode
          : "Labor rate card could not be saved";
    if (response.status === 404) throw notFound(message);
    if (response.status === 409) throw conflict(message, { code: payload.errorCode });
    if (response.status === 403) throw new ApplicationError("forbidden", message, 403);
    throw invalidInput(message, { code: payload.errorCode });
  }
  return {
    ok: true,
    id,
    ...(status ? { status } : {}),
    href: `/admin/setup/labor-costing?version=${encodeURIComponent(id)}`,
  };
}

export const PROJECT_LABOR_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_labor_rate_cards",
    title: "List Labor Rate Cards",
    description:
      "List effective-dated labor rate card versions by status and name. This mirrors the Labor Pricing setup list and returns version ids for update_labor_rate_card.",
    inputSchema: z.object({
      status: z
        .enum(["active", "scheduled", "expired", "all"])
        .optional()
        .describe("Filter by effective status; defaults to active."),
      query: z.string().max(200).optional().describe("Search rate book name, code, or currency."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum versions to return; defaults to 50."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: canManageSetup,
    featureKey: "projects",
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      await requireProjects(context);
      const today = await businessToday(context.authz.user.orgId);
      const status = input.status ?? "active";
      const statusFilter =
        status === "active"
          ? sql`and v.status='active' and v.effective_from <= ${today} and (v.effective_to is null or v.effective_to >= ${today})`
          : status === "scheduled"
            ? sql`and v.status <> 'retired' and v.effective_from > ${today}`
            : status === "expired"
              ? sql`and (v.status='retired' or v.effective_to < ${today})`
              : sql``;
      const rows = await db.execute(
        sql`
        select v.id, v.rate_book_id as "rateBookId", b.code, b.name, b.currency,
               v.effective_from::text as "effectiveFrom", v.effective_to::text as "effectiveTo",
               v.status, p.derivation_policy as "derivationPolicy",
               (select count(*)::int from item_rate_lines l where l.version_id=v.id and l.org_id=v.org_id) as "lineCount",
               (select count(*)::int from item_rate_book_assignments a where a.rate_book_id=b.id and a.org_id=b.org_id and a.is_active) as "assignmentCount"
          from item_rate_versions v
          join item_rate_books b on b.id=v.rate_book_id and b.org_id=v.org_id
          join labor_rate_version_policies p on p.version_id=v.id and p.org_id=v.org_id
         where v.org_id=${context.authz.user.orgId} ${statusFilter}
           ${input.query ? sql`and (b.name ilike ${`%${input.query}%`} or b.code ilike ${`%${input.query}%`} or b.currency ilike ${`%${input.query}%`})` : sql``}
         order by v.effective_from desc,b.name
         limit ${input.limit ?? 50}
      `,
        "objects",
      );
      return { ok: true, items: rows, href: "/admin/setup/labor-pricing" };
    },
  }),
  definition({
    name: "get_labor_rate_card",
    title: "Get Labor Rate Card",
    description:
      "Read one labor rate card version with its lines, scopes, adjustments, and terms. Find the version id with list_labor_rate_cards; use the returned full values for update_labor_rate_card.",
    inputSchema: z.object({
      versionId: UUID.describe("Labor rate version id from list_labor_rate_cards."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: canManageSetup,
    featureKey: "projects",
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      await requireProjects(context);
      const rows = await db.execute(
        sql`
        select v.id, v.rate_book_id as "rateBookId", b.code, b.name, b.currency,
               v.effective_from::text as "effective_from", v.effective_to::text as "effective_to",
               v.status, p.derivation_policy, v.custom,
          coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'scopeType',s.scope_type,'scopeValueId',s.scope_value_id,'scopeValueText',s.scope_value_text,'includeChildren',s.include_children) order by s.created_at) from labor_rate_version_scopes s where s.version_id=v.id and s.org_id=v.org_id),'[]'::jsonb) scopes,
          coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'code',a.code,'name',a.name,'category',a.category,'calculation',a.calculation,'value',a.value,'unit',a.unit,'presentation',a.presentation,'threshold',a.threshold,'thresholdUnit',a.threshold_unit,'referenceText',a.reference_text,'targets',coalesce((select jsonb_agg(jsonb_build_object('targetType',at.target_type,'targetValueId',at.target_value_id,'targetValueText',at.target_value_text,'includeChildren',at.include_children) order by at.created_at) from labor_rate_adjustment_targets at where at.adjustment_id=a.id and at.org_id=a.org_id),'[]'::jsonb)) order by a.sort_order,a.id) from labor_rate_adjustments a where a.version_id=v.id and a.org_id=v.org_id and a.is_active),'[]'::jsonb) adjustments,
          coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'code',t.code,'label',t.label,'content',t.content,'placement',t.placement) order by t.sort_order,t.id) from labor_rate_terms t where t.version_id=v.id and t.org_id=v.org_id),'[]'::jsonb) terms,
          coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'itemId',l.item_id,'regular',l.bill_rate,'timeTypeRates',l.time_type_bill_rates) order by l.sort_order,l.id) from item_rate_lines l where l.version_id=v.id and l.org_id=v.org_id),'[]'::jsonb) lines
          from item_rate_versions v
          join item_rate_books b on b.id=v.rate_book_id and b.org_id=v.org_id
          join labor_rate_version_policies p on p.version_id=v.id and p.org_id=v.org_id
         where v.id=${input.versionId} and v.org_id=${context.authz.user.orgId}
      `,
        "objects",
      );
      if (!rows[0]) throw notFound("labor rate card");
      return {
        ok: true,
        card: rows[0],
        href: `/admin/setup/labor-pricing?card=${input.versionId}`,
      };
    },
  }),
  definition({
    name: "create_labor_rate_card",
    title: "Create Labor Rate Card",
    description:
      "Create a labor rate card and its initial draft version. Use setup reads to find the base currency, then verify the new version in Labor Costing setup.",
    inputSchema: createLaborRateCardSchema.extend({ idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManageSetup,
    featureKey: "projects",
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      await requireProjects(context);
      const response = await createLaborRateCard(context.authz, input);
      const payload = (await response.clone().json()) as Record<string, unknown>;
      const id = typeof payload.id === "string" ? payload.id : "";
      return settleResponse(response, id, "draft");
    },
  }),
  definition({
    name: "update_labor_rate_card",
    title: "Update Labor Rate Card",
    description:
      "Save a labor rate card version's effective dates, rates, scopes, adjustments, and terms. Find version and item ids with Labor Costing and item reads; use the version's full current values because this is a complete save.",
    inputSchema: cardBodySchema.extend({
      versionId: UUID.describe("Labor rate version id."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManageSetup,
    featureKey: "projects",
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      await requireProjects(context);
      const { versionId, idempotencyKey: _key, ...body } = input;
      const response = await updateLaborRateCard(context.authz, versionId, body);
      const payload = (await response.clone().json()) as Record<string, unknown>;
      const id = typeof payload.id === "string" ? payload.id : versionId;
      return settleResponse(response, id, input.status);
    },
  }),
];
