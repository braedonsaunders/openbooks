import "server-only";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import {
  ensureCrmDefaults,
  nextOpportunityNumber,
  promoteCrmAccount,
} from "@openbooks/engine/crm/crm";
import type { Authz } from "../authz";
import { crmSharedScope, crmSubjectVisible, lockCrmLinkSubject } from "../crm-scope";
import { loadCrmAccount } from "../crm";
import { isUuid } from "../list-params";
import { notFound } from "../api/responses";

export type CrmActionResponse<T extends Record<string, unknown>> =
  { response: NextResponse } | { body: T; status: number };

function response<T extends Record<string, unknown>>(body: T, status = 200): CrmActionResponse<T> {
  return { body, status };
}

/** Create a lead or prospect placeholder with its first immutable stage event. */
export async function createCrmAccountDraft(
  authz: Authz,
  stage: "lead" | "prospect" = "lead",
): Promise<CrmActionResponse<{ id: string }>> {
  const { user } = authz;
  if (authz.allowedSubsidiaryIds?.size === 0) return { response: notFound("record") };
  const reason = stage === "lead" ? "Lead created" : "Prospect created";
  await ensureCrmDefaults(user.orgId, user.id);
  const result = await db.transaction(async (tx) => {
    const party = await tx.execute<{ id: string }>(
      sql`insert into parties (org_id, kind, display_name, is_active, created_by, updated_by)
        values (${user.orgId}, 'company', 'New lead', false, ${user.id}, ${user.id}) returning id`,
      "objects",
    );
    const status = await tx.execute<{ id: string }>(
      sql`select id from crm_account_statuses
        where org_id = ${user.orgId} and lifecycle_stage = ${stage} and is_default and is_active
        order by sequence limit 1`,
      "objects",
    );
    const profile = await tx.execute<{ id: string }>(
      sql`insert into crm_account_profiles
          (org_id, party_id, lifecycle_stage, status_id, owner_user_id, is_active, created_by, updated_by)
        values (${user.orgId}, ${party[0]!.id}, ${stage}, ${status[0]?.id ?? null}, ${user.id}, false, ${user.id}, ${user.id})
        returning id`,
      "objects",
    );
    await tx.execute(sql`insert into crm_account_stage_events
        (org_id, account_profile_id, to_stage, source_kind, reason, created_by, updated_by)
      values (${user.orgId}, ${profile[0]!.id}, ${stage}, 'manual', ${reason}, ${user.id}, ${user.id})`);
    return { id: party[0]!.id };
  });
  return response(result);
}

/** Start relationship tracking for a party that was created outside the CRM flow. */
export async function startCrmAccountTracking(
  authz: Authz,
  partyId: string,
): Promise<CrmActionResponse<{ account: unknown }>> {
  const { user } = authz;
  if (!isUuid(partyId)) return { response: notFound("record") };
  const created = await db.transaction(async (tx) => {
    const party = await tx.execute<{ id: string }>(
      sql`select id from parties where id = ${partyId} and org_id = ${user.orgId}${crmSharedScope(sql`subsidiary_id`, authz.allowedSubsidiaryIds)} for update`,
      "objects",
    );
    if (!party.length) return "missing" as const;
    const existing = await tx.execute<{ id: string }>(
      sql`select id from crm_account_profiles where org_id = ${user.orgId} and party_id = ${partyId}`,
      "objects",
    );
    if (existing.length) return "exists" as const;
    const isCustomer =
      (
        await tx.execute(
          sql`select 1 from customer_roles where org_id = ${user.orgId} and party_id = ${partyId} and is_active`,
          "objects",
        )
      ).length > 0;
    const stage = isCustomer ? "customer" : "lead";
    const status = await tx.execute<{ id: string }>(
      sql`select id from crm_account_statuses
        where org_id = ${user.orgId} and lifecycle_stage = ${stage} and is_default and is_active
        order by sequence limit 1`,
      "objects",
    );
    const profile = await tx.execute<{ id: string }>(
      sql`insert into crm_account_profiles
          (org_id, party_id, lifecycle_stage, status_id, owner_user_id, converted_at, is_active, created_by, updated_by)
        values (${user.orgId}, ${partyId}, ${stage}, ${status[0]?.id ?? null}, ${user.id},
                ${stage === "customer" ? sql`now()` : null}, true, ${user.id}, ${user.id})
        returning id`,
      "objects",
    );
    if (!profile[0]) throw new Error("The CRM relationship was not created.");
    await tx.execute(sql`insert into crm_account_stage_events
        (org_id, account_profile_id, to_stage, source_kind, reason, created_by, updated_by)
      values (${user.orgId}, ${profile[0].id}, ${stage}, 'manual', 'Relationship tracking started', ${user.id}, ${user.id})`);
    return "created" as const;
  });
  if (created === "missing") return { response: notFound("record") };
  const account = await loadCrmAccount(partyId, user.orgId, authz.allowedSubsidiaryIds);
  return response({ account });
}

