import { sql } from "drizzle-orm";
import { setupReadSource } from "./read-shape";
import { db } from "@openbooks/engine/platform/db";
import {
  canonicalPeriodLabelSql,
  periodDisplayLabelSql,
} from "@openbooks/engine/periods/period-policy";
import {
  loadSubsidiaryContext,
  recordOwnerSubsidiary,
  restrictionAdmits,
} from "@openbooks/engine/organization/subsidiaries";
import { featureEnabled, resolvedFeatureState } from "../features";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import {
  SETUP_ENTITY_BY_KEY,
  refTargetPicker,
  toSnake,
  type SetupEntity,
  type SetupRefSource,
} from "./registry";
import { loadNumberSequenceKindOptions } from "./number-sequence-kinds";
import { setupEntitySubsidiaryFilter } from "./subsidiary-scope";
import { setupReferenceSources } from "./types";

export type RefOption = {
  value: string;
  label: string;
  scopeValue?: string | null;
  accountType?: string;
  minorUnits?: number;
  subsidiaryIds?: string[];
};

/** Distinct ref sources declared anywhere in this entity's columns or fields. */
export function refSources(entity: SetupEntity): SetupRefSource[] {
  return setupReferenceSources(entity);
}

/** Postable accounts for the org, matching the company-settings pickers. */
export async function loadAccounts(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null = null,
): Promise<RefOption[]> {
  const r = await db.execute(
    sql`
    select id, number, name, type, subsidiary_id as "subsidiaryId",
      subsidiary_include_children as "includeChildren" from accounts
     where org_id = ${orgId} and not is_summary and is_active
     order by number nulls last, name`,
    "objects",
  );
  const ctx = await loadSubsidiaryContext(db, orgId);
  const targets = [...ctx.byId.values()].filter(
    (subsidiary) =>
      subsidiary.isActive &&
      !subsidiary.isElimination &&
      (allowedSubsidiaryIds === null || allowedSubsidiaryIds.has(subsidiary.id)),
  );
  return r
    .map((account) => ({
      value: account.id as string,
      label: `${account.number ? `${account.number} · ` : ""}${account.name}`,
      accountType: account.type as string,
      subsidiaryIds: targets
        .filter((target) =>
          restrictionAdmits(
            ctx,
            account.subsidiaryId as string | null,
            account.includeChildren as boolean,
            target.id,
          ),
        )
        .map((target) => target.id),
    }))
    .filter((account) => account.subsidiaryIds!.length > 0);
}

/**
 * Active vendors for a remittance-party picker: active parties holding an
 * active vendor role. A NULL subsidiary is org-wide (visible to every scoped
 * caller), matching the payroll settings picker and the accounts-tab vendor
 * query — a subsidiary-scoped operator must still see the org-wide
 * statutory remittance vendors.
 */
export async function loadVendors(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null = null,
): Promise<RefOption[]> {
  const vendors = await db.execute(
    sql`
    select p.id as value, p.display_name as label from parties p
     join vendor_roles v on v.party_id = p.id and v.org_id = p.org_id and v.is_active
     where p.org_id = ${orgId} and p.is_active
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
     order by p.display_name`,
    "objects",
  );
  return vendors as RefOption[];
}

