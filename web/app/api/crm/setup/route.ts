import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { ensureCrmDefaults } from "@openbooks/engine/crm/crm";
import { normalizeMoney } from "@openbooks/engine/money/money";
import { guardUnrestrictedScope } from "@/lib/authz";
import { isFeatureEnabled } from "@/lib/features";
import { isUuid } from "@/lib/list-params";
import { canonicalDecimal, compareDecimal } from "@/lib/exact-decimal";
import { moneyRefusal } from "@/lib/payroll-decimal-refusal";
import { notFound } from "@/lib/api/responses";
import {
  crmAccountStatusBody,
  crmLeadSourceBody,
  crmOpportunityStatusBody,
  loadCrmSetup,
  saveCrmPipelineSetup,
} from "@/lib/crm/setup-actions";

const baseSaveFields = {
  id: uuidString().optional(),
  key: z.string().optional(),
  name: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
};
const baseQuotaFields = {
  id: uuidString().optional(),
  description: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
};
const optionalUserId = z
  .preprocess((value) => (value === "" ? null : value), uuidString().nullable())
  .optional();
const territoryRuleSchema = z
  .object({
    field: z.enum([
      "country",
      "region",
      "industry",
      "lifecycleStage",
      "leadSourceId",
      "annualRevenue",
      "employeeCount",
    ]),
    operator: z.enum(["equals", "in", "contains", "gte", "lte"]),
    value: z.union([z.string(), z.array(z.string()), z.number()]),
  })
  .superRefine((rule, context) => {
    if (rule.field === "annualRevenue") {
      const values =
        typeof rule.value === "string" ? [rule.value] : Array.isArray(rule.value) ? rule.value : [];
      for (const value of values) {
        if (canonicalDecimal(value, 4) === null) {
          context.addIssue({
            code: "custom",
            path: ["value"],
            message: moneyRefusal("Territory annual revenue", value),
          });
        }
      }
      if (typeof rule.value === "number") {
        context.addIssue({
          code: "custom",
          path: ["value"],
          message: moneyRefusal("Territory annual revenue", rule.value),
        });
      }
    }
    if (rule.operator === "in" && !Array.isArray(rule.value)) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "in comparisons require a list of values",
      });
    }
    if (rule.operator !== "in" && Array.isArray(rule.value)) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "this comparison requires one value",
      });
    }
  });
