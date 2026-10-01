import { requireSalesSchema } from "./sales-readiness.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { routeSalesAccount } from "./sales-routing.ts";
import { createHash, randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/iso-date.ts";
import { businessTodayInTx } from "../platform/business-date.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
} from "../organization/org-feature-lock.ts";
import { cmp, sum, normalizeMoney, fitsLedgerRange } from "../money/money.ts";
import {
  matchesTerritory,
  type TerritoryRule,
  type TerritorySubject,
} from "./crm-math.ts";
import {
  geographyMatches,
  hasGeographicCoverage,
  validateDrawnGeometry,
} from "./territory-geography.ts";
import type {
  SalesCommand,
  SalesRecord,
  SalesScope,
  TerritoryGeography,
} from "./sales-contracts.ts";

import { SalesError } from "./sales-error.ts";
export { SalesError } from "./sales-error.ts";
export function salesScopeWhere(scope: SalesScope, column: SQL): SQL {
  return scope.allowedSubsidiaryIds === null
    ? sql`true`
    : scope.allowedSubsidiaryIds.size === 0
      ? sql`false`
      : sql`${column} in (${sql.join(
          [...scope.allowedSubsidiaryIds].map((id) => sql`${id}`),
          sql`,`,
        )})`;
}
function assertScope(scope: SalesScope, subsidiaryId: string | null): void {
  if (
    scope.allowedSubsidiaryIds !== null &&
    (!subsidiaryId || !scope.allowedSubsidiaryIds.has(subsidiaryId))
  )
    throw new SalesError(
      "This legal entity is outside your permitted scope.",
      404,
      "not_found",
    );
}
async function audit(
  tx: SqlExecutor,
  scope: SalesScope,
  table: string,
  id: string,
  before: unknown,
  after: unknown,
  reason?: string,
) {
  await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values
    (${scope.orgId},${table},${id},${before ? "update" : "insert"},${JSON.stringify({ before, after, reason: reason || null })}::jsonb,${scope.actorId})`);
}
async function employee(
  tx: SqlExecutor,
  scope: SalesScope,
  id: string | null,
  subsidiaryId: string,
  date: string,
) {
  if (!id) return;
  const row = (
    await tx.execute<{
      subsidiary_id: string | null;
    }>(sql`select p.subsidiary_id from employee_roles e join parties p on p.id=e.party_id and p.org_id=e.org_id
    where e.org_id=${scope.orgId} and e.party_id=${id} and e.is_active and e.is_sales_rep and p.is_active
      and (e.sales_rep_since is null or e.sales_rep_since<=${date}::date) and (e.terminated_on is null or e.terminated_on>=${date}::date) for share of e,p`)
  ).rows[0];
  if (!row || row.subsidiary_id !== subsidiaryId)
    throw new SalesError(
      "Select an active sales employee in this legal entity. Manage eligibility in Sales → Representatives.",
    );
  assertScope(scope, row.subsidiary_id);
}
async function team(
  tx: SqlExecutor,
  scope: SalesScope,
  id: string | null,
  subsidiaryId: string,
) {
  if (!id) return;
  const row = (
    await tx.execute<{ subsidiary_id: string | null }>(
      sql`select subsidiary_id from crm_sales_teams where org_id=${scope.orgId} and id=${id} and is_active for share`,
    )
  ).rows[0];
  if (!row || row.subsidiary_id !== subsidiaryId)
    throw new SalesError("Select an active sales team in this legal entity.");
}
async function current(
  tx: SqlExecutor,
  scope: SalesScope,
  table: "crm_sales_teams" | "crm_sales_quotas" | "crm_sales_territories",
  id: string | undefined,
  expected: number | undefined,
): Promise<SalesRecord | null> {
  if (!id) return null;
  const row = (
    await tx.execute<SalesRecord>(
      sql`select * from ${sql.identifier(table)} where org_id=${scope.orgId} and id=${id} and ${salesScopeWhere(scope, sql`subsidiary_id`)} for update`,
    )
  ).rows[0];
  if (!row) throw new SalesError("Record not found.", 404, "not_found");
  if (expected !== row.revision)
    throw new SalesError(
      "This record changed. Reload it before saving your changes.",
      409,
      "revision_conflict",
    );
  return row;
}

type PreviewAccount = {
  id: string;
  party_id: string;
  name: string;
  territory_id: string | null;
  sales_rep_id: string | null;
  country: string | null;
  region: string | null;
  industry: string | null;
  lifecycle_stage: "lead" | "prospect" | "customer";
  lead_source_id: string | null;
  annual_revenue: string | null;
  employee_count: number | null;
  address_id: string | null;
  longitude: string | null;
  latitude: string | null;
  updated_at: string;
  address_updated_at: string | null;
  manual: boolean;
};
export type TerritoryPreview = {
  revision: string;
  matched: number;
  changed: number;
  conflicts: number;
  missingLocations: number;
  accounts: {
    id: string;
    partyId: string;
    name: string;
    addressId: string | null;
    addressRevision: string | null;
    currentTerritoryId: string | null;
    currentEmployeeId: string | null;
    status: "matched" | "change" | "conflict" | "missing_location" | "manual";
    longitude: string | null;
    latitude: string | null;
  }[];
};
export async function previewTerritory(
  tx: SqlExecutor,
  scope: SalesScope,
  input: Extract<SalesCommand, { action: "territory" }>,
): Promise<TerritoryPreview> {
  await requireSalesSchema(tx);
  assertScope(scope, input.subsidiaryId);
  const accounts = (
    await tx.execute<PreviewAccount>(sql`select cp.id,cp.party_id,p.display_name as name,cp.territory_id,c.sales_rep_id,cp.industry,cp.lifecycle_stage,cp.lead_source_id,cp.annual_revenue,cp.employee_count,cp.updated_at::text,
    a.id as address_id,a.country,a.region,a.longitude::text,a.latitude::text,a.updated_at::text as address_updated_at,
    coalesce((select source='manual' from crm_account_assignment_events e where e.org_id=cp.org_id and e.account_profile_id=cp.id order by e.created_at desc,e.id desc limit 1),false) as manual
    from crm_account_profiles cp join parties p on p.org_id=cp.org_id and p.id=cp.party_id left join customer_roles c on c.org_id=p.org_id and c.party_id=p.id
    left join lateral (select * from addresses where org_id=p.org_id and party_id=p.id order by is_default_billing desc,created_at,id limit 1) a on true
    where cp.org_id=${scope.orgId} and p.subsidiary_id=${input.subsidiaryId} order by cp.id`)
  ).rows;
  const others = (
    await tx.execute<{
      id: string;
      rules: TerritoryRule[];
      match_mode: "all" | "any";
      geography: TerritoryGeography;
      updated_at: string;
    }>(sql`select t.id,coalesce(v.definition->'rules',t.rules) as rules,coalesce(v.definition->>'match_mode',t.match_mode) as match_mode,coalesce(v.definition->'geography',t.geography) as geography,t.updated_at::text from crm_sales_territories t left join lateral(select definition from crm_sales_territory_versions v where v.org_id=t.org_id and v.territory_id=t.id and v.effective_from<=${input.effectiveFrom}::date order by effective_from desc,revision desc limit 1)v on true
    where t.org_id=${scope.orgId} and t.subsidiary_id=${input.subsidiaryId} and t.lifecycle<>'archived' and t.is_active and v.definition is not null and t.id<>${input.id ?? "00000000-0000-4000-8000-000000000000"} order by t.id`)
  ).rows;
  const rows: TerritoryPreview["accounts"] = [];
  let matched = 0,
    changed = 0,
    conflicts = 0,
    missingLocations = 0;
  for (const a of accounts) {
    const point =
      a.longitude !== null && a.latitude !== null
        ? ([Number(a.longitude), Number(a.latitude)] as [number, number])
        : null;
    const subject: TerritorySubject = {
      country: a.country,
      region: a.region,
      industry: a.industry,
      lifecycleStage: a.lifecycle_stage,
      leadSourceId: a.lead_source_id,
      annualRevenue: a.annual_revenue,
      employeeCount: a.employee_count,
    };
    const rulesMatch =
      input.rules.length === 0 ||
      matchesTerritory(subject, input.rules, input.matchMode);
    const geoMatch = geographyMatches(input.geography, point);
    let status: TerritoryPreview["accounts"][number]["status"] | null = null;
    if (rulesMatch && hasGeographicCoverage(input.geography) && !point) {
      missingLocations++;
      status = "missing_location";
    } else if (rulesMatch && geoMatch) {
      matched++;
      if (a.manual) {
        status = "manual";
      } else if (
        others.some(
          (t) =>
            (t.rules.length === 0 ||
              matchesTerritory(subject, t.rules, t.match_mode)) &&
            geographyMatches(t.geography, point),
        )
      ) {
        conflicts++;
        status = "conflict";
      } else if (
        a.territory_id !== input.id ||
        a.sales_rep_id !== input.defaultEmployeeId
      ) {
        changed++;
        status = "change";
      } else status = "matched";
    }
    if (status)
      rows.push({
        id: a.id,
        partyId: a.party_id,
        name: a.name,
        addressId: a.address_id,
        addressRevision: a.address_updated_at,
        currentTerritoryId: a.territory_id,
        currentEmployeeId: a.sales_rep_id,
        status,
        longitude: a.longitude,
        latitude: a.latitude,
      });
  }
  const {
    previewRevision: _previewRevision,
    expectedRevision: _expectedRevision,
    ...definition
  } = input;
  const revision = createHash("sha256")
    .update(JSON.stringify({ definition, accounts, others }))
    .digest("hex");
  return {
    revision,
    matched,
    changed,
    conflicts,
    missingLocations,
    accounts: rows,
  };
}

async function saveCommand(
  tx: SqlExecutor,
  scope: SalesScope,
  input: SalesCommand,
): Promise<SalesRecord | { id: string }> {
  await requireSalesSchema(tx);
  await acquireOrgFeatureGateLock(tx, scope.orgId);
  if (!(await lockAndCheckOrgFeature(tx, scope.orgId, "salesManagement")))
    throw new SalesError(
      "Sales management is disabled. Enable it in Company Settings → Features.",
      404,
      "feature_disabled",
    );
  if (
    !(await actorHasPermission(
      tx,
      scope.orgId,
      scope.actorId,
      "crm.setup.manage",
    ))
  )
    throw new SalesError(
      "Sales configuration requires the sales setup permission.",
      403,
    );
  const today = await businessTodayInTx(tx, scope.orgId);
  if (input.action === "representative") {
    const before = (
      await tx.execute<{
        party_id: string;
        is_sales_rep: boolean;
        updated_at: string;
        subsidiary_id: string | null;
      }>(sql`select e.*,e.updated_at::text as updated_at,p.subsidiary_id from employee_roles e join parties p on p.id=e.party_id and p.org_id=e.org_id
      where e.org_id=${scope.orgId} and e.party_id=${input.employeeId} and (not ${input.enabled} or (e.is_active and p.is_active)) and ${salesScopeWhere(scope, sql`p.subsidiary_id`)} for update of e`)
    ).rows[0];
    if (!before)
      throw new SalesError(
        "Select an existing active employee.",
        404,
        "not_found",
      );
    if (before.updated_at !== input.expectedRevision)
      throw new SalesError(
        "This employee changed. Reload before saving.",
        409,
        "revision_conflict",
      );
    if (!input.enabled) {
      const assigned = (
        await tx.execute(sql`select 1 where exists(select 1 from customer_roles where org_id=${scope.orgId} and sales_rep_id=${input.employeeId} and is_active)
        or exists(select 1 from crm_sales_team_members where org_id=${scope.orgId} and employee_id=${input.employeeId} and is_active)
        or exists(select 1 from crm_sales_territories where org_id=${scope.orgId} and (default_employee_id=${input.employeeId} or manager_employee_id=${input.employeeId}) and lifecycle<>'archived')
        or exists(select 1 from crm_sales_teams where org_id=${scope.orgId} and manager_employee_id=${input.employeeId} and is_active)
        or exists(select 1 from crm_sales_quotas where org_id=${scope.orgId} and employee_id=${input.employeeId} and lifecycle in ('draft','pending_approval','approved') and period_end>=${today}::date)
        or exists(select 1 from crm_opportunities o join crm_opportunity_statuses st on st.org_id=o.org_id and st.id=o.status_id where o.org_id=${scope.orgId} and o.sales_rep_id=${input.employeeId} and o.is_active and not st.is_closed)`)
      ).rows.length;
      if (assigned)
        throw new SalesError(
          "Reassign this employee’s customers, team memberships, territory responsibilities and open opportunities, and close or revise open quotas before removing sales eligibility.",
        );
    }
    const after = (
      await tx.execute<SalesRecord>(sql`update employee_roles set is_sales_rep=${input.enabled},sales_rep_since=${input.since}::date,updated_at=clock_timestamp(),updated_by=${scope.actorId}
      where org_id=${scope.orgId} and party_id=${input.employeeId} returning *,party_id as id`)
    ).rows[0];
    if (!after) throw new SalesError("Employee was not updated.", 409);
    await audit(tx, scope, "employee_roles", input.employeeId, before, after);
    return after;
  }
  if (input.action === "quota-transition") {
    const before = await current(
      tx,
      scope,
      "crm_sales_quotas",
      input.id,
      input.expectedRevision,
    );
    if (!before) throw new SalesError("Quota not found.", 404);
    const transitions: Record<string, string[]> = {
      draft: ["pending_approval"],
      pending_approval: ["draft", "approved"],
      approved: ["closed"],
    };
    if (!transitions[before.lifecycle ?? ""]?.includes(input.lifecycle))
      throw new SalesError("This quota cannot make that lifecycle transition.");
    if (!input.reason.trim())
      throw new SalesError("Enter a reason for this quota decision.");
    if (
      input.lifecycle === "closed" &&
      (
        await tx.execute(
          sql`select 1 from crm_sales_quotas where org_id=${scope.orgId} and parent_quota_id=${input.id} and lifecycle not in ('closed','superseded') limit 1`,
        )
      ).rows.length
    )
      throw new SalesError(
        "Close the representative allocations before closing their team quota.",
      );
    if (input.lifecycle === "approved") {
      if (
        !(await actorHasPermission(
          tx,
          scope.orgId,
          scope.actorId,
          "crm.forecasts.override",
        ))
      )
        throw new SalesError(
          "Quota approval requires the sales manager approval permission.",
          403,
        );
      if (before.created_by === scope.actorId)
        throw new SalesError(
          "A different authorized manager must approve this quota.",
          403,
          "segregation_of_duties",
        );
      const children = (
        await tx.execute<{ amount: string; lifecycle: string }>(
          sql`select amount::text,lifecycle from crm_sales_quotas where org_id=${scope.orgId} and parent_quota_id=${input.id} and lifecycle<>'superseded' for update`,
        )
      ).rows;
      if (
        children.length &&
        (children.some((c) => c.lifecycle !== "approved") ||
          cmp(sum(children.map((c) => c.amount)), before.amount!) !== 0)
      )
        throw new SalesError(
          "Approve the representative allocations and reconcile their total to the team target before approving the team quota.",
        );
      const overlaps = (
        await tx.execute(sql`select 1 from crm_sales_quotas where org_id=${scope.orgId} and id<>${input.id} and id<>${before.supersedes_id ?? "00000000-0000-4000-8000-000000000000"}
        and employee_id is not distinct from ${before.employee_id ?? null} and sales_team_id is not distinct from ${before.sales_team_id ?? null}
        and subsidiary_id is not distinct from ${before.subsidiary_id} and metric=${before.metric!} and currency=${before.currency!} and lifecycle='approved'
        and period_start<=${before.period_end!}::date and period_end>=${before.period_start!}::date`)
      ).rows.length;
      if (overlaps)
        throw new SalesError(
          "An approved quota already covers this target and period. Revise that quota instead of creating an overlapping target.",
        );
      if (before.supersedes_id) {
        const replacementBefore = (
          await tx.execute<SalesRecord>(
            sql`select * from crm_sales_quotas where org_id=${scope.orgId} and id=${before.supersedes_id} for update`,
          )
        ).rows[0];
        const replaced = (
          await tx.execute<SalesRecord>(sql`update crm_sales_quotas set lifecycle='superseded',revision=revision+1,updated_at=clock_timestamp(),updated_by=${scope.actorId}
          where org_id=${scope.orgId} and id=${before.supersedes_id} and lifecycle='approved' returning *`)
        ).rows[0];
        if (!replaced)
          throw new SalesError(
            "The quota being replaced is no longer approved. Reload the revision.",
            409,
          );
        await audit(
          tx,
          scope,
          "crm_sales_quotas",
          replaced.id,
          replacementBefore,
          replaced,
          input.reason,
        );
      }
    }
    const after = (
      await tx.execute<SalesRecord>(sql`update crm_sales_quotas set lifecycle=${input.lifecycle},reason=${input.lifecycle === "closed" ? sql`reason` : input.reason},approved_by=${input.lifecycle === "approved" ? scope.actorId : sql`approved_by`},approved_at=${input.lifecycle === "approved" ? sql`now()` : sql`approved_at`},revision=revision+1,updated_at=clock_timestamp(),updated_by=${scope.actorId}
      where org_id=${scope.orgId} and id=${input.id} returning *`)
    ).rows[0];
    if (!after) throw new SalesError("Quota transition was not applied.", 409);
    await audit(
      tx,
      scope,
      "crm_sales_quotas",
      input.id,
      before,
      after,
      input.reason,
    );
    return after;
  }
  assertScope(scope, input.subsidiaryId);
  if (
    !(
      await tx.execute(
        sql`select id from subsidiaries where org_id=${scope.orgId} and id=${input.subsidiaryId} and is_active for share`,
      )
    ).rows.length
  )
    throw new SalesError("Select a legal entity in this organization.");
  if (input.action === "team") {
    const before = await current(
      tx,
      scope,
      "crm_sales_teams",
      input.id,
      input.expectedRevision,
    );
    if (before && before.subsidiary_id !== input.subsidiaryId)
      throw new SalesError(
        "Create a separate team for the new legal entity; existing team history retains its original entity.",
      );
    if (
      before &&
      !input.isActive &&
      (
        await tx.execute(
          sql`select 1 where exists(select 1 from crm_sales_territories where org_id=${scope.orgId} and sales_team_id=${before.id} and lifecycle<>'archived') or exists(select 1 from crm_sales_quotas where org_id=${scope.orgId} and sales_team_id=${before.id} and lifecycle in ('draft','pending_approval','approved') and period_end>=${today}::date) or exists(select 1 from crm_opportunities o join crm_opportunity_statuses st on st.org_id=o.org_id and st.id=o.status_id where o.org_id=${scope.orgId} and o.sales_team_id=${before.id} and o.is_active and not st.is_closed)`,
        )
      ).rows.length
    )
      throw new SalesError(
        "Reassign active territories and open opportunities, and close or revise open team quotas before archiving this team.",
      );
    await employee(
      tx,
      scope,
      input.managerEmployeeId,
      input.subsidiaryId,
      today,
    );
    if (
      new Set(input.members.map((m) => m.employeeId)).size !==
      input.members.length
    )
      throw new SalesError("Include each employee once in a team.");
    for (const member of input.members)
      await employee(
        tx,
        scope,
        member.employeeId,
        input.subsidiaryId,
        member.validFrom,
      );
    if (
      input.managerEmployeeId &&
      !input.members.some(
        (m) => m.employeeId === input.managerEmployeeId && m.role === "manager",
      )
    )
      throw new SalesError("Include the team manager as a manager membership.");
    const after = (
      await tx.execute<SalesRecord>(
        input.id
          ? sql`update crm_sales_teams set name=${input.name},manager_employee_id=${input.managerEmployeeId},subsidiary_id=${input.subsidiaryId},is_active=${input.isActive},revision=revision+1,updated_at=clock_timestamp(),updated_by=${scope.actorId} where org_id=${scope.orgId} and id=${input.id} returning *`
          : sql`insert into crm_sales_teams(org_id,key,name,manager_employee_id,subsidiary_id,is_active,created_by,updated_by) values(${scope.orgId},${createHash(
              "sha256",
            )
              .update(input.name + randomUUID())
              .digest(
                "hex",
              )},${input.name},${input.managerEmployeeId},${input.subsidiaryId},${input.isActive},${scope.actorId},${scope.actorId}) returning *`,
      )
    ).rows[0];
    if (!after) throw new SalesError("Team was not saved.", 409);
    const previous = (
      await tx.execute<{
        id: string;
        employee_id: string;
        role: string;
        valid_from: string;
      }>(
        sql`select id,employee_id,role,valid_from::text from crm_sales_team_members where org_id=${scope.orgId} and team_id=${after.id} and is_active for update`,
      )
    ).rows;
    for (const existing of previous) {
      const retained = input.members.find(
        (m) =>
          m.employeeId === existing.employee_id &&
          m.role === existing.role &&
          m.validFrom === existing.valid_from,
      );
      if (!retained)
        await tx.execute(
          sql`update crm_sales_team_members set is_active=false,valid_to=greatest(valid_from,${today}::date),updated_at=clock_timestamp(),updated_by=${scope.actorId} where org_id=${scope.orgId} and id=${existing.id}`,
        );
    }
    for (const m of input.members) {
      if (
        previous.some(
          (p) =>
            p.employee_id === m.employeeId &&
            p.role === m.role &&
            p.valid_from === m.validFrom,
        )
      )
        continue;
      await tx.execute(
        sql`insert into crm_sales_team_members(org_id,team_id,employee_id,role,valid_from,created_by,updated_by) values(${scope.orgId},${after.id},${m.employeeId},${m.role},${m.validFrom},${scope.actorId},${scope.actorId})`,
      );
    }
    await audit(
      tx,
      scope,
      "crm_sales_teams",
      after.id,
      before ? { ...before, members: previous } : null,
      { ...after, members: input.members },
    );
    return after;
  }
  if (input.action === "quota") {
    if (
      !isIsoCalendarDate(input.periodStart) ||
      !isIsoCalendarDate(input.periodEnd) ||
      input.periodEnd < input.periodStart
    )
      throw new SalesError(
        "Enter a valid quota period whose end does not precede its start.",
      );
    if ((input.employeeId ? 1 : 0) + (input.salesTeamId ? 1 : 0) !== 1)
      throw new SalesError(
        "Choose one native employee or sales team for this quota.",
      );
    let amount: string;
    try {
      amount = normalizeMoney(input.amount);
    } catch {
      throw new SalesError(
        "Enter an exact quota amount with at most four decimal places.",
      );
    }
    if (!fitsLedgerRange(amount) || cmp(amount, "0") < 0)
      throw new SalesError(
        "Enter a non-negative quota amount with at most 15 whole digits.",
      );
    const before = await current(
      tx,
      scope,
      "crm_sales_quotas",
      input.id,
      input.expectedRevision,
    );
    if (before && before.lifecycle !== "draft")
      throw new SalesError(
        "Only draft quotas can be edited. Create a revision of an approved quota.",
      );
    await employee(
      tx,
      scope,
      input.employeeId,
      input.subsidiaryId,
      input.periodStart,
    );
    await employee(
      tx,
      scope,
      input.employeeId,
      input.subsidiaryId,
      input.periodEnd,
    );
    await team(tx, scope, input.salesTeamId, input.subsidiaryId);
    if (input.parentQuotaId) {
      const parent = (
        await tx.execute<SalesRecord>(
          sql`select * from crm_sales_quotas where org_id=${scope.orgId} and id=${input.parentQuotaId} for update`,
        )
      ).rows[0];
      if (
        !parent ||
        !parent.sales_team_id ||
        parent.subsidiary_id !== input.subsidiaryId ||
        parent.currency !== input.currency ||
        parent.metric !== input.metric ||
        parent.period_start !== input.periodStart ||
        parent.period_end !== input.periodEnd ||
        !input.employeeId ||
        parent.lifecycle !== "draft"
      )
        throw new SalesError(
          "Representative allocations require a draft team quota with the same entity, metric, currency, and period.",
        );
      if (
        !(
          await tx.execute(
            sql`select 1 from crm_sales_team_members where org_id=${scope.orgId} and team_id=${parent.sales_team_id} and employee_id=${input.employeeId} and is_active and valid_from<=${input.periodStart}::date and (valid_to is null or valid_to>=${input.periodEnd}::date)`,
          )
        ).rows.length
      )
        throw new SalesError(
          "This employee must belong to the target team throughout the quota period.",
        );
    }
    if (input.supersedesId) {
      const prior = (
        await tx.execute<SalesRecord>(
          sql`select * from crm_sales_quotas where org_id=${scope.orgId} and id=${input.supersedesId} for share`,
        )
      ).rows[0];
      if (
        !prior ||
        prior.lifecycle !== "approved" ||
        prior.employee_id !== input.employeeId ||
        prior.sales_team_id !== input.salesTeamId ||
        prior.subsidiary_id !== input.subsidiaryId ||
        prior.metric !== input.metric ||
        prior.currency !== input.currency ||
        prior.period_start !== input.periodStart ||
        prior.period_end !== input.periodEnd
      )
        throw new SalesError(
          "A revision must retain the approved quota’s target, entity, metric, currency, and period.",
        );
      if (!input.reason.trim())
        throw new SalesError("Enter a reason for revising the approved quota.");
    }
    if (
      !(
        await tx.execute(
          sql`select code from currencies where code=${input.currency}`,
        )
      ).rows.length
    )
      throw new SalesError("Select a configured currency.");
    const org = (
      await tx.execute<{ base_currency: string }>(
        sql`select base_currency from orgs where id=${scope.orgId}`,
      )
    ).rows[0]!;
    if (
      input.currency !== org.base_currency &&
      !(await lockAndCheckOrgFeature(tx, scope.orgId, "multiCurrency"))
    )
      throw new SalesError(
        "Enable Multi-currency in Company Settings → Features before using this currency.",
      );
    const after = (
      await tx.execute<SalesRecord>(
        input.id
          ? sql`update crm_sales_quotas set name=${input.name},employee_id=${input.employeeId},sales_team_id=${input.salesTeamId},subsidiary_id=${input.subsidiaryId},parent_quota_id=${input.parentQuotaId},supersedes_id=${input.supersedesId},reason=${input.reason},period_start=${input.periodStart},period_end=${input.periodEnd},currency=${input.currency},amount=${input.amount},metric=${input.metric},revision=revision+1,updated_at=clock_timestamp(),updated_by=${scope.actorId} where org_id=${scope.orgId} and id=${input.id} returning *`
          : sql`insert into crm_sales_quotas(org_id,name,employee_id,sales_team_id,subsidiary_id,parent_quota_id,supersedes_id,reason,period_start,period_end,currency,amount,metric,lifecycle,created_by,updated_by) values(${scope.orgId},${input.name},${input.employeeId},${input.salesTeamId},${input.subsidiaryId},${input.parentQuotaId},${input.supersedesId},${input.reason},${input.periodStart},${input.periodEnd},${input.currency},${input.amount},${input.metric},'draft',${scope.actorId},${scope.actorId}) returning *`,
      )
    ).rows[0];
    if (!after) throw new SalesError("Quota was not saved.", 409);
    await audit(
      tx,
      scope,
      "crm_sales_quotas",
      after.id,
      before,
      after,
      input.reason,
    );
    return after;
  }
  const before = await current(
    tx,
    scope,
    "crm_sales_territories",
    input.id,
    input.expectedRevision,
  );
  await employee(
    tx,
    scope,
    input.managerEmployeeId,
    input.subsidiaryId,
    input.effectiveFrom,
  );
  await employee(
    tx,
    scope,
    input.defaultEmployeeId,
    input.subsidiaryId,
    input.effectiveFrom,
  );
  await team(tx, scope, input.salesTeamId, input.subsidiaryId);
  if (
    hasGeographicCoverage(input.geography) ||
    input.geography.excludes.length
  ) {
    if (
      !(await lockAndCheckOrgFeature(tx, scope.orgId, "geographicTerritories"))
    )
      throw new SalesError(
        "Enable Geographic territories in Company Settings → Features to save geographic coverage.",
      );
    for (const area of input.geography.polygons) {
      const refusal = validateDrawnGeometry(area.geometry);
      if (refusal) throw new SalesError(refusal);
    }
  }
  if (!hasGeographicCoverage(input.geography) && input.rules.length === 0)
    throw new SalesError(
      "Select geographic coverage or add a business rule before saving a territory.",
    );
  if (input.lifecycle === "active") {
    await tx.execute(
      sql`select cp.id from crm_account_profiles cp join parties p on p.org_id=cp.org_id and p.id=cp.party_id where cp.org_id=${scope.orgId} and p.subsidiary_id=${input.subsidiaryId} order by cp.id for update of cp,p`,
    );
    await tx.execute(
      sql`select a.id from addresses a join parties p on p.org_id=a.org_id and p.id=a.party_id where a.org_id=${scope.orgId} and p.subsidiary_id=${input.subsidiaryId} order by a.id for share of a`,
    );
    const preview = await previewTerritory(tx, scope, input);
    if (input.previewRevision !== preview.revision)
      throw new SalesError(
        "Preview this territory’s assignments again before activating it.",
        409,
        "preview_changed",
      );
    if (preview.conflicts)
      throw new SalesError(
        "Resolve overlapping territory matches before activation. Adjust coverage or exclusions in the territory drawer.",
      );
  }
  const after = (
    await tx.execute<SalesRecord>(
      input.id
        ? sql`update crm_sales_territories set name=${input.name},description=${input.description},manager_employee_id=${input.managerEmployeeId},default_employee_id=${input.defaultEmployeeId},sales_team_id=${input.salesTeamId},subsidiary_id=${input.subsidiaryId},priority=${input.priority},rules=${JSON.stringify(input.rules)}::jsonb,match_mode=${input.matchMode},geography=${JSON.stringify(input.geography)}::jsonb,effective_from=${input.effectiveFrom},lifecycle=${input.lifecycle},is_active=${input.lifecycle !== "archived"},revision=revision+1,updated_at=clock_timestamp(),updated_by=${scope.actorId} where org_id=${scope.orgId} and id=${input.id} returning *`
        : sql`insert into crm_sales_territories(org_id,key,name,description,manager_employee_id,default_employee_id,sales_team_id,subsidiary_id,priority,rules,match_mode,geography,effective_from,lifecycle,is_active,created_by,updated_by) values(${scope.orgId},${randomUUID()},${input.name},${input.description},${input.managerEmployeeId},${input.defaultEmployeeId},${input.salesTeamId},${input.subsidiaryId},${input.priority},${JSON.stringify(input.rules)}::jsonb,${input.matchMode},${JSON.stringify(input.geography)}::jsonb,${input.effectiveFrom},${input.lifecycle},${input.lifecycle !== "archived"},${scope.actorId},${scope.actorId}) returning *`,
    )
  ).rows[0];
  if (!after) throw new SalesError("Territory was not saved.", 409);
  if (input.lifecycle === "active")
    await tx.execute(
      sql`insert into crm_sales_territory_versions(org_id,territory_id,revision,effective_from,definition,created_by) values(${scope.orgId},${after.id},${after.revision},${input.effectiveFrom},${JSON.stringify(after)}::jsonb,${scope.actorId})`,
    );
  if (input.lifecycle === "active" && input.effectiveFrom <= today) {
    const accounts = (
      await tx.execute<{ id: string }>(
        sql`select cp.id from crm_account_profiles cp join parties p on p.org_id=cp.org_id and p.id=cp.party_id where cp.org_id=${scope.orgId} and p.subsidiary_id=${input.subsidiaryId} order by cp.id`,
      )
    ).rows;
    for (const account of accounts)
      await routeSalesAccount(tx, scope.orgId, account.id, scope.actorId);
  }
  await audit(tx, scope, "crm_sales_territories", after.id, before, after);
  return after;
}
export async function writeSalesCommand(
  scope: SalesScope,
  input: SalesCommand,
): Promise<SalesRecord | { id: string }> {
  try {
    return await db.transaction((tx) => saveCommand(tx, scope, input));
  } catch (error) {
    if (error instanceof SalesError) throw error;
    const cause =
      error instanceof Error && error.cause && typeof error.cause === "object"
        ? error.cause
        : error;
    if (
      cause &&
      typeof cause === "object" &&
      "code" in cause &&
      cause.code === "23514" &&
      "message" in cause
    )
      throw new SalesError(String(cause.message));
    if (
      cause &&
      typeof cause === "object" &&
      "code" in cause &&
      cause.code === "23505"
    )
      throw new SalesError(
        "This sales record already exists. Reload the list before retrying.",
        409,
        "duplicate_record",
      );
    throw error;
  }
}
