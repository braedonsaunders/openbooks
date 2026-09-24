import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { matchesTerritory, shouldPromoteLifecycle, type CrmLifecycleStage, type TerritoryRule, type TerritorySubject } from "./crm-math.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";

/**
 * The stage gate lives in crm-math.ts because it is pure and this module is
 * not (it imports the database). Re-exported here so a caller reaching for
 * "the CRM engine" finds it without having to know which half it lives in,
 * and so a unit test can import it without dragging a connection along.
 */
export {
  validateOpportunityStageTransition,
  type OpportunityStagePolicy,
  type OpportunityStageRefusal,
  type OpportunityStageSubject,
} from "./crm-math.ts";

type SqlExecutor = Pick<typeof db, "execute">;

// Canonical switchboard read: the previous inline ::boolean cast threw
// 22P02 on a non-boolean stored value.
async function crmFeatureEnabled(executor: SqlExecutor, orgId: string): Promise<boolean> {
  return orgFeatureEnabled(orgId, "crm", executor);
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

/**
 * Suggested starting stages, not the model: every one of these is an ordinary
 * per-organization row an administrator can rename, reorder, retire or replace
 * (crm_opportunity_statuses). Nothing in the product may branch on these keys.
 *
 * The last field is the stage's entry policy (migration 0175). Only the
 * loss-reason gate is seeded, and only on Closed lost, so a fresh organization
 * ends up with exactly the rules 0175 backfills onto an upgraded one. Every
 * other gate stays off until somebody configures it: shipping an opinion about
 * what Proposal requires would impose on new tenants a policy that existing
 * tenants never agreed to.
 */
const DEFAULT_OPPORTUNITY_STATUSES = [
  ["qualification", "Qualification", 10, "upside", false, false, true, false],
  ["discovery", "Discovery", 25, "upside", false, false, false, false],
  ["proposal", "Proposal", 50, "most_likely", false, false, false, false],
  ["negotiation", "Negotiation", 75, "most_likely", false, false, false, false],
  ["closed_won", "Closed won", 100, "worst_case", true, true, false, false],
  ["closed_lost", "Closed lost", 0, "omitted", true, false, false, true],
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
    const [key, name, probability, category, closed, won, isDefault, requiresWinLossReason] =
      DEFAULT_OPPORTUNITY_STATUSES[sequence]!;
    await executor.execute(sql`
      insert into crm_opportunity_statuses
        (org_id, key, name, sequence, probability, default_forecast_category, is_closed, is_won, is_default,
         requires_win_loss_reason, created_by, updated_by)
      values (${orgId}, ${key}, ${name}, ${sequence}, ${probability}, ${category}, ${closed}, ${won}, ${isDefault},
              ${requiresWinLossReason}, ${actorId}, ${actorId})
      on conflict (org_id, key) do nothing`);
  }
}

/**
 * The typed outcome of a lifecycle transition. Callers must handle it — a
 * bare `await` discards the difference between "CRM is off" and "applied",
 * which is how order conversion silently skipped the customer role.
 */
export interface CrmStageTransition {
  /** The party holds an active customer role after this call. Core AR state:
   *  ensured whenever the target is customer, with the CRM feature on or off. */
  customerRoleActive: boolean;
  /** CRM lifecycle state is authoritative after this call: bookkeeping was
   *  written, or the stage had already converged. False only when the CRM
   *  feature is off (lifecycle frozen) — concurrent promotions stay
   *  idempotent instead of failing as "not applied". */
  lifecycleApplied: boolean;
  /** The lifecycle stage actually moved (implies lifecycleApplied). */
  transitioned: boolean;
}

async function ensureActiveCustomerRole(
  executor: SqlExecutor,
  input: { orgId: string; partyId: string; actorId: string },
): Promise<void> {
  await executor.execute(sql`
    insert into customer_roles (org_id, party_id, is_active, created_by, updated_by)
    values (${input.orgId}, ${input.partyId}, true, ${input.actorId}, ${input.actorId})
    on conflict (party_id) do update set is_active = true, updated_at = now(), updated_by = ${input.actorId}
    where customer_roles.org_id = ${input.orgId}`);
}

/**
 * Move an account forward one lifecycle transition and write immutable
 * evidence in the caller's transaction. Becoming a customer (role plus
 * profile) is core AR and happens with CRM on or off; only the CRM
 * lifecycle and stage bookkeeping is CRM-gated.
 */