const quotaSchema = z
  .object({
    ...baseQuotaFields,
    action: z.literal("save-quota"),
    ownerUserId: optionalUserId,
    salesTeamId: z
      .preprocess((value) => (value === "" ? null : value), uuidString().nullable())
      .optional(),
    periodStart: z.string().refine(isIsoCalendarDate, "periodStart must be a valid calendar date"),
    periodEnd: z.string().refine(isIsoCalendarDate, "periodEnd must be a valid calendar date"),
    amount: z.string(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    filters: z.record(z.string(), z.json()).optional(),
  })
  .superRefine((body, context) => {
    if ((body.ownerUserId ? 1 : 0) + (body.salesTeamId ? 1 : 0) !== 1) {
      context.addIssue({
        code: "custom",
        path: ["ownerUserId"],
        message: "quota requires exactly one ownerUserId or salesTeamId",
      });
    }
    if (body.periodEnd < body.periodStart) {
      context.addIssue({
        code: "custom",
        path: ["periodEnd"],
        message: "periodEnd must not precede periodStart",
      });
    }
    const amount = canonicalDecimal(body.amount, 4);
    if (amount === null) {
      context.addIssue({
        code: "custom",
        path: ["amount"],
        message: moneyRefusal("Quota amount", body.amount),
      });
    } else if (compareDecimal(amount, "0") < 0) {
      context.addIssue({
        code: "custom",
        path: ["amount"],
        message: "quota amount must be non-negative",
      });
    } else if (amount.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 15) {
      context.addIssue({
        code: "custom",
        path: ["amount"],
        message: "quota amount must fit the ledger (at most 15 whole digits)",
      });
    }
  });
const requestBodySchema = z.discriminatedUnion("action", [
  crmAccountStatusBody,
  crmOpportunityStatusBody,
  crmLeadSourceBody,
  z.object({
    ...baseSaveFields,
    action: z.literal("save-territory"),
    rules: z.array(territoryRuleSchema),
    matchMode: z.enum(["all", "any"]).default("all"),
    priority: z.union([z.number(), z.string()]).optional(),
    managerUserId: optionalUserId,
    defaultOwnerUserId: optionalUserId,
  }),
  z.object({
    ...baseSaveFields,
    action: z.literal("save-team"),
    members: z.array(
      z.object({ userId: uuidString(), role: z.enum(["manager", "member"]).optional() }),
    ),
    managerUserId: optionalUserId,
  }),
  quotaSchema,
]);

export const runtime = "nodejs";

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export const GET = defineRoute({
  permission: "crm.setup.manage",
  feature: "crm",
  handler: async ({ authz: gate }) => {
    // Quotas carry no subsidiary lineage, so a subsidiary-restricted caller
    // must not receive them at all — the same policy as the forecast reader,
    // which hides quotas with a notice instead of an empty-looking list. The
    // rest of setup stays readable; only the quota slice needs full scope.
    const quotasRestricted = gate.allowedSubsidiaryIds !== null;
    const t = await getTranslations("crm");
    return NextResponse.json(
      await loadCrmSetup(
        gate.user.orgId,
        quotasRestricted,
        quotasRestricted ? t("forecasts.quotasRestrictedNotice") : null,
      ),
    );
  },
});

export const POST = defineRoute({
  permission: "crm.setup.manage",
  feature: "crm",
  body: requestBodySchema,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, body }) => {
    const { user } = gate;
    const action = body.action;
    if (
      body.action === "save-account-status" ||
      body.action === "save-opportunity-status" ||
      body.action === "save-lead-source"
    ) {
      const result = await saveCrmPipelineSetup(gate, body);
      return result instanceof NextResponse ? result : NextResponse.json(result);
    }
    if (["save-team", "save-territory", "save-quota"].includes(action))
      return NextResponse.json(
        {
          error:
            "Manage employee sales teams, territories and quotas in Customers → Sell & Collect → Sales.",
          remedy: "Open /crm/sales; sales configuration has moved out of Company Settings.",
        },
        { status: 410 },
      );
    const recordId = body.id ?? null;
    return withOrgTransaction(user.orgId, async () => {
      // Defaults and the requested setup mutation are part of the same unit as
      // the audit append. If audit storage rejects, none of the setup writes
      // (including any defaults created on this request) can commit alone.
      await ensureCrmDefaults(user.orgId, user.id);
      let row: unknown;
      if (action === "save-territory") {
        const name = String(body.name ?? "").trim();
        const matchMode =
          typeof body.matchMode === "string" ? body.matchMode : body.matchMode == null ? "all" : "";
        if (!name || !Array.isArray(body.rules) || !["all", "any"].includes(matchMode))
          return NextResponse.json(
            { error: "valid territory name and rules are required" },
            { status: 422 },
          );
        for (const id of [body.managerUserId, body.defaultOwnerUserId].filter((candidate) =>
          Boolean(candidate),
        ))
          if (
            typeof id !== "string" ||
            !isUuid(id) ||
            !(
              await db.execute(
                sql`select 1 from users where id=${id} and org_id=${user.orgId}`,
                "objects",
              )
            )[0]
          )
            return NextResponse.json({ error: "invalid territory user" }, { status: 422 });
        row = recordId
          ? await db.execute(
              sql`update crm_sales_territories set name=${name},description=${body.description ?? null},priority=${Number(body.priority) || 100},manager_user_id=${body.managerUserId || null},default_owner_user_id=${body.defaultOwnerUserId || null},match_mode=${matchMode},rules=${JSON.stringify(body.rules)}::jsonb,is_active=${body.isActive !== false},updated_at=now(),updated_by=${user.id} where id=${recordId} and org_id=${user.orgId} returning *`,
            )
          : await db.execute(
              sql`insert into crm_sales_territories (org_id,key,name,description,priority,manager_user_id,default_owner_user_id,match_mode,rules,is_active,created_by,updated_by) values (${user.orgId},${slug(typeof body.key === "string" ? body.key || name : name)},${name},${body.description ?? null},${Number(body.priority) || 100},${body.managerUserId || null},${body.defaultOwnerUserId || null},${matchMode},${JSON.stringify(body.rules)}::jsonb,${body.isActive !== false},${user.id},${user.id}) returning *`,
            );
      } else if (action === "save-team") {
        const name = String(body.name ?? "").trim();
        if (!name || !Array.isArray(body.members))
          return NextResponse.json(
            { error: "team name and members are required" },
            { status: 422 },
          );
        const members = [...body.members];
        if (body.managerUserId && !members.some((member) => member.userId === body.managerUserId))
          members.push({ userId: body.managerUserId, role: "manager" });
        // One membership row per user: the unique index would otherwise turn a
        // duplicated entry into a 500 after the team header was written.
        if (new Set(members.map((member) => member.userId)).size !== members.length)
          return NextResponse.json({ error: "duplicate team member" }, { status: 422 });
        for (const member of members)
          if (
            !isUuid(member.userId) ||
            !["manager", "member"].includes(member.role ?? "member") ||
            !(
              await db.execute(
                sql`select 1 from users where id=${member.userId} and org_id=${user.orgId}`,
                "objects",
              )
            )[0]
          )
            return NextResponse.json({ error: "invalid team member" }, { status: 422 });
        const team = recordId
          ? await db.execute<Record<string, unknown>>(
              sql`update crm_sales_teams set name=${name},manager_user_id=${body.managerUserId || null},is_active=${body.isActive !== false},updated_at=now(),updated_by=${user.id} where id=${recordId} and org_id=${user.orgId} returning *`,
            )
          : await db.execute<Record<string, unknown>>(
              sql`insert into crm_sales_teams (org_id,key,name,manager_user_id,is_active,created_by,updated_by) values (${user.orgId},${slug(typeof body.key === "string" ? body.key || name : name)},${name},${body.managerUserId || null},${body.isActive !== false},${user.id},${user.id}) returning *`,
            );
        const teamRow = team.rows[0];
        if (!teamRow) row = team;
        else {
          await db.execute(
            sql`delete from crm_sales_team_members where team_id=${teamRow.id} and org_id=${user.orgId}`,
          );
          for (const member of members)
            await db.execute(
              sql`insert into crm_sales_team_members (org_id,team_id,user_id,role,created_by,updated_by) values (${user.orgId},${teamRow.id},${member.userId},${member.role ?? "member"},${user.id},${user.id})`,
            );
          row = team;
        }
      } else if (action === "save-quota") {
        // Quotas name an owner or team but carry no subsidiary lineage, so a
        // subsidiary-restricted caller must never write them: the quota would
        // price another entity's people. Org-wide write, named 403 remedy.
        const scopeDenied = guardUnrestrictedScope(gate);
        if (scopeDenied) return scopeDenied;
        // Quota currency is Multi-currency configuration. Turning that switch
        // off must refuse a new write; the stored code stays so turning the
        // feature back on restores the same currency. New quotas without a
        // currency fall back to the org base so the NOT NULL column stays valid.
        if (body.currency !== undefined && !(await isFeatureEnabled(user.orgId, "multiCurrency"))) {
          return notFound("record");
        }
        const ownerUserId = body.ownerUserId || null;
        const salesTeamId = body.salesTeamId || null;
        const currency =
          body.currency !== undefined ? String(body.currency).toUpperCase() : undefined;
        // Calendar validity (not just shape) is checked here so an impossible
        // date can never reach the period_start/period_end cast as a 500.
        if (
          (ownerUserId ? 1 : 0) + (salesTeamId ? 1 : 0) !== 1 ||
          !isIsoCalendarDate(body.periodStart) ||
          !isIsoCalendarDate(body.periodEnd) ||
          body.periodEnd < body.periodStart ||
          (currency !== undefined && !/^[A-Z]{3}$/.test(currency))
        )
          return NextResponse.json(
            {
              error: "quota needs one target, a valid period, currency, and a non-negative amount",
            },
            { status: 422 },
          );
        const amountRaw = canonicalDecimal(body.amount, 4);
        if (amountRaw === null)
          return NextResponse.json(
            { error: moneyRefusal("Quota amount", body.amount) },
            { status: 422 },
          );
        if (compareDecimal(amountRaw, "0") < 0)
          return NextResponse.json(
            {
              error: "quota needs one target, a valid period, currency, and a non-negative amount",
            },
            { status: 422 },
          );
        // The quota amount persists into numeric(19,4): refuse wider figures
        // here instead of dying in Postgres as a raw overflow (HTTP 500).
        if (amountRaw.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 15)
          return NextResponse.json(
            { error: "quota amount must fit the ledger (at most 15 whole digits)" },
            { status: 422 },
          );
        const amount = normalizeMoney(amountRaw);
        if (
          currency !== undefined &&
          !(await db.execute(sql`select 1 from currencies where code=${currency}`, "objects"))[0]
        )
          return NextResponse.json({ error: "invalid currency" }, { status: 422 });
        let createCurrency = currency;
        if (createCurrency === undefined && !recordId) {
          const org = await db.execute<{ base_currency: string }>(
            sql`select base_currency from orgs where id=${user.orgId}`,
            "objects",
          );
          createCurrency = org[0]?.base_currency;
          if (!createCurrency)
            return NextResponse.json({ error: "invalid currency" }, { status: 422 });
        }
        if (
          ownerUserId &&
          !(
            await db.execute(
              sql`select 1 from users where id=${ownerUserId} and org_id=${user.orgId}`,
              "objects",
            )
          )[0]
        )
          return NextResponse.json({ error: "invalid quota owner" }, { status: 422 });
        if (
          salesTeamId &&
          !(
            await db.execute(
              sql`select 1 from crm_sales_teams where id=${salesTeamId} and org_id=${user.orgId}`,
              "objects",
            )
          )[0]
        )
          return NextResponse.json({ error: "invalid quota team" }, { status: 422 });
        row = recordId
          ? await db.execute(
              sql`update crm_sales_quotas set owner_user_id=${ownerUserId},sales_team_id=${salesTeamId},period_start=${body.periodStart},period_end=${body.periodEnd},currency=${currency !== undefined ? currency : sql`crm_sales_quotas.currency`},amount=${amount},filters=${JSON.stringify(body.filters ?? {})}::jsonb,updated_at=now(),updated_by=${user.id} where id=${recordId} and org_id=${user.orgId} returning *`,
            )
          : await db.execute(
              sql`insert into crm_sales_quotas (org_id,owner_user_id,sales_team_id,period_start,period_end,currency,amount,filters,created_by,updated_by) values (${user.orgId},${ownerUserId},${salesTeamId},${body.periodStart},${body.periodEnd},${createCurrency},${amount},${JSON.stringify(body.filters ?? {})}::jsonb,${user.id},${user.id}) returning *`,
            );
      } else {
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
      }
      const result = row as { rows?: unknown[] };
      const first = result.rows ? result.rows[0] : row;
      if (!first) return NextResponse.json({ error: "record not found" }, { status: 404 });
      const firstId =
        typeof first === "object" && first !== null && "id" in first ? first.id : null;
      await db.execute(
        sql`insert into audit_log (org_id,table_name,row_id,action,changes,actor_id) values (${user.orgId},'crm_setup',${firstId ?? null},${recordId ? "update" : "insert"},${JSON.stringify({ action, body })}::jsonb,${user.id})`,
      );
      return NextResponse.json(first);
    });
  },
});
