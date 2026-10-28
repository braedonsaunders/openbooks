import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { ensureCrmDefaults } from "@openbooks/engine/crm/crm";
import type { Authz } from "../authz";

const idField = z
  .string()
  .regex(new RegExp(UUID_RE))
  .optional()
  .describe("Existing CRM configuration record UUID; omit to create a new record.");
const nameField = z.string().trim().min(1).max(200).describe("Configuration record name.");
const descriptionField = z
  .string()
  .max(2000)
  .nullable()
  .optional()
  .describe("Optional description, or null to clear it.");
const keyField = z
  .string()
  .max(200)
  .optional()
  .describe("Optional stable record key; a key is generated from the name when omitted.");
const activeField = z
  .boolean()
  .optional()
  .describe("Whether this configuration record remains available for new CRM records.");

export const crmAccountStatusBody = z.object({
  action: z.literal("save-account-status").describe("Save a CRM account lifecycle stage."),
  id: idField,
  key: keyField,
  name: nameField,
  description: descriptionField,
  isActive: activeField,
  lifecycleStage: z
    .enum(["lead", "prospect", "customer"])
    .describe("CRM lifecycle stage associated with this status."),
  sequence: z
    .union([z.number(), z.string().max(40)])
    .optional()
    .describe("Ordering sequence as a whole number."),
  isQualified: z.boolean().optional().describe("Whether accounts in this status are qualified."),
  isClosed: z.boolean().optional().describe("Whether this account status is closed."),
  isDefault: z.boolean().optional().describe("Use this status as the default for its stage."),
});

export const crmOpportunityStatusBody = z.object({
  action: z.literal("save-opportunity-status").describe("Save a CRM opportunity stage."),
  id: idField,
  key: keyField,
  name: nameField,
  description: descriptionField,
  isActive: activeField,
  probability: z
    .union([z.number(), z.string().max(40)])
    .describe("Win probability percentage from 0 to 100."),
  defaultForecastCategory: z
    .enum(["omitted", "worst_case", "most_likely", "upside"])
    .describe("Default forecast category for opportunities in this stage."),
  sequence: z
    .union([z.number(), z.string().max(40)])
    .optional()
    .describe("Ordering sequence as a whole number."),
  isClosed: z.boolean().optional().describe("Whether this opportunity stage is closed."),
  isWon: z.boolean().optional().describe("Whether this stage represents a won opportunity."),
  isDefault: z
    .boolean()
    .optional()
    .describe("Use this stage as the default for new opportunities."),
  requiresLines: z
    .boolean()
    .optional()
    .describe("Require opportunity lines before entering this stage."),
  requiresPrimaryContact: z
    .boolean()
    .optional()
    .describe("Require a primary account contact before entering this stage."),
  requiresPositiveAmount: z
    .boolean()
    .optional()
    .describe("Require a positive opportunity amount before entering this stage."),
  requiresWinLossReason: z
    .boolean()
    .optional()
    .describe("Require a reason when closing an opportunity in this stage."),
});

export const crmLeadSourceBody = z.object({
  action: z.literal("save-lead-source").describe("Save a CRM lead source."),
  id: idField,
  key: keyField,
  name: nameField,
  description: descriptionField,
  isActive: activeField,
});

export const crmPipelineSetupBody = z.discriminatedUnion("action", [
  crmAccountStatusBody,
  crmOpportunityStatusBody,
  crmLeadSourceBody,
]);

export type CrmPipelineSetupInput = z.infer<typeof crmPipelineSetupBody>;

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function sequenceInt(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return 0;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647) return null;
  return n;
}

/** The native setup page reader for CRM lifecycle configuration. */
export async function loadCrmSetup(
  orgId: string,
  quotasRestricted: boolean,
  quotasNotice: string | null,
) {
  const [
    accountStatuses,
    opportunityStatuses,
    territories,
    sources,
    teams,
    members,
    quotas,
    users,
  ] = await Promise.all([
    db.execute(
      sql`select * from crm_account_statuses where org_id = ${orgId} order by lifecycle_stage, sequence, name`,
      "objects",
    ),
    db.execute(
      sql`select * from crm_opportunity_statuses where org_id = ${orgId} order by sequence, name`,
      "objects",
    ),
    db.execute(
      sql`select t.*, mu.name as manager_name, ou.name as owner_name from crm_sales_territories t left join users mu on mu.id=t.manager_user_id left join users ou on ou.id=t.default_owner_user_id where t.org_id=${orgId} order by t.priority,t.name`,
      "objects",
    ),
    db.execute(sql`select * from crm_lead_sources where org_id=${orgId} order by name`, "objects"),
    db.execute(
      sql`select t.*, u.name as manager_name from crm_sales_teams t left join users u on u.id=t.manager_user_id where t.org_id=${orgId} order by t.name`,
      "objects",
    ),
    db.execute(
      sql`select m.*,u.name as user_name from crm_sales_team_members m join users u on u.id=m.user_id where m.org_id=${orgId} order by u.name`,
      "objects",
    ),
    quotasRestricted
      ? Promise.resolve([])
      : db.execute(
          sql`select q.*,u.name as owner_name,t.name as team_name from crm_sales_quotas q left join users u on u.id=q.owner_user_id left join crm_sales_teams t on t.id=q.sales_team_id where q.org_id=${orgId} order by q.period_start desc`,
          "objects",
        ),
    db.execute(
      sql`select id,name,email from users where org_id=${orgId} and is_active order by name`,
      "objects",
    ),
  ]);
  return {
    accountStatuses,
    opportunityStatuses,
    territories,
    sources,
    teams,
    members,
    quotas,
    users,
    quotasNotice,
  };
}