export async function transitionCrmAccountStage(
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
): Promise<CrmStageTransition> {
  const idle: CrmStageTransition = { customerRoleActive: false, lifecycleApplied: false, transitioned: false };
  const crmOn = await crmFeatureEnabled(executor, input.orgId);
  const existing = (await executor.execute<{ id: string; lifecycle_stage: CrmLifecycleStage }>(sql`
    select id, lifecycle_stage from crm_account_profiles
     where org_id = ${input.orgId} and party_id = ${input.partyId} for update
  `));

  let profileId = existing.rows[0]?.id;
  const fromStage = existing.rows[0]?.lifecycle_stage;
  if (!profileId) {
    if (!crmOn) {
      // No profile without CRM — but a new customer still needs its AR role.
      if (input.toStage === "customer") {
        await ensureActiveCustomerRole(executor, input);
        return { ...idle, customerRoleActive: true };
      }
      return idle;
    }
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
    if (!shouldPromoteLifecycle(fromStage!, input.toStage)) {
      // No stage movement — but a customer call still converges the role
      // (rows created while CRM was off, or by AR writers, may lack one).
      if (input.toStage === "customer") {
        await ensureActiveCustomerRole(executor, input);
        return { ...idle, customerRoleActive: true, lifecycleApplied: crmOn };
      }
      return { ...idle, lifecycleApplied: crmOn };
    }
    if (!crmOn) {
      if (input.toStage === "customer") {
        await ensureActiveCustomerRole(executor, input);
        return { ...idle, customerRoleActive: true };
      }
      return idle;
    }
    const status = (await executor.execute<{ id: string }>(sql`
      select id from crm_account_statuses
       where org_id = ${input.orgId} and lifecycle_stage = ${input.toStage} and is_default and is_active
       order by sequence limit 1`));
    await executor.execute(sql`
      update crm_account_profiles set lifecycle_stage = ${input.toStage}, status_id = ${status.rows[0]?.id ?? null},
             qualified_at = case when ${input.toStage} = 'prospect' and qualified_at is null then now() else qualified_at end,
             converted_at = case when ${input.toStage} = 'customer' and converted_at is null then now() else converted_at end,
             updated_at = now(), updated_by = ${input.actorId}
       where id = ${profileId} and org_id = ${input.orgId}`);
  }

  if (input.toStage === "customer") {
    await ensureActiveCustomerRole(executor, input);
  }
  await executor.execute(sql`
    insert into crm_account_stage_events
      (org_id, account_profile_id, from_stage, to_stage, source_kind, source_id, reason, created_by, updated_by)
    values (${input.orgId}, ${profileId}, ${fromStage ?? null}, ${input.toStage}, ${input.sourceKind},
            ${input.sourceId ?? null}, ${input.reason ?? null}, ${input.actorId}, ${input.actorId})`);
  return {
    customerRoleActive: input.toStage === "customer",
    lifecycleApplied: true,
    transitioned: true,
  };
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
): Promise<CrmStageTransition> {
  return transitionCrmAccountStage(executor, input);
}

/** Route one account using the first matching active territory by priority. */
export async function routeCrmAccount(orgId: string, profileId: string, actorId: string): Promise<string | null> {
  if (!(await crmFeatureEnabled(db, orgId))) return null;
  return db.transaction(async (tx) => {
    const account = (await tx.execute<{
      id: string;
      lifecycle_stage: CrmLifecycleStage;
      lead_source_id: string | null;
      industry: string | null;
      annual_revenue: string | null;
      employee_count: number | null;
      owner_user_id: string | null;
      territory_id: string | null;
      country: string | null;
      region: string | null;
    }>(sql`
      select cp.id, cp.lifecycle_stage, cp.lead_source_id, cp.industry, cp.annual_revenue, cp.employee_count,
             cp.owner_user_id, cp.territory_id, a.country, a.region
        from crm_account_profiles cp
        left join lateral (
          select country, region from addresses
           where org_id = ${orgId} and party_id = cp.party_id
          order by is_default_billing desc, created_at limit 1
        ) a on true
       -- The address is read-only routing context on the nullable side of an
       -- outer join, which Postgres refuses to lock: lock the profile only.
       -- A concurrent address edit simply re-routes on the next run.
       where cp.id = ${profileId} and cp.org_id = ${orgId} for update of cp`));
    const row = account.rows[0];
    if (!row) return null;
    const territories = (await tx.execute<{
      id: string;
      rules: TerritoryRule[];
      match_mode: "all" | "any";
      default_owner_user_id: string | null;
    }>(sql`
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
       where id = ${profileId} and org_id = ${orgId}`);
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
    where number_sequences.org_id = ${orgId}
    returning prefix, next_number, padding
  `));
  const row = seq.rows[0]!;
  return `${row.prefix}${String(row.next_number).padStart(row.padding, "0")}`;
}
