import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { matchesTerritory, shouldPromoteLifecycle, type CrmLifecycleStage, type TerritorySubject } from "./crm-math.ts";

type SqlExecutor = Pick<typeof db, "execute">;

async function crmFeatureEnabled(executor: SqlExecutor, orgId: string): Promise<boolean> {
  const result = (await executor.execute<{ enabled: boolean }>(sql`
    select coalesce((settings->'features'->>'crm')::boolean, true) as enabled
      from orgs where id = ${orgId}
  `));
  return result.rows[0]?.enabled === true;
}

const DEFAULT_ACCOUNT_STATUSES = [
  ["lead", "new", "New", false, false, true],
  ["lead", "working", "Working", false, false, false],
  ["lead", "qualified", "Qualified", true, false, false],
  ["lead", "disqualified", "Disqualified", false, true, false],
  ["prospect", "open", "Open", true, false, true],
  ["prospect", "nurturing", "Nurturing", true, false, false],
  ["prospect", "closed_lost", "Closed lost", false, true, false],
  ["customer", "active", "Active", true, false, true],
  ["customer", "inactive", "Inactive", false, true, false],
] as const;

const DEFAULT_OPPORTUNITY_STATUSES = [
  ["qualification", "Qualification", 10, "upside", false, false, true],
  ["discovery", "Discovery", 25, "upside", false, false, false],
  ["proposal", "Proposal", 50, "most_likely", false, false, false],
  ["negotiation", "Negotiation", 75, "most_likely", false, false, false],
  ["closed_won", "Closed won", 100, "worst_case", true, true, false],
  ["closed_lost", "Closed lost", 0, "omitted", true, false, false],
] as const;

/** Idempotent tenant bootstrap; safe to call before every CRM draft. */
export async function ensureCrmDefaults(
  orgId: string,
  actorId: string | null = null,
  executor: SqlExecutor = db,
): Promise<void> {
  if (!(await crmFeatureEnabled(executor, orgId))) return;
  for (let sequence = 0; sequence < DEFAULT_ACCOUNT_STATUSES.length; sequence++) {
    const [stage, key, name, qualified, closed, isDefault] = DEFAULT_ACCOUNT_STATUSES[sequence]!;
    await executor.execute(sql`
      insert into crm_account_statuses
        (org_id, lifecycle_stage, key, name, sequence, is_qualified, is_closed, is_default, created_by, updated_by)
      values (${orgId}, ${stage}, ${key}, ${name}, ${sequence}, ${qualified}, ${closed}, ${isDefault}, ${actorId}, ${actorId})
      on conflict (org_id, lifecycle_stage, key) do nothing`);
  }
  for (let sequence = 0; sequence < DEFAULT_OPPORTUNITY_STATUSES.length; sequence++) {
    const [key, name, probability, category, closed, won, isDefault] = DEFAULT_OPPORTUNITY_STATUSES[sequence]!;
    await executor.execute(sql`
      insert into crm_opportunity_statuses
        (org_id, key, name, sequence, probability, default_forecast_category, is_closed, is_won, is_default, created_by, updated_by)
      values (${orgId}, ${key}, ${name}, ${sequence}, ${probability}, ${category}, ${closed}, ${won}, ${isDefault}, ${actorId}, ${actorId})
      on conflict (org_id, key) do nothing`);
  }
}