/** Create an opportunity draft and promote its linked account to prospect. */
export async function createCrmOpportunityDraft(
  authz: Authz,
  partyId: string | null,
): Promise<CrmActionResponse<{ id: string }>> {
  const { user } = authz;
  if (authz.allowedSubsidiaryIds?.size === 0) return { response: notFound("record") };
  if (partyId) {
    const exists = await db.execute<{ is_active: boolean }>(
      sql`select is_active from parties where id = ${partyId} and org_id = ${user.orgId}${crmSharedScope(sql`subsidiary_id`, authz.allowedSubsidiaryIds)}`,
      "objects",
    );
    if (!exists[0]) {
      return { response: NextResponse.json({ error: "account not found" }, { status: 404 }) };
    }
    if (!exists[0].is_active) {
      return {
        response: NextResponse.json(
          { error: "an active account is required for new opportunities" },
          { status: 422 },
        ),
      };
    }
  }
  await ensureCrmDefaults(user.orgId, user.id);
  const [number, org] = await Promise.all([
    nextOpportunityNumber(user.orgId),
    db.execute<{ base_currency: string }>(
      sql`select base_currency from orgs where id = ${user.orgId}`,
      "objects",
    ),
  ]);
  const opportunity = await db.transaction(async (tx) => {
    if (partyId) {
      const visible = await tx.execute<{ id: string; is_active: boolean }>(
        sql`select id, is_active from parties where id=${partyId} and org_id=${user.orgId}${crmSharedScope(sql`subsidiary_id`, authz.allowedSubsidiaryIds)} for update`,
        "objects",
      );
      if (!visible[0]) return { response: notFound("record") } as const;
      if (!visible[0].is_active) {
        return {
          response: NextResponse.json(
            { error: "an active account is required for new opportunities" },
            { status: 422 },
          ),
        } as const;
      }
    }
    const statuses = await tx.execute<{
      id: string;
      probability: number;
      default_forecast_category: string;
    }>(
      sql`select id, probability, default_forecast_category from crm_opportunity_statuses
        where org_id = ${user.orgId} and is_default and is_active order by sequence limit 1`,
      "objects",
    );
    const status = statuses[0];
    if (!status || !org[0]?.base_currency) {
      return {
        response: NextResponse.json(
          {
            error:
              "Configure an active default opportunity status and organization currency first.",
          },
          { status: 422 },
        ),
      } as const;
    }
    const inserted = await tx.execute<{ id: string }>(
      sql`insert into crm_opportunities
          (org_id, opportunity_number, title, party_id, owner_user_id, status_id, probability,
           forecast_category, currency, is_active, created_by, updated_by)
        values (${user.orgId}, ${number}, 'New opportunity', ${partyId}, ${user.id}, ${status.id},
                ${status.probability}, ${status.default_forecast_category}, ${org[0].base_currency}, false, ${user.id}, ${user.id})
        returning id`,
      "objects",
    );
    if (!inserted[0]) throw new Error("The opportunity draft was not created.");
    if (partyId) {
      await promoteCrmAccount(tx, {
        orgId: user.orgId,
        partyId,
        actorId: user.id,
        toStage: "prospect",
        sourceKind: "opportunity",
        sourceId: inserted[0].id,
      });
    }
    await tx.execute(sql`insert into crm_opportunity_stage_events
        (org_id, opportunity_id, to_status_id, probability, forecast_category, reason, created_by, updated_by)
      values (${user.orgId}, ${inserted[0].id}, ${status.id}, ${status.probability}, ${status.default_forecast_category},
              'Opportunity created', ${user.id}, ${user.id})`);
    return { body: inserted[0], status: 200 } as const;
  });
  return "response" in opportunity
    ? { response: opportunity.response }
    : response(opportunity.body, opportunity.status);
}

/** Create a CRM task or activity draft and attach its optional visible subject. */
export async function createCrmActivityDraft(
  authz: Authz,
  input: {
    kind?: "task" | "call" | "event" | "email" | "note";
    subjectKind?: "account" | "contact" | "opportunity" | "document" | "project";
    subjectId?: string;
  },
): Promise<CrmActionResponse<{ id: string }>> {
  const { user } = authz;
  if (authz.allowedSubsidiaryIds?.size === 0) return { response: notFound("record") };
  const activity = await db.transaction(async (tx) => {
    if (input.subjectKind && input.subjectId) {
      const exists = await lockCrmLinkSubject(tx, user.orgId, input.subjectKind, input.subjectId);
      const valid = exists
        ? await tx.execute(
            sql`select 1 where ${crmSubjectVisible(sql`${user.orgId}`, sql`${input.subjectKind}`, sql`${input.subjectId}`, authz.allowedSubsidiaryIds)}`,
            "objects",
          )
        : [];
      if (!valid.length) return { response: notFound("record") } as const;
    }
    const inserted = await tx.execute<{ id: string }>(
      sql`insert into crm_activities
          (org_id, kind, subject, status, owner_user_id, assigned_user_id, created_by, updated_by)
        values (${user.orgId}, ${input.kind ?? "task"}, 'New activity', 'planned', ${user.id}, ${user.id}, ${user.id}, ${user.id})
        returning id`,
      "objects",
    );
    if (!inserted[0]) throw new Error("The CRM activity draft was not created.");
    if (input.subjectKind && input.subjectId) {
      await tx.execute(sql`insert into crm_activity_links
          (org_id, activity_id, subject_kind, subject_id, created_by, updated_by)
        values (${user.orgId}, ${inserted[0].id}, ${input.subjectKind}, ${input.subjectId}, ${user.id}, ${user.id})`);
    }
    return { body: inserted[0], status: 200 } as const;
  });
  return "response" in activity
    ? { response: activity.response }
    : response(activity.body, activity.status);
}