/** Save account stages, opportunity stages, or lead sources for the CRM setup page. */
export async function saveCrmPipelineSetup(authz: Authz, body: CrmPipelineSetupInput) {
  const { user } = authz;
  const recordId = body.id ?? null;
  return withOrgTransaction(user.orgId, async () => {
    await ensureCrmDefaults(user.orgId, user.id);
    let row: unknown;
    if (body.action === "save-account-status") {
      const sequence = sequenceInt(body.sequence);
      if (sequence === null)
        return NextResponse.json({ error: "sequence must be a whole number" }, { status: 422 });
      row = recordId
        ? await db.execute(
            sql`update crm_account_statuses set name=${body.name},description=${body.description ?? null},lifecycle_stage=${body.lifecycleStage},sequence=${sequence},is_qualified=${body.isQualified === true},is_closed=${body.isClosed === true},is_default=${body.isDefault === true},is_active=${body.isActive !== false},updated_at=now(),updated_by=${user.id} where id=${recordId} and org_id=${user.orgId} returning *`,
          )
        : await db.execute(
            sql`insert into crm_account_statuses (org_id,key,name,description,lifecycle_stage,sequence,is_qualified,is_closed,is_default,is_active,created_by,updated_by) values (${user.orgId},${slug(body.key || body.name)},${body.name},${body.description ?? null},${body.lifecycleStage},${sequence},${body.isQualified === true},${body.isClosed === true},${body.isDefault === true},${body.isActive !== false},${user.id},${user.id}) returning *`,
          );
    } else if (body.action === "save-opportunity-status") {
      const probability = Number(body.probability);
      const sequence = sequenceInt(body.sequence);
      if (!Number.isInteger(probability) || probability < 0 || probability > 100)
        return NextResponse.json(
          { error: "name and probability from 0 to 100 are required" },
          { status: 422 },
        );
      if (sequence === null)
        return NextResponse.json({ error: "sequence must be a whole number" }, { status: 422 });
      if (body.isWon === true && body.isClosed !== true)
        return NextResponse.json({ error: "a won stage must be closed" }, { status: 422 });
      row = recordId
        ? await db.execute(
            sql`update crm_opportunity_statuses set name=${body.name},description=${body.description ?? null},sequence=${sequence},probability=${probability},default_forecast_category=${body.defaultForecastCategory},is_closed=${body.isClosed === true},is_won=${body.isWon === true},is_default=${body.isDefault === true},is_active=${body.isActive !== false},requires_lines=${body.requiresLines === true},requires_primary_contact=${body.requiresPrimaryContact === true},requires_positive_amount=${body.requiresPositiveAmount === true},requires_win_loss_reason=${body.requiresWinLossReason === true},updated_at=now(),updated_by=${user.id} where id=${recordId} and org_id=${user.orgId} returning *`,
          )
        : await db.execute(
            sql`insert into crm_opportunity_statuses (org_id,key,name,description,sequence,probability,default_forecast_category,is_closed,is_won,is_default,is_active,requires_lines,requires_primary_contact,requires_positive_amount,requires_win_loss_reason,created_by,updated_by) values (${user.orgId},${slug(body.key || body.name)},${body.name},${body.description ?? null},${sequence},${probability},${body.defaultForecastCategory},${body.isClosed === true},${body.isWon === true},${body.isDefault === true},${body.isActive !== false},${body.requiresLines === true},${body.requiresPrimaryContact === true},${body.requiresPositiveAmount === true},${body.requiresWinLossReason === true},${user.id},${user.id}) returning *`,
          );
    } else {
      row = recordId
        ? await db.execute(
            sql`update crm_lead_sources set name=${body.name},description=${body.description ?? null},is_active=${body.isActive !== false},updated_at=now(),updated_by=${user.id} where id=${recordId} and org_id=${user.orgId} returning *`,
          )
        : await db.execute(
            sql`insert into crm_lead_sources (org_id,key,name,description,is_active,created_by,updated_by) values (${user.orgId},${slug(body.key || body.name)},${body.name},${body.description ?? null},${body.isActive !== false},${user.id},${user.id}) returning *`,
          );
    }
    const result = row as { rows?: unknown[] };
    const first = result.rows ? result.rows[0] : row;
    if (!first) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const firstId = typeof first === "object" && first !== null && "id" in first ? first.id : null;
    await db.execute(
      sql`insert into audit_log (org_id,table_name,row_id,action,changes,actor_id) values (${user.orgId},'crm_setup',${firstId ?? null},${recordId ? "update" : "insert"},${JSON.stringify({ action: body.action, body })}::jsonb,${user.id})`,
    );
    return first as Record<string, unknown>;
  });
}