/** Options for a setup-entity ref source (id + code/name label). */
export async function loadEntityOptions(
  source: string,
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null = null,
  locale?: string,
): Promise<RefOption[]> {
  if (source === "payroll-lineage-employers") {
    return await db.execute<RefOption>(
      sql`select id::text as value,name as label from subsidiaries
      where org_id=${orgId} and country='US' and not is_elimination
        ${subsidiaryVisibleFilter(sql`id`, allowedSubsidiaryIds)} order by name,id`,
      "objects",
    );
  }
  if (source === "us-federal-filing-accounts") {
    // Retired registrations remain available for original-source qualification.
    return await db.execute<RefOption>(
      sql`select id::text as value, account_number || ' · ' || name as label,
      subsidiary_id::text as "scopeValue" from payroll_filing_accounts
      where org_id=${orgId} and country='US' and program_type='us_ein'
        ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
      order by name,id`,
      "objects",
    );
  }
  if (source === "renewable-subscriptions")
    return await db.execute<RefOption>(
      sql`
    select s.id::text as value,p.display_name || ' · ' || plan.name as label from subscriptions s
    join parties p on p.org_id=s.org_id and p.id=s.customer_id join subscription_plans plan on plan.org_id=s.org_id and plan.id=s.plan_id
    join subscription_lifecycles l on l.org_id=s.org_id and l.subscription_id=s.id
    where s.org_id=${orgId} and s.status='active' and l.term_ends_on is not null
      ${subsidiaryVisibleFilter(sql`coalesce(p.subsidiary_id,(select id from subsidiaries where org_id=${orgId} and parent_id is null))`, allowedSubsidiaryIds)}
    order by label,s.id`,
      "objects",
    );
  if (source === "operating-profiles") {
    return await db.execute<RefOption>(
      sql`select id::text as value,name as label,family as "scopeValue" from operating_profiles where org_id=${orgId} and is_active and current_version_id is not null order by name,id`,
      "objects",
    );
  }
  if (source === "project-types") {
    return await db.execute<RefOption>(
      sql`select id::text as value,name as label from project_types where org_id=${orgId} order by name,id`,
      "objects",
    );
  }
  if (source === "subsidiaries") {
    const employers = await db.execute<RefOption>(
      sql`select id::text as value,name as label from subsidiaries
      where org_id=${orgId} and is_active and not is_elimination
      ${subsidiaryVisibleFilter(sql`id`, allowedSubsidiaryIds)} order by name,id`,
      "objects",
    );
    return employers;
  }
  if (source === "compensation-currencies") {
    const { organizationCurrencyOptions } =
      await import("@openbooks/engine/organization/currencies");
    return organizationCurrencyOptions(db, orgId, allowedSubsidiaryIds);
  }
  if (source === "benefit-currencies") {
    const { getAuthz } = await import("../authz");
    const { benefitCurrencyOptions } = await import("@openbooks/engine/hrm/benefits");
    const authz = await getAuthz();
    if (!authz || authz.user.orgId !== orgId)
      throw new Error("Benefit currency organization does not match the current session");
    return benefitCurrencyOptions(db, orgId, authz.user.id);
  }
  if (source === "worker-employments") {
    const rows = await db.execute<RefOption>(
      sql`select e.id::text as value,
      p.display_name || ' · ' || s.name as label,e.employer_subsidiary_id::text as "scopeValue" from worker_employments e
      join parties p on p.org_id=e.org_id and p.id=e.worker_party_id
      join subsidiaries s on s.org_id=e.org_id and s.id=e.employer_subsidiary_id
      where e.org_id=${orgId} ${subsidiaryVisibleFilter(sql`e.employer_subsidiary_id`, allowedSubsidiaryIds)}
      order by p.display_name,e.id`,
      "objects",
    );
    return rows;
  }
  if (source === "approved-compensation-package-versions") {
    const rows = await db.execute<RefOption>(
      sql`select v.id::text as value,p.code || ' · ' || v.version::text || ' · ' || v.effective_from::text as label,
      p.id::text as "scopeValue" from payroll_compensation_versions v join payroll_compensation_packages p on p.org_id=v.org_id and p.id=v.package_id
      where v.org_id=${orgId} and v.status='approved' and p.status='active'
      ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)} order by p.code,v.version desc,v.id`,
      "objects",
    );
    return rows;
  }
  if (source === "payroll-compensation-packages") {
    const rows = await db.execute<RefOption>(
      sql`select id::text as value,code || ' · ' || name as label from payroll_compensation_packages
      where org_id=${orgId} ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds)} order by code,id`,
      "objects",
    );
    return rows;
  }
  if (source === "compensation-package-components") {
    const rows = await db.execute<RefOption>(
      sql`select id::text as value,code || ' · ' || name as label from pay_components
      where org_id=${orgId} and is_active and system_key is null and kind in ('earning','deduction','contribution') order by code,id`,
      "objects",
    );
    return rows;
  }
  if (
    source === "benefit-contribution-rules" ||
    source === "benefit-contribution-classes" ||
    source === "benefit-enrollment-rules" ||
    source === "benefit-recovery-deduction-rules" ||
    source === "benefit-recovery-premium-rules"
  ) {
    const classes = source === "benefit-contribution-classes";
    const enrollmentScoped = source === "benefit-enrollment-rules";
    const recoveryFilter =
      source === "benefit-recovery-deduction-rules"
        ? sql`and c.kind='employee_deduction' and c.arrears_plan_id is not null`
        : source === "benefit-recovery-premium-rules"
          ? sql`and c.kind in ('employer_contribution','taxable_non_cash') and c.basis in ('per_period','per_month','per_year') and c.rate_formula='elected_rate'`
          : sql``;
    const rows = await db.execute<RefOption>(
      sql`select
      ${classes ? sql`c.class_key` : sql`c.id::text`} as value, c.name as label,
      ${enrollmentScoped ? sql`e.id::text` : sql`c.plan_id::text`} as "scopeValue"
      from ${sql.raw(classes ? "hrm_benefit_contribution_classes" : "hrm_benefit_contribution_rules")} c
      join hrm_benefit_plans p on p.org_id=c.org_id and p.id=c.plan_id
      ${enrollmentScoped ? sql`join hrm_benefit_enrollments e on e.org_id=c.org_id and e.plan_id=c.plan_id` : sql``}
      where c.org_id=${orgId} ${recoveryFilter} ${subsidiaryVisibleFilter(sql`p.employer_subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
      order by c.name,c.id`,
      "objects",
    );
    return rows;
  }
  if (source === "number-sequence-kinds") return loadNumberSequenceKindOptions(orgId);
  if (source === "sales-channels") {
    // Storefront connections are module records, not setup entities — a bare
    // reference list like `trades`: the channel picker in map/location forms.
    const channels = await db.execute(
      sql`
      select id as value, name as label from sales_channels
       where org_id = ${orgId} ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds)} order by name`,
      "objects",
    );
    return channels as RefOption[];
  }
  // `vendors` names the parties+vendor_roles picker, not a registry entity:
  // without this branch the generic lookup below finds no entry and every
  // remittance-vendor listbox renders only None.
  if (source === "vendors") return loadVendors(orgId, allowedSubsidiaryIds);
  if (source === "currencies") {
    // Currency options carry their minor-unit precision so money fields can
    // convert between operator majors and storage minors exactly, from the
    // authoritative table rather than a client guess.
    const options = await db.execute(
      sql`
      select code as value, name as label, minor_units as "minorUnits" from currencies order by code`,
      "objects",
    );
    return options as RefOption[];
  }
  if (source === "accounting-periods") {
    // Periods read as every period list labels them, from the fiscal position
    // and dates (`P07 FY2026 · Jul 2026` in the viewer's locale), so every
    // fiscal year reads alike; without a viewer locale the label is the
    // locale-free canonical form. The value stays the period id.
    const label = locale ? periodDisplayLabelSql(locale, "p") : canonicalPeriodLabelSql("p");
    const periods = await db.execute(
      sql`
      select p.id as value, ${label} as label from accounting_periods p
       where p.org_id = ${orgId} order by p.starts_on desc, p.period_number desc`,
      "objects",
    );
    return periods as RefOption[];
  }
  if (source === "items") {
    const items = await db.execute(
      sql`
      select id as value,
             case when coalesce(code, '') <> '' then code || ' · ' || name else name end as label
        from items where org_id = ${orgId} and is_active order by code nulls last, name`,
      "objects",
    );
    return items as RefOption[];
  }
  if (source === "customers") {
    const customers = await db.execute(
      sql`
      select p.id as value, p.display_name as label from parties p
       join customer_roles c on c.party_id = p.id and c.org_id = p.org_id and c.is_active
       where p.org_id = ${orgId} and p.is_active
         ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
       order by p.display_name`,
      "objects",
    );
    return customers as RefOption[];
  }
  if (source === "einvoice-customers") {
    return await db.execute<RefOption>(
      sql`
      select p.id::text as value, p.display_name as label from parties p
      join customer_roles c on c.org_id=p.org_id and c.party_id=p.id
      where p.org_id=${orgId} ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
      order by p.display_name,p.id`,
      "objects",
    );
  }
  if (source === "schedule-delivery-roles")
    return await db.execute<RefOption>(
      sql`select key as value,name as label from app_roles where org_id=${orgId} order by name,key`,
      "objects",
    );
  if (source === "schedule-operators")
    return await db.execute<RefOption>(
      sql`select id as value,name as label from users where org_id=${orgId} and is_active order by name,id`,
      "objects",
    );
  if (source === "schedule-subjects") {
    return await db.execute<RefOption>(
      sql`
      select id::text as value,display_name as label,'people' as "scopeValue" from parties
       where org_id=${orgId} and kind='person' and is_active ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds)}
      union all select id::text,unit_number || ' · ' || name,'resources' from equipment_units
       where org_id=${orgId} and status='active' ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds)}
      union all select id::text,name,'resources' from locations
       where org_id=${orgId} and is_active ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds)}
      order by label,value`,
      "objects",
    );
  }
  if (source === "schedule-contacts") {
    return (await db.execute(
      sql`select id as value,display_name as label from parties where org_id=${orgId} and kind='person' and is_active ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds)} order by display_name,id`,
      "objects",
    )) as RefOption[];
  }
  if (source === "employees") {
    // Role-scoped view of the native parties model — never a parallel roster.
    const employees = await db.execute(
      sql`
      select p.id as value, p.display_name as label from parties p
       join employee_roles e on e.party_id = p.id and e.org_id = p.org_id and e.is_active
       where p.org_id = ${orgId} and p.is_active order by p.display_name`,
      "objects",
    );
    return employees as RefOption[];
  }
  if (source === "pdf-templates") {
    // Active quote templates for the order-form picker. The PDF template
    // designer owns these rows; Setup only references them.
    const templates = await db.execute(
      sql`
      select id as value, name as label from pdf_templates
       where org_id = ${orgId} and is_active and record_type = 'quote'
       order by is_default desc, name`,
      "objects",
    );
    return templates as RefOption[];
  }
  if (source === "equipment-units") {
    // The chargeable unit register. Like `trades`, a legitimate scope key with
    // no setup-registry entry of its own — equipment is managed under Assets.
    const units = await db.execute(
      sql`
      select id as value, unit_number || ' · ' || name as label from equipment_units
       where org_id = ${orgId} and status = 'active'
         ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds)}
       order by unit_number`,
      "objects",
    );
    return units as RefOption[];
  }
  if (source === "job-titles") {
    // Distinct free-text job titles from the active employee roster — the
    // type-ahead corpus for `stringArray` title filters. Rule matching is
    // case- and whitespace-insensitive, so offer ONE representative per
    // normalized title (first by dictionary order) instead of every spelling.
    const titles = await db.execute(
      sql`
      select distinct on (lower(regexp_replace(trim(job_title), '\\s+', ' ', 'g')))
             trim(job_title) as value, trim(job_title) as label
        from employee_roles
       where org_id = ${orgId} and is_active and coalesce(trim(job_title), '') <> ''
       order by lower(regexp_replace(trim(job_title), '\\s+', ' ', 'g')), trim(job_title)`,
      "objects",
    );
    return titles as RefOption[];
  }
  if (source === "trades") {
    // `trades` is a bare reference list with no setup-registry entry of its
    // own, but it is a legitimate scope key (labor_cost_rates uses it too).
    const trades = await db.execute(
      sql`
      select id as value, name as label from trades
       where org_id = ${orgId} and is_active order by name`,
      "objects",
    );
    return trades as RefOption[];
  }
  if (source === "projects") {
    const projects = await db.execute(
      sql`
      select project.id as value, case when coalesce(project.code,'') <> '' then project.code || ' · ' || project.name else project.name end as label
        from (select id,code,name,is_active,${recordOwnerSubsidiary(orgId, sql`subsidiary_id`)} as owner_subsidiary_id
                from projects where org_id = ${orgId}) project
       where project.is_active ${subsidiaryVisibleFilter(sql`project.owner_subsidiary_id`, allowedSubsidiaryIds)}
       order by project.code nulls last, project.name`,
      "objects",
    );
    return projects as RefOption[];
  }
  if (source === "funds") {
    // The org's fund segment values — never the generic setup tables, which
    // cannot carry a fund classification. While Fund Accounting is off the
    // picker offers nothing: the owning setup pages 404 behind the same
    // switch, so an option here could never be saved anywhere honest.
    if (!featureEnabled(await resolvedFeatureState(orgId), "fundAccounting")) return [];
    const funds = await db.execute(
      sql`
      select sv.id as value,
             case when coalesce(sv.code, '') <> '' then sv.code || ' · ' || sv.name else sv.name end as label
        from segment_values sv
        join segment_definitions sd on sd.org_id = sv.org_id and sd.id = sv.segment_id
       where sv.org_id = ${orgId} and sd.key = 'fund' and sd.source_kind = 'custom'
         and sv.is_active
       order by sv.code nulls last, sv.name`,
      "objects",
    );
    return funds as RefOption[];
  }
  if (source === "chart-accounts") {
    // Every account of the chart — summary and inactive accounts included —
    // because presentation (localized labels) covers the whole chart.
    const accounts = await db.execute<RefOption>(
      sql`
      select id::text as value, concat_ws(' · ', number, name) as label, type as "accountType"
        from accounts where org_id = ${orgId}
       order by number nulls last, name, id`,
      "objects",
    );
    return accounts;
  }
  if (source === "all-segment-definitions") {
    return await db.execute<RefOption>(
      sql`
      select id::text as value, name as label from segment_definitions
       where org_id = ${orgId} and is_active order by sort_order, name, id`,
      "objects",
    );
  }
  if (source === "segment-dimension-values") {
    // Values of every active segment, built-in and custom alike, scoped to
    // their segment definition so a picker offers only that segment's values.
    return await db.execute<RefOption>(
      sql`
      select v.id::text as value, concat_ws(' · ', v.code, v.name) as label, sd.id::text as "scopeValue"
        from segment_definitions sd
        join lateral (
          select sv.id, sv.code, sv.name from segment_values sv
           where sd.source_kind = 'custom' and sv.org_id = sd.org_id and sv.segment_id = sd.id
          union all select d.id, d.code, d.name from departments d
           where sd.storage_column = 'department_id' and d.org_id = sd.org_id
          union all select c.id, c.code, c.name from classes c
           where sd.storage_column = 'class_id' and c.org_id = sd.org_id
          union all select l.id, l.code, l.name from locations l
           where sd.storage_column = 'location_id' and l.org_id = sd.org_id
          union all select p.id, p.code, p.name from projects p
           where sd.storage_column = 'project_id' and p.org_id = sd.org_id
          union all select s.id, null::text, s.name from subsidiaries s
           where sd.storage_column = 'subsidiary_id' and s.org_id = sd.org_id
        ) v on true
       where sd.org_id = ${orgId} and sd.is_active
       order by sd.sort_order, v.code nulls last, v.name, v.id`,
      "objects",
    );
  }
  const target = SETUP_ENTITY_BY_KEY.get(source);
  if (!target) return [];
  const orgFilter = target.orgScoped ? sql` where org_id = ${orgId}` : sql``;
  const customSegmentFilter =
    source === "segment-definitions"
      ? target.orgScoped
        ? sql` and source_kind = 'custom'`
        : sql` where source_kind = 'custom'`
      : sql``;
  // Label and order columns from the target's own declaration
  // (refTargetPicker in ./registry.ts) — never hardcoded code/name the
  // target may not carry. The option value is the refValue column (the
  // natural key) when referencing rows store it instead of the row id.
  const { valueCol, labelCols, orderCol } = refTargetPicker(target);
  const subsidiaryFilter = setupEntitySubsidiaryFilter(target, allowedSubsidiaryIds);
  const labelExpr =
    labelCols.length === 2
      ? sql.raw(
          `case when coalesce(${labelCols[0]}, '') <> '' then ${labelCols[0]} || ' · ' || ${labelCols[1]} else ${labelCols[1]} end`,
        )
      : sql.raw(labelCols[0]!);
  const r = await db.execute(
    sql`
    select ${sql.raw(valueCol)} as value, ${labelExpr} as label
      from ${setupReadSource(target)}${orgFilter}${customSegmentFilter}${subsidiaryFilter}
     order by ${sql.raw(orderCol)}`,
    "objects",
  );
  return r as RefOption[];
}

/** All ref-source option lists an entity's fields/columns need, keyed by source. */
export async function loadRefOptions(
  entity: SetupEntity,
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null = null,
  /** Viewer locale for option labels that render dates (accounting periods). */
  locale?: string,
): Promise<Record<string, RefOption[]>> {
  const out: Record<string, RefOption[]> = {};
  for (const source of refSources(entity)) {
    out[source] =
      source === "accounts"
        ? await loadAccounts(orgId, allowedSubsidiaryIds)
        : await loadEntityOptions(source, orgId, allowedSubsidiaryIds, locale);
  }
  return out;
}

/** ORDER BY expression for an entity's list query. */
export function orderExpr(entity: SetupEntity): string {
  if (entity.orderBy) return entity.orderBy;
  if (entity.naturalKey) return toSnake(entity.naturalKey);
  return entity.idColumn ?? "id";
}