/** Promote an account and write immutable evidence in the caller's transaction. */
export async function promoteCrmAccount(
  executor: SqlExecutor,
  input: {
    orgId: string;
    partyId: string;
    actorId: string;
    toStage: CrmLifecycleStage;
    sourceKind: string;
    sourceId?: string | null;
    reason?: string | null;
  },
): Promise<boolean> {
  if (!(await crmFeatureEnabled(executor, input.orgId))) return false;
  const existing = (await executor.execute<{ id: string; lifecycle_stage: CrmLifecycleStage }>(sql`
    select id, lifecycle_stage from crm_account_profiles
     where org_id = ${input.orgId} and party_id = ${input.partyId} for update
  `));

  let profileId = existing.rows[0]?.id;
  let fromStage = existing.rows[0]?.lifecycle_stage;
  if (!profileId) {
    const status = (await executor.execute<{ id: string }>(sql`
      select id from crm_account_statuses
       where org_id = ${input.orgId} and lifecycle_stage = ${input.toStage} and is_default and is_active
       order by sequence limit 1`));
    const inserted = (await executor.execute<{ id: string }>(sql`
      insert into crm_account_profiles
        (org_id, party_id, lifecycle_stage, status_id, converted_at, created_by, updated_by)
      values (${input.orgId}, ${input.partyId}, ${input.toStage}, ${status.rows[0]?.id ?? null},
              ${input.toStage === "customer" ? sql`now()` : null}, ${input.actorId}, ${input.actorId})
      returning id`));
    profileId = inserted.rows[0]!.id;
  } else {
    if (!shouldPromoteLifecycle(fromStage!, input.toStage)) return false;
    const status = (await executor.execute<{ id: string }>(sql`
      select id from crm_account_statuses
       where org_id = ${input.orgId} and lifecycle_stage = ${input.toStage} and is_default and is_active
       order by sequence limit 1`));
    await executor.execute(sql`
      update crm_account_profiles set lifecycle_stage = ${input.toStage}, status_id = ${status.rows[0]?.id ?? null},
             qualified_at = case when ${input.toStage} = 'prospect' and qualified_at is null then now() else qualified_at end,
             converted_at = case when ${input.toStage} = 'customer' and converted_at is null then now() else converted_at end,
             updated_at = now(), updated_by = ${input.actorId}
       where id = ${profileId}`);
  }

  if (input.toStage === "customer") {
    await executor.execute(sql`
      insert into customer_roles (org_id, party_id, is_active, created_by, updated_by)
      values (${input.orgId}, ${input.partyId}, true, ${input.actorId}, ${input.actorId})
      on conflict (party_id) do update set is_active = true, updated_at = now(), updated_by = ${input.actorId}`);
  }
  await executor.execute(sql`
    insert into crm_account_stage_events
      (org_id, account_profile_id, from_stage, to_stage, source_kind, source_id, reason, created_by, updated_by)
    values (${input.orgId}, ${profileId}, ${fromStage ?? null}, ${input.toStage}, ${input.sourceKind},
            ${input.sourceId ?? null}, ${input.reason ?? null}, ${input.actorId}, ${input.actorId})`);
  return true;
}

/** Route one account using the first matching active territory by priority. */
export async function routeCrmAccount(orgId: string, profileId: string, actorId: string): Promise<string | null> {
  if (!(await crmFeatureEnabled(db, orgId))) return null;
  return db.transaction(async (tx) => {
    const account = (await tx.execute<any>(sql`
      select cp.id, cp.lifecycle_stage, cp.lead_source_id, cp.industry, cp.annual_revenue, cp.employee_count,
             cp.owner_user_id, cp.territory_id, a.country, a.region
        from crm_account_profiles cp
        left join lateral (
          select country, region from addresses where party_id = cp.party_id
          order by is_default_billing desc, created_at limit 1
        ) a on true
       where cp.id = ${profileId} and cp.org_id = ${orgId} for update`));
    const row = account.rows[0];
    if (!row) return null;
    const territories = (await tx.execute<any>(sql`
      select id, rules, match_mode, default_owner_user_id
        from crm_sales_territories where org_id = ${orgId} and is_active
       order by priority, created_at`));
    const subject: TerritorySubject = {
      country: row.country,
      region: row.region,
      industry: row.industry,
      lifecycleStage: row.lifecycle_stage,
      leadSourceId: row.lead_source_id,
      annualRevenue: row.annual_revenue,
      employeeCount: row.employee_count,
    };
    const territory = territories.rows.find((candidate) => matchesTerritory(subject, candidate.rules ?? [], candidate.match_mode));
    if (!territory || (territory.id === row.territory_id && (!territory.default_owner_user_id || territory.default_owner_user_id === row.owner_user_id))) {
      return territory?.id ?? null;
    }
    await tx.execute(sql`
      update crm_account_profiles set territory_id = ${territory.id},
             owner_user_id = coalesce(${territory.default_owner_user_id}, owner_user_id),
             updated_at = now(), updated_by = ${actorId}
       where id = ${profileId}`);
    await tx.execute(sql`
      insert into crm_account_assignment_events
        (org_id, account_profile_id, from_owner_user_id, to_owner_user_id, from_territory_id, to_territory_id,
         source, reason, created_by, updated_by)
      values (${orgId}, ${profileId}, ${row.owner_user_id}, ${territory.default_owner_user_id ?? row.owner_user_id},
              ${row.territory_id}, ${territory.id}, 'routing', 'Matched territory rules', ${actorId}, ${actorId})`);
    return territory.id;
  });
}

export async function nextOpportunityNumber(orgId: string): Promise<string> {
  if (!(await crmFeatureEnabled(db, orgId))) throw new Error("CRM feature is disabled");
  const seq = (await db.execute<{ prefix: string; next_number: number; padding: number }>(sql`
    insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
    values (${orgId}, 'crm_opportunity', null, 'OPP-')
    on conflict on constraint sequences_org_kind_sub
    do update set next_number = number_sequences.next_number + 1
    returning prefix, next_number, padding
  `));
  const row = seq.rows[0]!;
  return `${row.prefix}${String(row.next_number).padStart(row.padding, "0")}`;
}
